import { supabaseAdmin } from "@/lib/supabase";
import { config } from "@/lib/config";

export const dynamic = "force-dynamic";

const LEAD_REGISTERED_TOPIC =
  "0x60a39c3b9dad6336338265159dcb0fa7af4e07ac2176c3d20b5971c40ca65711";

function norm(addr: string): string | null {
  const a = addr.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return null;
  return a.toLowerCase();
}

function unique(addrs: string[]): string[] {
  return [...new Set(addrs.map((a) => a.toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/.test(a)))];
}

async function explorerLeadAddresses(): Promise<string[]> {
  const url =
    `https://coston2-explorer.flare.network/api?module=logs&action=getLogs` +
    `&fromBlock=0&toBlock=latest&address=${config.registry}` +
    `&topic0=${LEAD_REGISTERED_TOPIC}`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return [];
    const body = (await res.json()) as {
      result?: Array<{ topics?: string[] }>;
    };
    const out: string[] = [];
    for (const log of body.result ?? []) {
      const topic = log.topics?.[1];
      if (!topic || topic.length < 66) continue;
      out.push(`0x${topic.slice(-40)}`);
    }
    return unique(out);
  } catch {
    return [];
  }
}

async function supabaseLeadAddresses(): Promise<string[]> {
  const sb = supabaseAdmin();
  if (!sb) return [];
  const { data, error } = await sb.from("leads").select("address");
  if (error || !data) return [];
  return unique(data.map((r) => String(r.address ?? "")));
}

async function persistLeads(addresses: string[]): Promise<void> {
  const sb = supabaseAdmin();
  if (!sb || addresses.length === 0) return;
  await sb.from("leads").upsert(
    addresses.map((address) => ({ address })),
    { onConflict: "address" },
  );
}

export async function GET() {
  const [stored, onchain] = await Promise.all([supabaseLeadAddresses(), explorerLeadAddresses()]);
  const addresses = unique([...stored, ...onchain]);
  await persistLeads(addresses);
  return Response.json(
    { addresses, supabase: Boolean(supabaseAdmin()) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { address?: string };
  const address = typeof body.address === "string" ? norm(body.address) : null;
  if (!address) {
    return Response.json({ error: "invalid address" }, { status: 400 });
  }
  await persistLeads([address]);
  const addresses = unique([...(await supabaseLeadAddresses()), address]);
  return Response.json({ addresses, supabase: Boolean(supabaseAdmin()) });
}

export async function OPTIONS() {
  return new Response(null, { status: 204 });
}
