/**
 * Live SCORE_V1 canary against the AI-agent FCC stack (not matching-engine).
 *
 *   AI_AGENT_SENDER=0x... AI_EXT_PROXY_URL=https://... npm run ai:score-v1-tee
 */
import * as dotenv from "dotenv";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { getAddress, parseAbi, type Address, type Hex } from "viem";
import { clientsFromEnv } from "../relayer/fdc.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const AI_ENV = join(ROOT, "fce-ai-agent/.env");
dotenv.config({ path: AI_ENV });
dotenv.config({ path: join(ROOT, ".env") });
process.env.DEPLOYER_PRIVATE_KEY =
  process.env.DEPLOYER_PRIVATE_KEY ??
  process.env.DEPLOYMENT_PRIVATE_KEY ??
  process.env.PERSONA_DEPLOYER_PRIVATE_KEY;
process.env.FLARE_RPC_URL = process.env.FLARE_RPC_URL ?? process.env.CHAIN_URL;

const MATCHING_SENDER = "0xf082D53B50D08f0fdC06B0B4C6A1932DB589d91f";
const DIAMOND = "0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE" as Address;
const FEE = 1_000_000n;

const ABI = parseAbi([
  "function sendSayHello(bytes _message) payable returns (bytes32 instructionId)",
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

function loadAiSender(): Address {
  if (process.env.AI_AGENT_SENDER) return getAddress(process.env.AI_AGENT_SENDER);
  const ext = parseEnvFile(join(ROOT, "fce-ai-agent/config/extension.env"));
  if (ext.INSTRUCTION_SENDER) return getAddress(ext.INSTRUCTION_SENDER);
  throw new Error("Set AI_AGENT_SENDER");
}

function loadAiProxy(): string {
  const ai = parseEnvFile(AI_ENV);
  const url = (process.env.AI_EXT_PROXY_URL ?? ai.EXT_PROXY_URL ?? "").replace(/\/$/, "");
  if (!url) {
    throw new Error("Set AI_EXT_PROXY_URL (do not reuse matching EXT_PROXY_URL)");
  }
  return url;
}

async function fetchTeeResult(proxyUrl: string, instructionId: Hex) {
  const id = instructionId.startsWith("0x") ? instructionId : `0x${instructionId}`;
  const url = `${proxyUrl}/action/result/${id}`;
  for (let i = 0; i < 40; i++) {
    const res = await fetch(url);
    if (res.ok) {
      const body = (await res.json()) as any;
      const result = body.result ?? body.Result ?? body;
      const status = result.status ?? result.Status;
      const data = result.data ?? result.Data;
      if (status === 1) return { status, data, body };
      if (status === 0) throw new Error(`TEE status 0: ${result.log ?? result.Log ?? JSON.stringify(result)}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`timeout waiting for TEE result ${id}`);
}

function decodeData(data: unknown): any {
  if (data == null) return null;
  const raw = typeof data === "string" ? data : JSON.stringify(data);
  try {
    const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
    return JSON.parse(Buffer.from(hex, "hex").toString("utf8"));
  } catch {
    try {
      return JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    } catch {
      return raw;
    }
  }
}

/** FCC indexes extensionId as a small uint; instruction ids are 32-byte hashes. */
function instructionIdFromReceipt(receipt: { logs: readonly { address: string; topics: readonly Hex[]; data: Hex }[] }): Hex | null {
  for (const l of receipt.logs) {
    if (l.address.toLowerCase() !== DIAMOND.toLowerCase()) continue;
    for (const t of l.topics.slice(1)) {
      if (BigInt(t) > 1_000_000n) return t;
    }
    if (l.data.length >= 66) {
      const word = `0x${l.data.slice(2, 66)}` as Hex;
      if (BigInt(word) > 1_000_000n) return word;
    }
  }
  return null;
}

async function sendAndWait(
  label: string,
  hash: Hex,
  publicClient: ReturnType<typeof clientsFromEnv>["publicClient"],
  proxyUrl: string,
) {
  console.log(`${label} tx ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${label} reverted`);
  const instructionId = instructionIdFromReceipt(receipt);
  if (!instructionId) throw new Error(`${label}: no instruction id in diamond logs`);
  console.log(`${label} instruction ${instructionId}`);
  const tee = await fetchTeeResult(proxyUrl, instructionId);
  const decoded = decodeData(tee.data);
  console.log(`${label} status=${tee.status} result=${JSON.stringify(decoded)}`);
  return decoded;
}

async function main() {
  const sender = loadAiSender();
  if (sender.toLowerCase() === MATCHING_SENDER.toLowerCase()) {
    throw new Error("Refusing to canary matching-engine InstructionSender — set AI_AGENT_SENDER");
  }
  const proxyUrl = loadAiProxy();
  const { publicClient, wallet, account } = clientsFromEnv();

  const extId = (await publicClient.readContract({
    address: sender,
    abi: ABI,
    functionName: "extensionId",
  })) as bigint;
  if (extId === 0n) throw new Error("AiAgentSender.extensionId is 0 — run npm run ai:set-extension-id");
  if (extId === 66187n) throw new Error("sender is latched to matching ext 66187");
  console.log(`AiAgentSender ${sender} extensionId=${extId} (0x${extId.toString(16)})`);
  console.log(`AI proxy ${proxyUrl}`);
  console.log(`from ${account.address}`);

  const helloHash = await wallet.writeContract({
    address: sender,
    abi: ABI,
    functionName: "sendSayHello",
    args: [jsonToHex({ name: "Mirror" })],
    value: FEE,
    gas: 3_000_000n,
  });
  const hello = await sendAndWait("SAY_HELLO", helloHash as Hex, publicClient, proxyUrl);
  const greetingNumber = hello?.greetingNumber ?? hello?.GreetingNumber;
  if (typeof greetingNumber !== "number" || greetingNumber < 1) {
    throw new Error(`SAY_HELLO expected greetingNumber >= 1, got ${JSON.stringify(hello)}`);
  }

  const lead = (process.env.AI_SCORE_LEAD ?? "0x03182be182be76F11D1d136574190708844aE079") as Address;
  const scoreHash = await wallet.writeContract({
    address: sender,
    abi: ABI,
    functionName: "sendScoreV1",
    args: [jsonToHex({ lead, fixture: "momentum" })],
    value: FEE,
    gas: 3_000_000n,
  });
  const score = await sendAndWait("SCORE_V1", scoreHash as Hex, publicClient, proxyUrl);
  if (typeof score?.score !== "number") {
    throw new Error(`SCORE_V1 expected numeric score, got ${JSON.stringify(score)}`);
  }
  console.log(`OK SCORE_V1 score=${score.score} lead=${score.lead ?? lead}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
