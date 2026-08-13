import { encryptPubKeyFromInfo, matchingTeeProxyUrl } from "@/lib/fcc";

export const dynamic = "force-dynamic";

export async function GET() {
  const base = matchingTeeProxyUrl();
  if (!base) {
    return Response.json(
      {
        ok: false,
        error:
          "MATCHING_TEE_PROXY_URL unset. On the VM: grep ^EXT_PROXY_URL= fce-matching-engine/.env",
        encryptPubKey: process.env.NEXT_PUBLIC_TEE_ENCRYPT_PUBKEY ?? "",
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    const res = await fetch(`${base}/info`, { cache: "no-store" });
    if (!res.ok) {
      return Response.json(
        { ok: false, error: `matching TEE /info HTTP ${res.status}`, proxy: base },
        { status: 502 },
      );
    }
    const info = (await res.json()) as Record<string, unknown>;
    const encryptPubKey = encryptPubKeyFromInfo(info);
    if (!encryptPubKey) {
      return Response.json(
        { ok: false, error: "matching /info has no secp256k1 publicKey.x/y", proxy: base },
        { status: 502 },
      );
    }
    const machine = (info.machineData ?? info.MachineData) as Record<string, unknown> | undefined;
    return Response.json(
      {
        ok: true,
        proxy: base,
        encryptPubKey,
        extensionId: machine?.extensionId ?? info.extensionId ?? info.ExtensionID ?? null,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (e) {
    return Response.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
        proxy: base,
      },
      { status: 502 },
    );
  }
}
