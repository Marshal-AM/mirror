import { matchingTeeProxyUrl } from "@/lib/fcc";
import { executeMatchFromSignalTx } from "@/lib/execute-match";
import type { Hex } from "viem";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { txHash?: string };
  const txHash = body.txHash;
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return Response.json({ ok: false, error: "txHash required" }, { status: 400 });
  }

  const proxyUrl = matchingTeeProxyUrl();
  const pk = (process.env.EXECUTE_MATCH_PRIVATE_KEY ||
    process.env.DEPLOYER_PRIVATE_KEY ||
    process.env.PERSONA_DEPLOYER_PRIVATE_KEY ||
    "") as Hex;
  if (!proxyUrl) {
    return Response.json(
      {
        ok: false,
        skipped: true,
        error: "MATCHING_TEE_PROXY_URL unset — signal is on-chain but fill was not run",
      },
      { status: 200 },
    );
  }
  if (!pk || pk.length < 66) {
    return Response.json(
      {
        ok: false,
        skipped: true,
        error: "EXECUTE_MATCH_PRIVATE_KEY unset — signal is on-chain but fill was not run",
      },
      { status: 200 },
    );
  }

  try {
    const result = await executeMatchFromSignalTx({
      txHash: txHash as Hex,
      proxyUrl,
      privateKey: pk.startsWith("0x") ? pk : (`0x${pk}` as Hex),
    });
    return Response.json({ ok: true, ...result });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
