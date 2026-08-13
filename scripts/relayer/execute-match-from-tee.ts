/**
 * After a live MATCH_V1 instruction, submit executeMatch against MockSparkDexRouter.
 *
 * SparkDEX V3 has no Coston2 bytecode — this is the working SparkDEX-shaped fill:
 * TEE decrypt/size → FTSO quote → InstructionSender.exactInputSingle on the mock.
 *
 *   # one-shot from a signal tx
 *   SIGNAL_TX=0x... npm run tee:execute-match -w scripts
 *
 *   # watch new Stage B txs (run on the FCC VM or any machine with DEPLOYER_PRIVATE_KEY)
 *   EXT_PROXY_URL=https://….trycloudflare.com npm run tee:execute-match -w scripts
 */
import * as dotenv from "dotenv";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  decodeFunctionData,
  getAddress,
  hexToBytes,
  hexToString,
  keccak256,
  parseAbi,
  slice,
  stringToBytes,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { clientsFromEnv, loadConfig } from "./fdc.ts";

const SENDER_ABI = parseAbi([
  "function swapRouter() view returns (address)",
  "function executeMatch((address follower, address lead, (address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) swap, uint256 profit, uint256 epochId) exec) returns (uint256 fillId, uint256 amountOut)",
]);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
dotenv.config({ path: join(ROOT, ".env") });

const SEND_SELECTOR = slice(keccak256(toHex(stringToBytes("sendMirrorMatchStageB(bytes)"))), 0, 4);
const DIAMOND = "0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE" as Address;

const VAULT_ABI = parseAbi([
  "function getBalance(address follower, address lead) view returns (uint256)",
  "function getPendingLocked(address follower, address lead) view returns (uint256)",
]);
const REGISTRY_ABI = parseAbi(["function getFollowers(address lead) view returns (address[])"]);
const EXACT_INPUT_ABI = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
]);

function decodeResultData(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null;
  const tryParse = (s: string) => {
    try {
      return JSON.parse(s) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  if (typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string") return null;
  if (raw.startsWith("{")) return tryParse(raw);
  if (raw.startsWith("0x")) {
    const asStr = tryParse(hexToString(raw as Hex));
    if (asStr) return asStr;
    try {
      return tryParse(new TextDecoder().decode(hexToBytes(raw as Hex)));
    } catch {
      return null;
    }
  }
  try {
    return tryParse(Buffer.from(raw, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

async function fetchTeeResult(proxyUrl: string, instructionId: Hex) {
  const base = proxyUrl.replace(/\/$/, "");
  const id = instructionId.startsWith("0x") ? instructionId : `0x${instructionId}`;
  const url = `${base}/action/result/${id}`;
  for (let i = 0; i < 30; i++) {
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

async function main() {
  const cfg = loadConfig();
  const { publicClient, wallet, account } = clientsFromEnv();
  const sender = getAddress(cfg.contracts.instructionSender) as Address;
  const vault = getAddress(cfg.contracts.mirrorVault) as Address;
  const registry = getAddress(cfg.contracts.mirrorRegistry) as Address;
  const fxrp = getAddress(cfg.tokens.fxrp) as Address;
  const usdt0 = getAddress(cfg.tokens.usdt0) as Address;
  const proxyUrl = (process.env.EXT_PROXY_URL ?? "").replace(/\/$/, "");
  if (!proxyUrl) throw new Error("Set EXT_PROXY_URL to the FCC tunnel (proxy /info URL origin)");

  const router = (await publicClient.readContract({
    address: sender,
    abi: SENDER_ABI,
    functionName: "swapRouter",
  })) as Address;
  if (router === "0x0000000000000000000000000000000000000000") {
    throw new Error("swapRouter unset — run npm run tee:wire-execution -w scripts first");
  }

  const processed = new Set<string>();

  async function handleSignalTx(txHash: Hex) {
    if (processed.has(txHash.toLowerCase())) return;
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") throw new Error(`signal tx reverted ${txHash}`);
    let instructionId: Hex | undefined;
    for (const l of receipt.logs) {
      if (l.address.toLowerCase() !== DIAMOND.toLowerCase()) continue;
      for (const t of l.topics.slice(1)) {
        if (BigInt(t) > 1_000_000n) {
          instructionId = t;
          break;
        }
      }
      if (!instructionId && l.data.length >= 66) {
        const word = `0x${l.data.slice(2, 66)}` as Hex;
        if (BigInt(word) > 1_000_000n) instructionId = word;
      }
      if (instructionId) break;
    }
    if (!instructionId) throw new Error(`no TeeInstructionsSent on ${txHash}`);
    const lead = getAddress(receipt.from);
    console.log(`instruction ${instructionId} from lead ${lead}`);

    const tee = await fetchTeeResult(proxyUrl, instructionId);
    const payload = decodeResultData(tee.data);
    console.log(`TEE MATCH_V1 ok venue=${payload?.venue ?? "?"} to=${payload?.to ?? "?"}`);

    let tokenIn = fxrp;
    let tokenOut = usdt0;
    let decodedAmount: bigint | null = null;
    const calldata = typeof payload?.data === "string" ? payload.data : "";
    if (calldata.startsWith("0x")) {
      try {
        const decoded = decodeFunctionData({ abi: EXACT_INPUT_ABI, data: calldata as Hex });
        const p = decoded.args?.[0] as {
          tokenIn: Address;
          tokenOut: Address;
          amountIn: bigint;
        };
        tokenIn = getAddress(p.tokenIn);
        tokenOut = getAddress(p.tokenOut);
        decodedAmount = p.amountIn;
      } catch {
        /* use FXRP sell default */
      }
    }

    const followers = (await publicClient.readContract({
      address: registry,
      abi: REGISTRY_ABI,
      functionName: "getFollowers",
      args: [lead],
    })) as Address[];
    const targets = followers.length > 0 ? followers : [lead];
    const sizeBps = BigInt(process.env.EXECUTE_SIZE_BPS ?? "1000"); // 10% of vault if TEE amount is unusable
    let fills = 0;

    for (const follower of targets) {
      const bal = (await publicClient.readContract({
        address: vault,
        abi: VAULT_ABI,
        functionName: "getBalance",
        args: [follower, lead],
      })) as bigint;
      const locked = (await publicClient.readContract({
        address: vault,
        abi: VAULT_ABI,
        functionName: "getPendingLocked",
        args: [follower, lead],
      })) as bigint;
      const available = bal > locked ? bal - locked : 0n;
      if (available === 0n) {
        console.log(`skip ${follower}: no vault FXRP`);
        continue;
      }

      // Vault is FXRP-only. Executable path is SELL FXRP → USDT0.
      let amountIn = (available * sizeBps) / 10_000n;
      if (decodedAmount && decodedAmount > 0n && decodedAmount <= available) amountIn = decodedAmount;
      if (amountIn === 0n) amountIn = available < 10_000n ? available : available / 10n;

      const quoted = amountIn; // mock fills at FTSO; 1% minOut slack applied in contract quote
      const minOut = 1n;
      const execHash = await wallet.writeContract({
        account,
        address: sender,
        abi: SENDER_ABI,
        functionName: "executeMatch",
        args: [
          {
            follower,
            lead,
            profit: 0n,
            epochId: BigInt(Math.floor(Date.now() / 1000)),
            swap: {
              tokenIn: fxrp,
              tokenOut: usdt0,
              fee: 500,
              recipient: sender,
              deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
              amountIn,
              amountOutMinimum: minOut,
              sqrtPriceLimitX96: 0n,
            },
          },
        ],
        gas: 2_000_000n,
      });
      const execReceipt = await publicClient.waitForTransactionReceipt({ hash: execHash });
      if (execReceipt.status !== "success") throw new Error(`executeMatch reverted ${execHash}`);
      console.log(`executeMatch follower=${follower} amountIn=${amountIn} tx=${execHash}`);
      fills++;
      void tokenIn;
      void tokenOut;
      void quoted;
    }
    if (fills === 0) throw new Error("no follower vault balance to swap — deposit FXRP then follow this lead");
    processed.add(txHash.toLowerCase());
    console.log(`OK: ${fills} SparkDEX-ABI fill(s) on MockSparkDexRouter`);
  }

  const oneShot = process.env.SIGNAL_TX as Hex | undefined;
  if (oneShot) {
    await handleSignalTx(oneShot);
    return;
  }

  console.log(`watching ${sender} for sendMirrorMatchStageB (executor ${account.address})`);
  let lastBlock = await publicClient.getBlockNumber();
  for (;;) {
    const head = await publicClient.getBlockNumber();
    if (head > lastBlock) {
      for (let b = lastBlock + 1n; b <= head; b++) {
        const block = await publicClient.getBlock({ blockNumber: b, includeTransactions: true });
        for (const tx of block.transactions) {
          if (typeof tx === "string") continue;
          if (tx.to?.toLowerCase() !== sender.toLowerCase()) continue;
          if (!tx.input?.startsWith(SEND_SELECTOR)) continue;
          try {
            await handleSignalTx(tx.hash);
          } catch (e) {
            console.error(`tx ${tx.hash}:`, e instanceof Error ? e.message : e);
          }
        }
      }
      lastBlock = head;
    }
    await new Promise((r) => setTimeout(r, 4000));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
