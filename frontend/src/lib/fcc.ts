import type { Hex } from "viem";

export const FLARE_TEE_MANAGER = "0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE" as const;

export function matchingTeeProxyUrl(): string {
  return (
    process.env.MATCHING_TEE_PROXY_URL ||
    process.env.EXT_PROXY_URL ||
    ""
  ).replace(/\/$/, "");
}

/** FCC indexes extensionId as a small uint; instruction ids are 32-byte hashes. */
export function instructionIdFromReceipt(receipt: {
  logs: readonly { address: string; topics: readonly Hex[]; data: Hex }[];
}): Hex | null {
  for (const l of receipt.logs) {
    if (l.address.toLowerCase() !== FLARE_TEE_MANAGER.toLowerCase()) continue;
    for (const t of l.topics.slice(1)) {
      if (BigInt(t) > 1_000_000n) return t;
    }
    if (l.data.length >= 66) {
      const word = `0x${l.data.slice(2, 66)}` as Hex;
      if (BigInt(word) > 1_000_000n) return word;
    }
  }
  return null;
}

function pad32(hex: string): string {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  return h.padStart(64, "0");
}

type Xy = { x?: string; y?: string; X?: string; Y?: string };

function xyToUncompressed(pk: Xy | string | undefined): string | null {
  if (typeof pk === "string" && pk.startsWith("0x") && (pk.length === 130 || pk.length === 132)) {
    return pk.length === 130 ? pk : `0x04${pk.slice(2)}`;
  }
  if (pk && typeof pk === "object") {
    const x = pk.x ?? pk.X;
    const y = pk.y ?? pk.Y;
    if (typeof x === "string" && typeof y === "string") {
      return `0x04${pad32(x)}${pad32(y)}`;
    }
  }
  return null;
}

/** Build 0x04||x||y from FCC proxy /info JSON. */
export function encryptPubKeyFromInfo(info: Record<string, unknown>): string | null {
  const nested = [info, info.teeInfo, info.machineData, info.TeeInfo, info.MachineData];
  for (const node of nested) {
    if (!node || typeof node !== "object") continue;
    const rec = node as Record<string, unknown>;
    const found = xyToUncompressed(
      (rec.publicKey ?? rec.PublicKey ?? rec.encryptionPublicKey) as Xy | string | undefined,
    );
    if (found) return found;
  }
  return null;
}
