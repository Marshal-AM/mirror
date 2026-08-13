import { encryptPubKeyFromInfo, matchingTeeProxyUrl } from "@/lib/fcc";
import { isSecp256k1EncryptPubKey } from "@/lib/encrypt";

export const dynamic = "force-dynamic";

function envFallbackPubKey(): string {
  const k = process.env.NEXT_PUBLIC_TEE_ENCRYPT_PUBKEY ?? "";
  return isSecp256k1EncryptPubKey(k) ? k : "";
}

export async function GET() {
  const base = matchingTeeProxyUrl();
  if (!base) {
    const fallback = envFallbackPubKey();
    return Response.json(
      {
        ok: Boolean(fallback),
        error: fallback
          ? undefined
          : "MATCHING_TEE_PROXY_URL unset, and NEXT_PUBLIC_TEE_ENCRYPT_PUBKEY is missing or still RSA. Set MATCHING_TEE_PROXY_URL to the matching EXT_PROXY_URL, or paste the matching TEE 0x04||x||y hex into NEXT_PUBLIC_TEE_ENCRYPT_PUBKEY and Redeploy.",
        encryptPubKey: fallback,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    const res = await fetch(`${base}/info`, { cache: "no-store" });
    if (!res.ok) {
      const fallback = envFallbackPubKey();
      return Response.json(
        {
          ok: Boolean(fallback),
          error: `matching TEE /info HTTP ${res.status}`,
          proxy: base,
          encryptPubKey: fallback,
        },
        { status: fallback ? 200 : 502, headers: { "Cache-Control": "no-store" } },
      );
    }
    const info = (await res.json()) as Record<string, unknown>;
    const encryptPubKey = encryptPubKeyFromInfo(info);
    if (!encryptPubKey) {
      const fallback = envFallbackPubKey();
      return Response.json(
        {
          ok: Boolean(fallback),
          error: "matching /info has no secp256k1 publicKey.x/y",
          proxy: base,
          encryptPubKey: fallback,
        },
        { status: fallback ? 200 : 502, headers: { "Cache-Control": "no-store" } },
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
    const fallback = envFallbackPubKey();
    return Response.json(
      {
        ok: Boolean(fallback),
        error: e instanceof Error ? e.message : String(e),
        proxy: base,
        encryptPubKey: fallback,
      },
      { status: fallback ? 200 : 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}
