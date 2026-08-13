/**
 * Publish a live SCORE_V1 for one lead. Used by the VM fill-worker after executeMatch.
 *
 * Prefer AI TEE (localhost :6684). If the scoring FCE is down, use the same
 * in-repo rule formula and still call updateScore (otherwise Discover stays 0).
 *
 *   LEAD=0x... npm run ai:score-lead -w scripts
 */
import * as dotenv from "dotenv";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { getAddress, parseAbi, type Address, type Hex } from "viem";
import { scoreLead, type OutcomeEvent } from "../../fce-ai-agent/typescript/src/app/scoring.ts";
import { clientsFromEnv, loadConfig } from "../relayer/fdc.ts";
import { publishScore } from "./publish-scores.ts";
import { seedLeadFillsFromChain } from "../lib/fill-outcomes.ts";
import { loadLeadOutcomes, scoringEvents } from "../lib/outcome-store.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
dotenv.config({ path: join(ROOT, ".env") });
dotenv.config({ path: join(ROOT, "fce-matching-engine/.env") });
dotenv.config({ path: join(ROOT, "fce-ai-agent/.env") });
function nonemptyKey(name: string): string {
  const v = (process.env[name] ?? "").trim().replace(/^["']|["']$/g, "");
  return v.length >= 64 ? v : "";
}
process.env.DEPLOYER_PRIVATE_KEY =
  nonemptyKey("DEPLOYER_PRIVATE_KEY") ||
  nonemptyKey("DEPLOYMENT_PRIVATE_KEY") ||
  nonemptyKey("PERSONA_DEPLOYER_PRIVATE_KEY");
process.env.FLARE_RPC_URL = process.env.FLARE_RPC_URL ?? process.env.CHAIN_URL;

const FEE = 1_000_000n;
const AI_SENDER_DEFAULT = "0x18CA8047099C6a5ca241b25682a3629695435b42";
const SENDER_ABI = parseAbi([
  "function sendScoreV1(bytes payload) payable returns (bytes32 instructionId)",
  "function extensionId() view returns (uint256)",
]);

function parseEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

function jsonToHex(obj: unknown): Hex {
  return `0x${Buffer.from(JSON.stringify(obj), "utf8").toString("hex")}` as Hex;
}

function decodeData(data: unknown): Record<string, unknown> | null {
  if (data == null) return null;
  if (typeof data === "object") return data as Record<string, unknown>;
  if (typeof data !== "string") return null;
  try {
    const hex = data.startsWith("0x") ? data.slice(2) : data;
    return JSON.parse(Buffer.from(hex, "hex").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function aiProxyUrl(): string {
  const ai = parseEnvFile(join(ROOT, "fce-ai-agent/.env"));
  return (
    process.env.AI_TEE_PROXY_URL ||
    process.env.AI_EXT_PROXY_URL ||
    ai.EXT_PROXY_URL ||
    "http://127.0.0.1:6684"
  ).replace(/\/$/, "");
}

function aiSender(): Address {
  if (process.env.AI_AGENT_SENDER) return getAddress(process.env.AI_AGENT_SENDER);
  const ext = parseEnvFile(join(ROOT, "fce-ai-agent/config/extension.env"));
  if (ext.INSTRUCTION_SENDER) return getAddress(ext.INSTRUCTION_SENDER);
  return getAddress(AI_SENDER_DEFAULT);
}

async function proxyReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/info`, { signal: AbortSignal.timeout(4000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function fetchTeeResult(proxyUrl: string, instructionId: Hex) {
  const url = `${proxyUrl}/action/result/${instructionId}`;
  for (let i = 0; i < 40; i++) {
    const res = await fetch(url, { cache: "no-store" });
    if (res.ok) {
      const body = (await res.json()) as {
        result?: { status?: number; log?: string; data?: unknown };
      };
      const result = body.result ?? (body as { status?: number; log?: string; data?: unknown });
      if (result.status === 1) return result;
      if (result.status === 0) {
        throw new Error(`SCORE_V1 status 0: ${result.log ?? JSON.stringify(result)}`);
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`timeout waiting for SCORE_V1 ${instructionId}`);
}

export async function recordOutcomeHttp(event: OutcomeEvent & { txHash?: string }): Promise<void> {
  const base = (process.env.MIRROR_OUTCOME_LOG_URL ?? "").replace(/\/$/, "");
  if (!base) return;
  const token = process.env.TEE_INTERNAL_TOKEN ?? "mirror-coston2-tee-internal";
  const url = /\/api\/outcomes$/.test(base) ? base : `${base}/api/outcomes`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) console.error(`outcome log HTTP ${res.status}`);
  } catch (e) {
    console.error(`outcome log: ${e instanceof Error ? e.message : e}`);
  }
}

export async function publishLeadScore(opts: {
  lead: string;
  events: OutcomeEvent[];
}): Promise<{
  lead: Address;
  score: number;
  scoreTx: Hex;
  eventCount: number;
  via: "tee" | "local";
}> {
  const lead = getAddress(opts.lead);
  const events = opts.events.filter((e) => e.lead.toLowerCase() === lead.toLowerCase());
  if (events.length === 0) {
    throw new Error("no outcome events — SCORE_V1 will not write 0");
  }

  let score = scoreLead(events).aiScore;
  let via: "tee" | "local" = "local";
  let attestationId: Hex = `0x${"00".repeat(32)}`;

  const proxy = aiProxyUrl();
  if (await proxyReachable(proxy)) {
    try {
      const sender = aiSender();
      const { account, publicClient, wallet } = clientsFromEnv();
      const extId = (await publicClient.readContract({
        address: sender,
        abi: SENDER_ABI,
        functionName: "extensionId",
      })) as bigint;
      if (extId === 0n || extId === 66187n) {
        throw new Error(`AiAgentSender extensionId invalid (${extId})`);
      }
      const signalTx = await wallet.writeContract({
        account,
        address: sender,
        abi: SENDER_ABI,
        functionName: "sendScoreV1",
        args: [jsonToHex({ lead, events })],
        value: FEE,
        gas: 3_000_000n,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: signalTx });
      if (receipt.status !== "success") throw new Error(`sendScoreV1 reverted ${signalTx}`);
      const diamond = "0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE";
      let instructionId: Hex | null = null;
      for (const l of receipt.logs) {
        if (l.address.toLowerCase() !== diamond.toLowerCase()) continue;
        for (const t of l.topics.slice(1)) {
          if (BigInt(t) > 1_000_000n) {
            instructionId = t;
            break;
          }
        }
        if (instructionId) break;
      }
      if (!instructionId) throw new Error("no SCORE_V1 instruction id");
      const tee = await fetchTeeResult(proxy, instructionId);
      const decoded = decodeData(tee.data);
      const teeScore = Number(decoded?.score);
      const eventCount = Number(decoded?.eventCount ?? events.length);
      if (!Number.isFinite(teeScore) || teeScore < 0 || teeScore > 100) {
        throw new Error(`SCORE_V1 returned no score: ${JSON.stringify(decoded)}`);
      }
      if (eventCount === 0) throw new Error("SCORE_V1 eventCount 0");
      score = teeScore;
      via = "tee";
      if (typeof decoded?.attestationId === "string" && decoded.attestationId.startsWith("0x")) {
        attestationId = decoded.attestationId as Hex;
      } else {
        attestationId = instructionId;
      }
    } catch (e) {
      console.error(`SCORE_V1 TEE failed, using local formula: ${e instanceof Error ? e.message : e}`);
    }
  } else {
    console.log(`AI TEE unreachable at ${proxy} — publishing local rule score`);
  }

  const { hash } = await publishScore({ lead, score, attestationId });
  console.log(`updateScore lead=${lead} score=${score} via=${via} tx=${hash}`);
  return { lead, score, scoreTx: hash, eventCount: events.length, via };
}

async function main() {
  const lead = (process.env.LEAD ?? process.argv[2] ?? "").trim();
  if (!lead || !/^0x[0-9a-fA-F]{40}$/.test(lead)) {
    throw new Error("LEAD=0x… required");
  }
  let events: OutcomeEvent[] = [];
  if (process.env.SCORE_EVENTS) {
    events = JSON.parse(process.env.SCORE_EVENTS) as OutcomeEvent[];
  } else {
    const cfg = loadConfig();
    const { publicClient } = clientsFromEnv();
    await seedLeadFillsFromChain({
      publicClient,
      sender: getAddress(cfg.contracts.instructionSender),
      lead: getAddress(lead),
      router: getAddress(cfg.contracts.mockSparkDexRouter),
      priceReader: getAddress(cfg.contracts.ftsoPriceReader),
      fxrp: getAddress(cfg.tokens.fxrp),
    });
    events = scoringEvents(loadLeadOutcomes(lead));
  }
  if (events.length === 0) throw new Error("no on-chain fills / stored outcomes for this lead");
  for (const e of events.slice(-3)) await recordOutcomeHttp(e);
  const result = await publishLeadScore({ lead, events });
  console.log(JSON.stringify(result));
}

const isMain = process.argv[1]?.includes("score-lead");
if (isMain) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
