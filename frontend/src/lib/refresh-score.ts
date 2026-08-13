import { existsSync, readFileSync } from "fs";
import { join } from "path";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  getAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { defineChain } from "viem";
import { config, STRATEGY_LABELS } from "./config";
import { instructionIdFromReceipt } from "./fcc";

const AI_SENDER = (process.env.AI_AGENT_SENDER ||
  "0x18CA8047099C6a5ca241b25682a3629695435b42") as Address;
const FEE = 1_000_000n;

const SENDER_ABI = parseAbi([
  "function sendScoreV1(bytes payload) payable returns (bytes32 instructionId)",
  "function extensionId() view returns (uint256)",
]);
const REGISTRY_ABI = parseAbi([
  "function getLead(address wallet) view returns ((address wallet, uint8 strategyType, uint16 feeRateBps, uint256 minAllocation, bytes32 teePublicKeyHash, bool verified))",
]);
const LB_ABI = parseAbi([
  "function updateScore(address lead, uint8 score, bytes32 attestationId)",
]);

const coston2 = defineChain({
  id: 114,
  name: "Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl] } },
});

function loadSidecarEnv() {
  const roots = [process.cwd(), join(process.cwd(), "..")];
  for (const root of roots) {
    for (const rel of [".env", "fce-ai-agent/.env"]) {
      const p = join(root, rel);
      if (!existsSync(p)) continue;
      for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (!m || process.env[m[1]]) continue;
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  }
}

function aiEnvProxy(): string {
  for (const root of [process.cwd(), join(process.cwd(), "..")]) {
    const p = join(root, "fce-ai-agent/.env");
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^EXT_PROXY_URL=(.*)$/);
      if (m) return m[1].replace(/^["']|["']$/g, "").replace(/\/$/, "");
    }
  }
  return "";
}

export function aiTeeProxyUrl(): string {
  loadSidecarEnv();
  return (
    process.env.AI_TEE_PROXY_URL ||
    process.env.AI_EXT_PROXY_URL ||
    aiEnvProxy() ||
    ""
  ).replace(/\/$/, "");
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

function fixtureForStrategy(strategyType: number): "momentum" | "mean-reversion" {
  const label = STRATEGY_LABELS[strategyType] ?? "momentum";
  return label === "mean-reversion" ? "mean-reversion" : "momentum";
}

export async function refreshLeadScore(leadRaw: string): Promise<{
  lead: Address;
  score: number;
  scoreTx: Hex;
  instructionId: Hex;
  signalTx: Hex;
}> {
  loadSidecarEnv();
  const lead = getAddress(leadRaw);
  const proxyUrl = aiTeeProxyUrl();
  if (!proxyUrl) {
    throw new Error("AI_TEE_PROXY_URL unset — grep EXT_PROXY_URL in fce-ai-agent/.env on the VM");
  }

  const sendPk = (process.env.EXECUTE_MATCH_PRIVATE_KEY ||
    process.env.DEPLOYER_PRIVATE_KEY ||
    process.env.DEPLOYMENT_PRIVATE_KEY ||
    "") as Hex;
  const pubPk = (process.env.SCORE_PUBLISHER_PRIVATE_KEY ||
    process.env.PERSONA_AI_AGENT_SIGNER_PRIVATE_KEY ||
    "") as Hex;
  if (!sendPk || sendPk.length < 66) throw new Error("EXECUTE_MATCH_PRIVATE_KEY unset");
  if (!pubPk || pubPk.length < 66) throw new Error("SCORE_PUBLISHER_PRIVATE_KEY / PERSONA_AI_AGENT_SIGNER_PRIVATE_KEY unset");

  const sendAccount = privateKeyToAccount(sendPk.startsWith("0x") ? sendPk : (`0x${sendPk}` as Hex));
  const pubAccount = privateKeyToAccount(pubPk.startsWith("0x") ? pubPk : (`0x${pubPk}` as Hex));
  const publicClient = createPublicClient({ chain: coston2, transport: http(config.rpcUrl) });
  const sendWallet = createWalletClient({ account: sendAccount, chain: coston2, transport: http(config.rpcUrl) });
  const pubWallet = createWalletClient({ account: pubAccount, chain: coston2, transport: http(config.rpcUrl) });

  const extId = (await publicClient.readContract({
    address: getAddress(AI_SENDER),
    abi: SENDER_ABI,
    functionName: "extensionId",
  })) as bigint;
  if (extId === 0n || extId === 66187n) {
    throw new Error(`AiAgentSender extensionId invalid (${extId})`);
  }

  const leadInfo = await publicClient.readContract({
    address: config.registry,
    abi: REGISTRY_ABI,
    functionName: "getLead",
    args: [lead],
  });
  if (!leadInfo.wallet || leadInfo.wallet === "0x0000000000000000000000000000000000000000") {
    throw new Error("address is not a registered lead");
  }

  const fixture = fixtureForStrategy(Number(leadInfo.strategyType));
  const signalTx = await sendWallet.writeContract({
    address: getAddress(AI_SENDER),
    abi: SENDER_ABI,
    functionName: "sendScoreV1",
    args: [jsonToHex({ lead, fixture })],
    value: FEE,
    gas: 3_000_000n,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: signalTx });
  if (receipt.status !== "success") throw new Error(`sendScoreV1 reverted ${signalTx}`);
  const instructionId = instructionIdFromReceipt(receipt);
  if (!instructionId) throw new Error("no SCORE_V1 instruction id");

  const tee = await fetchTeeResult(proxyUrl, instructionId);
  const decoded = decodeData(tee.data);
  const score = Number(decoded?.score);
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    throw new Error(`SCORE_V1 returned no score: ${JSON.stringify(decoded)}`);
  }
  const attestationId = (
    typeof decoded?.attestationId === "string" && decoded.attestationId.startsWith("0x")
      ? decoded.attestationId
      : instructionId
  ) as Hex;

  const scoreTx = await pubWallet.writeContract({
    address: config.leaderboard,
    abi: LB_ABI,
    functionName: "updateScore",
    args: [lead, score, attestationId],
    gas: 500_000n,
  });
  const scoreReceipt = await publicClient.waitForTransactionReceipt({ hash: scoreTx });
  if (scoreReceipt.status !== "success") throw new Error(`updateScore reverted ${scoreTx}`);

  return { lead, score, scoreTx, instructionId, signalTx };
}
