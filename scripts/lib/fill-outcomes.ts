import {
  getAddress,
  parseAbi,
  parseAbiItem,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { combinedFillPnlBps } from "../../fce-ai-agent/typescript/src/app/fill-pnl.ts";
import {
  appendLeadOutcome,
  loadLeadOutcomes,
  scoringEvents,
  type StoredOutcome,
} from "./outcome-store.ts";

const MATCH_EVENT = parseAbiItem(
  "event MatchExecuted(uint256 indexed fillId, address follower, address lead, uint256 amountIn, uint256 amountOut)",
);
const MATCH_ABI = parseAbi([
  "event MatchExecuted(uint256 indexed fillId, address follower, address lead, uint256 amountIn, uint256 amountOut)",
]);
const QUOTE_ABI = parseAbi([
  "function quoteExactInput(address tokenIn, address tokenOut, uint256 amountIn) view returns (uint256 amountOut)",
]);
const PRICE_ABI = parseAbi([
  "function getFxrpUsdInWei() view returns (uint256 valueWei, uint64 timestamp)",
]);

export function matchFromReceipt(
  logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[],
  sender: Address,
  lead: Address,
): { amountIn: bigint; amountOut: bigint } | null {
  const parsed = parseEventLogs({ abi: MATCH_ABI, logs, strict: false });
  const hit = parsed.find(
    (e) =>
      e.eventName === "MatchExecuted" &&
      e.address.toLowerCase() === sender.toLowerCase() &&
      getAddress(e.args.lead as Address) === lead,
  );
  if (!hit || hit.args.amountIn == null || hit.args.amountOut == null) return null;
  return { amountIn: hit.args.amountIn, amountOut: hit.args.amountOut };
}

export async function fxrpUsdAt(
  publicClient: PublicClient,
  reader: Address,
  blockNumber?: bigint,
): Promise<bigint> {
  try {
    const [wei] = (await publicClient.readContract({
      address: reader,
      abi: PRICE_ABI,
      functionName: "getFxrpUsdInWei",
      ...(blockNumber != null ? { blockNumber } : {}),
    })) as [bigint, number];
    return wei;
  } catch {
    const [wei] = (await publicClient.readContract({
      address: reader,
      abi: PRICE_ABI,
      functionName: "getFxrpUsdInWei",
    })) as [bigint, number];
    return wei;
  }
}

export async function quoteAt(
  publicClient: PublicClient,
  router: Address,
  tokenIn: Address,
  tokenOut: Address,
  amountIn: bigint,
  blockNumber?: bigint,
): Promise<bigint> {
  return (await publicClient.readContract({
    address: router,
    abi: QUOTE_ABI,
    functionName: "quoteExactInput",
    args: [tokenIn, tokenOut, amountIn],
    ...(blockNumber != null ? { blockNumber } : {}),
  })) as bigint;
}

/** Backfill prior MatchExecuted for this lead so Sharpe has ≥2 real returns. */
export async function seedLeadFillsFromChain(opts: {
  publicClient: PublicClient;
  sender: Address;
  lead: Address;
  router: Address;
  priceReader: Address;
  fxrp: Address;
  skipTx?: Hex;
  lookbackBlocks?: bigint;
}): Promise<StoredOutcome[]> {
  const existing = loadLeadOutcomes(opts.lead);
  if (existing.length >= 2) return existing;
  const head = await opts.publicClient.getBlockNumber();
  const lookback = opts.lookbackBlocks ?? BigInt(process.env.FILL_LOOKBACK_BLOCKS ?? "2000");
  const from = head > lookback ? head - lookback : 0n;
  const chunk = 30n;
  const seen = new Set<string>();
  const fills: {
    txHash: Hex;
    blockNumber: bigint;
    timestamp: number;
    amountIn: bigint;
    amountOut: bigint;
  }[] = [];

  for (let start = from; start <= head; start += chunk) {
    const end = start + chunk - 1n > head ? head : start + chunk - 1n;
    const logs = await opts.publicClient.getLogs({
      address: opts.sender,
      event: MATCH_EVENT,
      fromBlock: start,
      toBlock: end,
    });
    for (const log of logs) {
      if (!log.args.lead || getAddress(log.args.lead) !== getAddress(opts.lead)) continue;
      const txHash = log.transactionHash;
      if (!txHash || seen.has(txHash.toLowerCase())) continue;
      if (opts.skipTx && txHash.toLowerCase() === opts.skipTx.toLowerCase()) continue;
      seen.add(txHash.toLowerCase());
      const block = await opts.publicClient.getBlock({ blockNumber: log.blockNumber });
      fills.push({
        txHash,
        blockNumber: log.blockNumber,
        timestamp: Number(block.timestamp),
        amountIn: log.args.amountIn ?? 0n,
        amountOut: log.args.amountOut ?? 0n,
      });
    }
  }

  fills.sort((a, b) => Number(a.blockNumber - b.blockNumber));
  let prevPrice: bigint | undefined;
  let history = loadLeadOutcomes(opts.lead);
  for (const fill of fills) {
    const price = await fxrpUsdAt(opts.publicClient, opts.priceReader, fill.blockNumber);
    const direction: "BUY" | "SELL" = "SELL";
    const pnlBps = combinedFillPnlBps({
      amountOut: fill.amountOut,
      quotedOut: fill.amountOut,
      direction,
      prevPriceWei: prevPrice,
      nowPriceWei: price,
    });
    history = appendLeadOutcome(opts.lead, {
      lead: getAddress(opts.lead),
      timestamp: fill.timestamp,
      pnlBps,
      direction,
      sizePct: 0,
      txHash: fill.txHash,
      fxrpUsdWei: price.toString(),
      amountIn: fill.amountIn.toString(),
      amountOut: fill.amountOut.toString(),
      quotedOut: fill.amountOut.toString(),
    });
    prevPrice = price;
  }
  void opts.router;
  void opts.fxrp;
  return history;
}

export async function recordFillOutcome(opts: {
  publicClient: PublicClient;
  sender: Address;
  router: Address;
  priceReader: Address;
  lead: Address;
  fxrp: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  execReceipt: { blockNumber: bigint; logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[]; transactionHash: Hex };
  sizePct: number;
}): Promise<StoredOutcome[]> {
  const match = matchFromReceipt(opts.execReceipt.logs, opts.sender, opts.lead);
  const amountOut = match?.amountOut ?? 0n;
  const amountIn = match?.amountIn ?? opts.amountIn;
  const blockNumber = opts.execReceipt.blockNumber;
  const quotedOut = await quoteAt(
    opts.publicClient,
    opts.router,
    opts.tokenIn,
    opts.tokenOut,
    amountIn,
    blockNumber,
  ).catch(() => amountOut);
  const nowPrice = await fxrpUsdAt(opts.publicClient, opts.priceReader, blockNumber);
  const direction: "BUY" | "SELL" = opts.tokenIn.toLowerCase() === opts.fxrp.toLowerCase() ? "SELL" : "BUY";
  const block = await opts.publicClient.getBlock({ blockNumber });

  await seedLeadFillsFromChain({
    publicClient: opts.publicClient,
    sender: opts.sender,
    lead: opts.lead,
    router: opts.router,
    priceReader: opts.priceReader,
    fxrp: opts.fxrp,
    skipTx: opts.execReceipt.transactionHash,
  });

  const prev = loadLeadOutcomes(opts.lead).at(-1);
  const pnlBps = combinedFillPnlBps({
    amountOut,
    quotedOut,
    direction: (prev?.direction as "BUY" | "SELL" | undefined) ?? direction,
    prevPriceWei: prev?.fxrpUsdWei ? BigInt(prev.fxrpUsdWei) : undefined,
    nowPriceWei: nowPrice,
  });
  const next = appendLeadOutcome(opts.lead, {
    lead: getAddress(opts.lead),
    timestamp: Number(block.timestamp),
    pnlBps,
    direction,
    sizePct: opts.sizePct,
    txHash: opts.execReceipt.transactionHash,
    fxrpUsdWei: nowPrice.toString(),
    amountIn: amountIn.toString(),
    amountOut: amountOut.toString(),
    quotedOut: quotedOut.toString(),
  });
  console.log(
    `outcome pnlBps=${pnlBps} events=${next.length} amountIn=${amountIn} amountOut=${amountOut} quoted=${quotedOut} fxrpUsd=${nowPrice}`,
  );
  return next;
}

export { scoringEvents };
