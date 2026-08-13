import { describe, expect, it } from "vitest";
import { combinedFillPnlBps, executionPnlBps, markToMarketPnlBps } from "../app/fill-pnl.js";

describe("executionPnlBps", () => {
  it("is 0 when fill matches the FTSO quote", () => {
    expect(executionPnlBps(1_000_000n, 1_000_000n)).toBe(0);
  });

  it("is +100 when amountOut is 1% above quote", () => {
    expect(executionPnlBps(101n, 100n)).toBe(100);
  });

  it("is -50 when amountOut is 0.5% below quote", () => {
    expect(executionPnlBps(199n, 200n)).toBe(-50);
  });
});

describe("markToMarketPnlBps", () => {
  const p0 = 2_000_000_000_000_000_000n; // $2
  const pDown = 1_980_000_000_000_000_000n; // -1%
  const pUp = 2_040_000_000_000_000_000n; // +2%

  it("SELL profits when FXRP falls", () => {
    expect(markToMarketPnlBps({ direction: "SELL", prevPriceWei: p0, nowPriceWei: pDown })).toBe(100);
  });

  it("SELL loses when FXRP rises", () => {
    expect(markToMarketPnlBps({ direction: "SELL", prevPriceWei: p0, nowPriceWei: pUp })).toBe(-200);
  });

  it("BUY profits when FXRP rises", () => {
    expect(markToMarketPnlBps({ direction: "BUY", prevPriceWei: p0, nowPriceWei: pUp })).toBe(200);
  });
});

describe("combinedFillPnlBps", () => {
  it("uses execution only when there is no prior mark", () => {
    expect(
      combinedFillPnlBps({
        amountOut: 101n,
        quotedOut: 100n,
        direction: "SELL",
        nowPriceWei: 1n,
      }),
    ).toBe(100);
  });

  it("adds interval MTM to execution", () => {
    expect(
      combinedFillPnlBps({
        amountOut: 100n,
        quotedOut: 100n,
        direction: "SELL",
        prevPriceWei: 100n,
        nowPriceWei: 99n,
      }),
    ).toBe(100);
  });
});
