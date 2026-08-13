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

/** On-chain fills after a Stage B signal. One-shot RPC — Hobby-safe. */
export async function fillsAfterSignalTx(txHash: Hex): Promise<{
  pending: boolean;
  lead: Address;
  fills: number;
  txs: Hex[];
}> {
  const publicClient = createPublicClient({
    chain: coston2,
    transport: http(config.rpcUrl, { timeout: 8_000 }),
  });
  const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
  if (!receipt) throw new Error(`signal tx not found ${txHash}`);
  if (receipt.status !== "success") throw new Error(`signal tx reverted ${txHash}`);
  const lead = getAddress(receipt.from);
  const head = await publicClient.getBlockNumber();
  const fromBlock = receipt.blockNumber;
  const toBlock = head > fromBlock + 300n ? fromBlock + 300n : head;
  const logs = await publicClient.getLogs({
    address: getAddress(config.instructionSender),
    event: MATCH_EXECUTED,
    fromBlock,
    toBlock,
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
