/**
 * Latch AiAgentSender.setExtensionId() on the NEW sender only.
 * Refuses matching-engine InstructionSender 0xf082…
 *
 *   AI_AGENT_SENDER=0x... npm run ai:set-extension-id
 */
import * as dotenv from "dotenv";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { getAddress, parseAbi, type Address, type Hex } from "viem";
import { clientsFromEnv } from "../relayer/fdc.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
dotenv.config({ path: join(ROOT, "fce-ai-agent/.env") });
dotenv.config({ path: join(ROOT, ".env") });
process.env.DEPLOYER_PRIVATE_KEY =
  process.env.DEPLOYER_PRIVATE_KEY ??
  process.env.DEPLOYMENT_PRIVATE_KEY ??
  process.env.PERSONA_DEPLOYER_PRIVATE_KEY;
process.env.FLARE_RPC_URL = process.env.FLARE_RPC_URL ?? process.env.CHAIN_URL;

const MATCHING_SENDER = "0xf082D53B50D08f0fdC06B0B4C6A1932DB589d91f";
const MATCHING_EXT = 66187n;

const ABI = parseAbi([
  "function setExtensionId()",
  "function extensionId() view returns (uint256)",
]);

function loadAiSender(): Address {
  if (process.env.AI_AGENT_SENDER) return getAddress(process.env.AI_AGENT_SENDER);
  const envPath = join(ROOT, "fce-ai-agent/config/extension.env");
  if (existsSync(envPath)) {
    const text = readFileSync(envPath, "utf8");
    const m = text.match(/^INSTRUCTION_SENDER=(0x[0-9a-fA-F]{40})\s*$/m);
    if (m) return getAddress(m[1]);
  }
  throw new Error("Set AI_AGENT_SENDER or run fce-ai-agent/scripts/pre-register.sh first");
}

async function main() {
  const sender = loadAiSender();
  if (sender.toLowerCase() === MATCHING_SENDER.toLowerCase()) {
    throw new Error("Refusing setExtensionId on matching-engine InstructionSender 0xf082…");
  }

  const { publicClient, wallet } = clientsFromEnv();
  const current = (await publicClient.readContract({
    address: sender,
    abi: ABI,
    functionName: "extensionId",
  })) as bigint;
  if (current !== 0n) {
    if (current === MATCHING_EXT) {
      throw new Error(`AiAgentSender already latched to matching ext ${current} — this is wrong`);
    }
    console.log(`extensionId already set: ${current} (0x${current.toString(16)})`);
    return;
  }

  const hash = await wallet.writeContract({
    address: sender,
    abi: ABI,
    functionName: "setExtensionId",
    gas: 8_000_000n,
  });
  console.log(`setExtensionId tx ${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: hash as Hex });
  if (receipt.status !== "success") throw new Error("setExtensionId reverted");

  const id = (await publicClient.readContract({
    address: sender,
    abi: ABI,
    functionName: "extensionId",
  })) as bigint;
  if (id === 0n) throw new Error("extensionId still 0 after set");
  if (id === MATCHING_EXT) throw new Error("latched matching extension 66187 — abort");
  console.log(`AI_EXTENSION_ID=${id} (0x${id.toString(16)})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
