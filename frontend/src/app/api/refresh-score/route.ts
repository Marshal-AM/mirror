import { createPublicClient, http, getAddress } from "viem";
import { config } from "@/lib/config";
import { leaderboardAbi } from "@/lib/abis";

export const dynamic = "force-dynamic";
export const maxDuration = 10;

/**
 * Read on-chain score only. SCORE_V1 + updateScore run on the FCC VM after a fill.
 * Vercel Hobby cannot wait on the AI TEE.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { lead?: string };
  const lead = body.lead?.trim();
  if (!lead || !/^0x[0-9a-fA-F]{40}$/.test(lead)) {
    return Response.json({ ok: false, error: "lead address required" }, { status: 400 });
  }
  try {
    const client = createPublicClient({
      transport: http(config.rpcUrl),
    });
    const s = await client.readContract({
      address: config.leaderboard,
      abi: leaderboardAbi,
      functionName: "getScore",
      args: [getAddress(lead)],
    });
    return Response.json({
      ok: true,
      lead: getAddress(lead),
      score: Number(s.score),
      skipped: true,
      eventCount: 0,
    });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
