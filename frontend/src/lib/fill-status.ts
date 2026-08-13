import {
  createPublicClient,
  http,
  parseAbiItem,
  getAddress,
  type Address,
  type Hex,
} from "viem";
import { defineChain } from "viem";
import { config } from "./config";

const coston2 = defineChain({
  id: 114,
  name: "Coston2",
  nativeCurrency: { name: "Coston2 Flare", symbol: "C2FLR", decimals: 18 },
  rpcUrls: { default: { http: [config.rpcUrl] } },
});

const MATCH_EXECUTED = parseAbiItem(
  "event MatchExecuted(uint256 indexed fillId, address follower, address lead, uint256 amountIn, uint256 amountOut)",
);

/** On-chain fills after a Stage B signal. RPC-only — safe for Vercel Hobby. */
export async function fillsAfterSignalTx(txHash: Hex): Promise<{
  pending: boolean;
  lead: Address;
  fills: number;
  txs: Hex[];
}> {
  const publicClient = createPublicClient({ chain: coston2, transport: http(config.rpcUrl) });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 20_000 });
  if (receipt.status !== "success") throw new Error(`signal tx reverted ${txHash}`);
  const lead = getAddress(receipt.from);
  const logs = await publicClient.getLogs({
    address: getAddress(config.instructionSender),
    event: MATCH_EXECUTED,
    fromBlock: receipt.blockNumber,
    toBlock: "latest",
  });
  const txs: Hex[] = [];
  const seen = new Set<string>();
  for (const e of logs) {
    const eventLead = e.args.lead;
    const hash = e.transactionHash;
    if (!eventLead || !hash) continue;
    if (getAddress(eventLead) !== lead) continue;
    if (seen.has(hash)) continue;
    seen.add(hash);
    txs.push(hash);
  }
  return { pending: txs.length === 0, lead, fills: txs.length, txs };
}
