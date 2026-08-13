import { fillsAfterSignalTx } from "@/lib/fill-status";
import type { Hex } from "viem";

export const dynamic = "force-dynamic";
export const maxDuration = 10;

/**
 * Cheap status poll. Fill is done by the VM worker; this only reads MatchExecuted.
 * Do not call TEE / score APIs here — Hobby kills the function at ~10s.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { txHash?: string };
  const txHash = body.txHash;
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return Response.json({ ok: false, error: "txHash required" }, { status: 400 });
  }

  try {
    const result = await fillsAfterSignalTx(txHash as Hex);
    return Response.json({
      ok: true,
      pending: result.pending,
      fills: result.fills,
      txs: result.txs,
      lead: result.lead,
    });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
