/**
 * Client-side ECIES encryption of the signal payload for FCC tee-node /decrypt.
 * Matches go-ethereum crypto/ecies (AES-128-CTR, SHA-256, HMAC-SHA256).
 *
 * NEXT_PUBLIC_TEE_ENCRYPT_PUBKEY must be the TEE uncompressed secp256k1 key
 * from proxy /info: 0x04 || publicKey.x || publicKey.y (65 bytes hex).
 */
import { secp256k1 } from "@noble/curves/secp256k1";

export type SignalPayload = {
  asset: string;
  direction: "BUY" | "SELL";
  sizePct: number;
  nonce: string;
  recipient: string;
  lead?: string;
};

/** FCC TeePayments / sendInstructions fee used by the scaffold (1e6 wei). */
export const FCC_INSTRUCTION_FEE_WEI = 1_000_000n;

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) throw new Error("TEE encrypt public key: odd hex length");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): `0x${string}` {
  return `0x${Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}`;
}

/** Copy into an ArrayBuffer-backed view so WebCrypto accepts it under TS 5.7+ DOM libs. */
function asCryptoBuffer(data: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Parse uncompressed secp256k1 pubkey (0x04||x||y). Rejects leftover RSA SPKI. */
export function parseTeeEncryptPubKey(pubKey: string): Uint8Array {
  const trimmed = pubKey.trim();
  if (!trimmed) {
    throw new Error("TEE encrypt public key missing. Set NEXT_PUBLIC_TEE_ENCRYPT_PUBKEY.");
  }
  if (trimmed.startsWith("MIIB") || trimmed.includes("-----BEGIN")) {
    throw new Error(
      "NEXT_PUBLIC_TEE_ENCRYPT_PUBKEY is an RSA key. FCC tee-node expects secp256k1 from proxy /info (0x04||x||y).",
    );
  }
  let bytes = hexToBytes(trimmed);
  if (bytes.length === 64) bytes = concatBytes(new Uint8Array([0x04]), bytes);
  if (bytes.length !== 65 || bytes[0] !== 0x04) {
    throw new Error("TEE encrypt public key must be uncompressed secp256k1 (65-byte 0x04||x||y hex).");
  }
  secp256k1.ProjectivePoint.fromHex(bytes);
  return bytes;
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", asCryptoBuffer(data)));
}

/** NIST SP 800-56 concatKDF as used by go-ethereum crypto/ecies. */
async function concatKdf(z: Uint8Array, kdLen: number): Promise<Uint8Array> {
  const out = new Uint8Array(kdLen);
  let offset = 0;
  let counter = 1;
  while (offset < kdLen) {
    const ctr = new Uint8Array(4);
    new DataView(ctr.buffer).setUint32(0, counter, false);
    const block = await sha256(concatBytes(ctr, z));
    const take = Math.min(block.length, kdLen - offset);
    out.set(block.subarray(0, take), offset);
    offset += take;
    counter += 1;
  }
  return out;
}

async function aes128Ctr(key: Uint8Array, iv: Uint8Array, plain: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey("raw", asCryptoBuffer(key), "AES-CTR", false, ["encrypt"]);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-CTR", counter: asCryptoBuffer(iv), length: 128 },
    cryptoKey,
    asCryptoBuffer(plain),
  );
  return new Uint8Array(ct);
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    asCryptoBuffer(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", cryptoKey, asCryptoBuffer(data));
  return new Uint8Array(mac);
}

/** Encrypt `plain` to the TEE secp256k1 public key (go-ethereum ECIES). */
export async function encryptEcies(plain: Uint8Array, uncompressedPub: Uint8Array): Promise<Uint8Array> {
  const ephemeralPriv = secp256k1.utils.randomPrivateKey();
  const ephemeralPub = secp256k1.getPublicKey(ephemeralPriv, false); // 65 bytes
  const shared = secp256k1.getSharedSecret(ephemeralPriv, uncompressedPub, true); // 33 = 02/03||x
  const z = shared.subarray(1); // 32-byte x coordinate (GenerateShared pad)

  const k = await concatKdf(z, 32);
  const ke = k.subarray(0, 16);
  const km = await sha256(k.subarray(16, 32));

  const iv = crypto.getRandomValues(new Uint8Array(16));
  const ciphertext = await aes128Ctr(ke, iv, plain);
  const enc = concatBytes(iv, ciphertext);
  const tag = await hmacSha256(km, enc);
  return concatBytes(ephemeralPub, enc, tag);
}

export async function encryptSignal(
  payload: SignalPayload,
  pubKeyHex: string,
): Promise<`0x${string}`> {
  const pub = parseTeeEncryptPubKey(pubKeyHex);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const cipher = await encryptEcies(plaintext, pub);
  return bytesToHex(cipher);
}
