import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

function normLead(lead: string | null): string | null {
  if (!lead || !/^0x[0-9a-fA-F]{40}$/.test(lead.trim())) return null;
  return lead.trim().toLowerCase();
}

function authorized(req: Request): boolean {
  const token = process.env.TEE_INTERNAL_TOKEN ?? "mirror-coston2-tee-internal";
  const auth = req.headers.get("authorization") ?? "";
  return auth === `Bearer ${token}`;
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const lead = normLead(new URL(req.url).searchParams.get("lead"));
  const sb = supabaseAdmin();
  if (!sb) {
    return Response.json({ events: [] }, { headers: { "Cache-Control": "no-store" } });
  }
  let q = sb.from("outcomes").select("lead, timestamp, pnl_bps, direction, size_pct").order("timestamp", { ascending: true });
  if (lead) q = q.eq("lead", lead);
  const { data, error } = await q.limit(10_000);
  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  const events = (data ?? []).map((r) => ({
    lead: r.lead,
    timestamp: Number(r.timestamp),
    pnlBps: Number(r.pnl_bps),
    direction: r.direction === "BUY" ? "BUY" : "SELL",
    sizePct: Number(r.size_pct ?? 0),
  }));
  return Response.json({ events }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  if (!authorized(req)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    lead?: string;
    timestamp?: number;
    pnlBps?: number;
    direction?: string;
    sizePct?: number;
    txHash?: string;
  };
  const lead = normLead(body.lead ?? null);
  if (!lead) {
    return Response.json({ error: "lead required" }, { status: 400 });
  }
  const sb = supabaseAdmin();
  if (!sb) {
    return Response.json({ error: "supabase unset" }, { status: 503 });
  }
  const row = {
    lead,
    timestamp: body.timestamp ?? Math.floor(Date.now() / 1000),
    pnl_bps: Number.isFinite(body.pnlBps) ? Math.trunc(body.pnlBps as number) : 0,
    direction: body.direction === "BUY" ? "BUY" : "SELL",
    size_pct: Number.isFinite(body.sizePct) ? Math.trunc(body.sizePct as number) : 0,
    tx_hash: body.txHash ?? null,
  };
  const { error } = await sb.from("outcomes").insert(row);
  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  return Response.json({ ok: true });
}
