/**
 * Real fill PnL for SCORE_V1 — not fixtures.
 *
 * - Execution: amountOut vs the FTSO quote at the fill block.
 * - Interval: FXRP USD mark-to-market since the previous fill, signed by that
 *   fill's direction (SELL profits when FXRP falls).
 */

export function executionPnlBps(amountOut: bigint, quotedOut: bigint): number {
  if (quotedOut === 0n) return 0;
  return Number((amountOut - quotedOut) * 10_000n / quotedOut);
}

export function markToMarketPnlBps(opts: {
  direction: "BUY" | "SELL";
  prevPriceWei: bigint;
  nowPriceWei: bigint;
}): number {
  if (opts.prevPriceWei === 0n) return 0;
  const delta = opts.nowPriceWei - opts.prevPriceWei;
  const signed = opts.direction === "SELL" ? -delta : delta;
  return Number((signed * 10_000n) / opts.prevPriceWei);
}

export function combinedFillPnlBps(opts: {
  amountOut: bigint;
  quotedOut: bigint;
  direction: "BUY" | "SELL";
  prevPriceWei?: bigint;
  nowPriceWei: bigint;
}): number {
  const exec = executionPnlBps(opts.amountOut, opts.quotedOut);
  if (opts.prevPriceWei == null || opts.prevPriceWei === 0n) return exec;
  return exec + markToMarketPnlBps({
    direction: opts.direction,
    prevPriceWei: opts.prevPriceWei,
    nowPriceWei: opts.nowPriceWei,
  });
}
