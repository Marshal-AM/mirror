import { refreshLeadScore } from "@/lib/refresh-score";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { lead?: string };
  const lead = body.lead?.trim();
  if (!lead || !/^0x[0-9a-fA-F]{40}$/.test(lead)) {
    return Response.json({ ok: false, error: "lead address required" }, { status: 400 });
  }
  try {
    const result = await refreshLeadScore(lead);
    return Response.json({ ok: true, ...result });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
