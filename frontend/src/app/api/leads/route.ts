/**
 * Best-effort directory of newly registered leads so Discover can list them
 * without a 50k-block eth_getLogs (Coston2 public RPC max span is 30).
 */
const g = globalThis as typeof globalThis & { __mirrorLeads?: string[] };
if (!g.__mirrorLeads) g.__mirrorLeads = [];

function norm(addr: string): string | null {
  const a = addr.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return null;
  return a.toLowerCase();
}

export async function GET() {
  return Response.json(
    { addresses: g.__mirrorLeads ?? [] },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { address?: string };
  const address = typeof body.address === "string" ? norm(body.address) : null;
  if (!address) {
    return Response.json({ error: "invalid address" }, { status: 400 });
  }
  const next = [...(g.__mirrorLeads ?? [])];
  if (!next.includes(address)) next.push(address);
  g.__mirrorLeads = next.slice(-100);
  return Response.json({ addresses: g.__mirrorLeads });
}

export async function OPTIONS() {
  return new Response(null, { status: 204 });
}
