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
import { config } from "./config";
import { instructionIdFromReceipt } from "./fcc";

const coston2 = defineChain({
  id: 114,
  name: "Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl] } },
});

const SENDER_ABI = parseAbi([
  "function swapRouter() view returns (address)",
  "function executeMatch((address follower, address lead, (address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) swap, uint256 profit, uint256 epochId) exec) returns (uint256 fillId, uint256 amountOut)",
]);
const VAULT_ABI = parseAbi([
  "function getBalance(address follower, address lead) view returns (uint256)",
  "function getPendingLocked(address follower, address lead) view returns (uint256)",
]);
const REGISTRY_ABI = parseAbi(["function getFollowers(address lead) view returns (address[])"]);

const USDT0 = "0xC1A5B41512496B80903D1f32d6dEa3a73212E71F" as Address;

async function fetchTeeResult(proxyUrl: string, instructionId: Hex) {
  const id = instructionId.startsWith("0x") ? instructionId : `0x${instructionId}`;
  const url = `${proxyUrl.replace(/\/$/, "")}/action/result/${id}`;
  for (let i = 0; i < 25; i++) {
    const res = await fetch(url, { cache: "no-store" });
    if (res.ok) {
      const body = (await res.json()) as {
        result?: { status?: number; Status?: number; data?: unknown; Data?: unknown; log?: string };
        Result?: { status?: number };
      };
      const result = body.result ?? body.Result ?? (body as { status?: number; data?: unknown });
      const status = result.status ?? result.Status;
      const data = "data" in result ? result.data : (result as { Data?: unknown }).Data;
      if (status === 1) return { status, data };
      if (status === 0) {
        throw new Error(`TEE status 0: ${JSON.stringify(result)}`);
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`timeout waiting for TEE result ${id}`);
}

export async function executeMatchFromSignalTx(opts: {
  txHash: Hex;
  proxyUrl: string;
  privateKey: Hex;
}): Promise<{ fills: number; instructionId: Hex; txs: Hex[] }> {
  const account = privateKeyToAccount(opts.privateKey);
  const publicClient = createPublicClient({ chain: coston2, transport: http(config.rpcUrl) });
  const wallet = createWalletClient({ account, chain: coston2, transport: http(config.rpcUrl) });
  const sender = getAddress(config.instructionSender);
  const vault = getAddress(config.vault);
  const registry = getAddress(config.registry);
  const fxrp = getAddress(config.fxrp);

  const router = (await publicClient.readContract({
    address: sender,
    abi: SENDER_ABI,
    functionName: "swapRouter",
  })) as Address;
  if (router === "0x0000000000000000000000000000000000000000") {
    throw new Error("swapRouter unset — run npm run tee:wire-execution");
  }

  const receipt = await publicClient.waitForTransactionReceipt({ hash: opts.txHash });
  if (receipt.status !== "success") throw new Error(`signal tx reverted ${opts.txHash}`);
  const instructionId = instructionIdFromReceipt(receipt);
  if (!instructionId) throw new Error("no FCC instruction id in signal receipt");
  const lead = getAddress(receipt.from);

  await fetchTeeResult(opts.proxyUrl, instructionId);

  const followers = (await publicClient.readContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: "getFollowers",
    args: [lead],
  })) as Address[];
  const targets = followers.length > 0 ? followers : [];
  if (targets.length === 0) {
    throw new Error("no followers for this lead — deposit FXRP and follow before signaling");
  }

  const sizeBps = BigInt(process.env.EXECUTE_SIZE_BPS ?? "1000");
  const txs: Hex[] = [];

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
    if (available === 0n) continue;

    let amountIn = (available * sizeBps) / 10_000n;
    if (amountIn === 0n) amountIn = available < 10_000n ? available : available / 10n;

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
            tokenOut: USDT0,
            fee: 500,
            recipient: sender,
            deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
            amountIn,
            amountOutMinimum: 1n,
            sqrtPriceLimitX96: 0n,
          },
        },
      ],
      gas: 2_000_000n,
    });
    const execReceipt = await publicClient.waitForTransactionReceipt({ hash: execHash });
    if (execReceipt.status !== "success") throw new Error(`executeMatch reverted ${execHash}`);
    txs.push(execHash);
  }

  if (txs.length === 0) {
    throw new Error("followers have no vault FXRP to sell");
  }
  return { fills: txs.length, instructionId, txs };
}
