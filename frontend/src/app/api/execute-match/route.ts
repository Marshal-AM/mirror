import { fillsAfterSignalTx } from "@/lib/fill-status";
import { recordLeadOutcome } from "@/lib/outcomes";
import { refreshLeadScore } from "@/lib/refresh-score";
import type { Hex } from "viem";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * Production fill does NOT run on Vercel (Hobby cannot reach the TEE tunnel).
 * The FCC VM fill-worker watches Stage B and calls executeMatch.
 * This route only reads MatchExecuted logs.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { txHash?: string };
  const txHash = body.txHash;
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return Response.json({ ok: false, error: "txHash required" }, { status: 400 });
  }

  try {
    const result = await fillsAfterSignalTx(txHash as Hex);
    if (result.fills === 0) {
      return Response.json({
        ok: true,
        pending: true,
        fills: 0,
        txs: [],
        lead: result.lead,
      });
    }

    const sizePct = Number(process.env.EXECUTE_SIZE_BPS ?? "1000");
    for (const fillTx of result.txs) {
      await recordLeadOutcome({
        lead: result.lead,
        direction: "SELL",
        sizePct,
        txHash: fillTx,
      }).catch(() => undefined);
    }
    let score: number | undefined;
    let eventCount: number | undefined;
    let scoreError: string | undefined;
    try {
      const scored = await refreshLeadScore(result.lead);
      score = scored.score;
      eventCount = scored.eventCount;
    } catch (e) {
      scoreError = e instanceof Error ? e.message : String(e);
    }
    return Response.json({
      ok: true,
      ...result,
      pending: false,
      score,
      eventCount,
      scoreError,
    });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
