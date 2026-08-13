import { supabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export type MirrorAlert = {
  type: "drift" | "liquidation_risk" | "topup_executed" | "info";
  lead?: string;
  follower?: string;
  message: string;
  meta?: Record<string, unknown>;
  at: string;
};

function fromRow(row: Record<string, unknown>): MirrorAlert {
  return {
    type: (row.type as MirrorAlert["type"]) ?? "info",
    lead: typeof row.lead === "string" ? row.lead : undefined,
    follower: typeof row.follower === "string" ? row.follower : undefined,
    message: typeof row.message === "string" ? row.message : "",
    meta: (row.meta as Record<string, unknown> | undefined) ?? undefined,
    at: typeof row.at === "string" ? row.at : new Date().toISOString(),
  };
}

export async function GET() {
  const sb = supabaseAdmin();
  if (!sb) {
    return Response.json([], { headers: { "Cache-Control": "no-store" } });
  }
  const { data, error } = await sb.from("alerts").select("*").order("at", { ascending: false }).limit(50);
  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  return Response.json((data ?? []).map((r) => fromRow(r as Record<string, unknown>)).reverse(), {
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Partial<MirrorAlert>;
  const alert: MirrorAlert = {
    type: body.type ?? "info",
    lead: body.lead,
    follower: body.follower,
    message: body.message ?? "",
    meta: body.meta,
    at: body.at ?? new Date().toISOString(),
  };
  const sb = supabaseAdmin();
  if (!sb) {
    return Response.json(
      { ...alert, error: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY unset" },
      { status: 503 },
    );
  }
  const { error } = await sb.from("alerts").insert({
    type: alert.type,
    lead: alert.lead ?? null,
    follower: alert.follower ?? null,
    message: alert.message,
    meta: alert.meta ?? null,
    at: alert.at,
  });
  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  return Response.json(alert);
}

export async function OPTIONS() {
  return new Response(null, { status: 204 });
}
