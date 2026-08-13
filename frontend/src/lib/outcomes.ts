import { supabaseAdmin } from "./supabase";

export async function recordLeadOutcome(opts: {
  lead: string;
  pnlBps?: number;
  direction?: "BUY" | "SELL";
  sizePct?: number;
  txHash?: string;
}): Promise<void> {
  const sb = supabaseAdmin();
  if (!sb) return;
  const lead = opts.lead.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(lead)) return;
  await sb.from("outcomes").insert({
    lead,
    timestamp: Math.floor(Date.now() / 1000),
    pnl_bps: opts.pnlBps ?? 0,
    direction: opts.direction ?? "SELL",
    size_pct: opts.sizePct ?? 0,
    tx_hash: opts.txHash ?? null,
  });
}
