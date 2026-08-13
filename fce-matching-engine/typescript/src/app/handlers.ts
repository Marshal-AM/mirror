/**
 * ★ MAIN CUSTOMIZATION POINT: your extension's handlers.
 *
 * Mirrors go/internal/extension/extension.go. Each handler follows the same
 * 4-step pattern: decode, validate, execute, respond.
 *
 * Handler contract:
 *   (originalMessageHex) => [dataHexOrNull, status, errorOrNull]
 *   status 0 = error, 1 = success. See docs/extension-contract.md §4.6.
 *
 * The framework serializes handler calls, so plain module-level state is safe.
 */

import { bytesToHex, hexToBytes } from "../base/encoding.js";
import type { Framework, HandlerResult } from "../base/types.js";
import { NodeClient } from "../base/node.js";

import { decodeSayGoodbye } from "./abi.js";
import {
  OP_COMMAND_SAY_GOODBYE,
  OP_COMMAND_SAY_HELLO,
  OP_COMMAND_MATCH_V1,
  OP_COMMAND_TOPUP_V1,
  OP_TYPE_MIRROR,
  OP_TYPE_GREETING,
} from "./config.js";
import { appendOutcome } from "./outcomeLog.js";
import { encodeFunctionData, getAddress } from "viem";

// --- Extension state ---------------------------------------------------------
// Serialized by the framework; no locking needed here.
let greetingCount = 0;
let lastGreeting = "";
let farewellCount = 0;
let lastFarewell = "";

/** Reset all state. Used by tests; not part of the wire contract. */
export function resetState(): void {
  greetingCount = 0;
  lastGreeting = "";
  farewellCount = 0;
  lastFarewell = "";
}

/** Wire handlers to (opType, opCommand) pairs. */
export function register(framework: Framework): void {
  framework.handle(OP_TYPE_GREETING, OP_COMMAND_SAY_HELLO, handleSayHello);
  framework.handle(OP_TYPE_GREETING, OP_COMMAND_SAY_GOODBYE, handleSayGoodbye);
  framework.handle(OP_TYPE_MIRROR, OP_COMMAND_MATCH_V1, handleMirrorMatchStageB);
  framework.handle(OP_TYPE_MIRROR, OP_COMMAND_TOPUP_V1, handleMirrorTopUpV1);
}

/** Snapshot returned by GET /state. Mirrors the Go State struct. */
export function reportState(): unknown {
  return {
    greetingCount,
    lastGreeting,
    farewellCount,
    lastFarewell,
  };
}

/** GREETING/SAY_HELLO — JSON payload {"name": "..."}. */
export function handleSayHello(msg: string): HandlerResult {
  // 1. Decode
  let raw: Uint8Array;
  try {
    raw = hexToBytes(msg);
  } catch (e) {
    return [null, 0, `decoding request: invalid hex: ${String(e)}`];
  }

  let req: unknown;
  try {
    req = JSON.parse(Buffer.from(raw).toString("utf-8"));
  } catch (e) {
    return [null, 0, `decoding request: ${String(e)}`];
  }

  if (typeof req !== "object" || req === null || Array.isArray(req)) {
    return [null, 0, "decoding request: expected a JSON object"];
  }

  // Match Go's DisallowUnknownFields.
  const unknown = Object.keys(req).filter((k) => k !== "name").sort();
  if (unknown.length > 0) {
    return [null, 0, `decoding request: unknown field "${unknown[0]}"`];
  }

  // 2. Validate
  const name = (req as { name?: unknown }).name;
  if (typeof name !== "string" || name === "") {
    return [null, 0, "name must not be empty"];
  }

  // 3. Execute
  greetingCount++;
  const greeting = `Hello, ${name}! Welcome to Flare Confidential Compute.`;
  lastGreeting = greeting;

  // 4. Respond
  const resp = { greeting, greetingNumber: greetingCount };
  return [bytesToHex(Buffer.from(JSON.stringify(resp), "utf-8")), 1, null];
}

/** GREETING/SAY_GOODBYE — ABI-encoded (string name, string reason). */
export function handleSayGoodbye(msg: string): HandlerResult {
  // 1. Decode
  let hex: string;
  try {
    // Normalize through hexToBytes so malformed input fails here, not in viem.
    hex = bytesToHex(hexToBytes(msg));
  } catch (e) {
    return [null, 0, `decoding request: invalid hex: ${String(e)}`];
  }

  let decoded: { name: string; reason: string };
  try {
    decoded = decodeSayGoodbye(hex as `0x${string}`);
  } catch (e) {
    return [null, 0, `decoding request: ${e instanceof Error ? e.message : String(e)}`];
  }

  // 2. Validate
  if (!decoded.name) {
    return [null, 0, "name must not be empty"];
  }

  // 3. Execute
  farewellCount++;
  const farewell = `Goodbye, ${decoded.name}! Reason: ${decoded.reason}`;
  lastFarewell = farewell;

  // 4. Respond
  const resp = { farewell, farewellNumber: farewellCount };
  return [bytesToHex(Buffer.from(JSON.stringify(resp), "utf-8")), 1, null];
}

function bytesToUint8Array(hex: string): Uint8Array {
  // Normalize through hexToBytes so malformed input fails fast.
  return hexToBytes(hex);
}

function safeJsonParse(buf: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(buf).toString("utf-8"));
  } catch {
    return null;
  }
}

/**
 * Mirror matching-engine Stage B.
 *
 * Contract expectations (MVP):
 * - handler receives `originalMessage` as hex-encoded bytes.
 * - those bytes are expected to be "encrypted signal bytes" and are decrypted
 *   inside TEE via tee-node `/decrypt` when available.
 * - the decrypted payload is JSON containing:
 *     { asset, direction, sizePct, nonce, follower?, lead?, recipient? }
 *
 * We intentionally avoid logging any decrypted/sensitive fields.
 */
export async function handleMirrorMatchStageB(msg: string): Promise<HandlerResult> {
  // --- 0) Decode hex originalMessage --------------------------------------
  let ciphertext: Uint8Array;
  try {
    ciphertext = bytesToUint8Array(msg);
  } catch (e) {
    return [null, 0, `decoding request: invalid hex: ${String(e)}`];
  }

  // --- 1) Decrypt (best-effort) ------------------------------------------
  // In local smoke / unit environments there might be no tee-node; keep a
  // deterministic plaintext fallback gated by env var.
  const allowPlaintextFallback = process.env.FCE_PLAINTEXT_DECRYPT_FALLBACK === "1";
  const decryptEnabled = process.env.SIGN_PORT !== undefined;

  let plaintext: Uint8Array | null = null;

  if (decryptEnabled) {
    try {
      const node = new NodeClient(process.env.SIGN_PORT ?? "9091");
      plaintext = await node.decrypt(ciphertext);
    } catch (e) {
      if (!allowPlaintextFallback) {
        return [null, 0, `decrypt failed (and fallback disabled): ${e instanceof Error ? e.message : String(e)}`];
      }
      plaintext = ciphertext;
    }
  } else if (allowPlaintextFallback) {
    plaintext = ciphertext;
  } else {
    return [null, 0, "decrypt unavailable (no SIGN_PORT) and fallback disabled"];
  }

  const parsed: any = safeJsonParse(plaintext!);
  if (!parsed || typeof parsed !== "object") {
    return [null, 0, "decrypted payload: expected JSON object"];
  }

  // --- 2) Validate non-sensitive shape --------------------------------
  const asset = parsed.asset;
  const direction = parsed.direction;
  const sizePct = parsed.sizePct; // basis points out of 10_000
  const recipient = parsed.recipient;
  const venueHint = String(
    parsed.venue ?? parsed.strategyKind ?? process.env.EXECUTION_VENUE ?? "mock-sparkdex",
  ).toLowerCase();
  const mockVenuesEnabled = process.env.MIRROR_MOCK_VENUES === "true";

  // Phase 10 mock venues: CDP / Firelight — same instruction payload shape, no FTSO swap path.
  if (
    mockVenuesEnabled &&
    (venueHint === "enosys-cdp" || venueHint === "firelight-strategy")
  ) {
    return buildMockVenueStageB(parsed, venueHint, sizePct);
  }

  if (typeof asset !== "string" || (asset !== "FXRP" && asset !== "USDT0")) {
    return [null, 0, "signal.asset must be FXRP or USDT0"];
  }
  if (typeof direction !== "string" || (direction !== "BUY" && direction !== "SELL")) {
    return [null, 0, "signal.direction must be BUY or SELL"];
  }
  if (typeof sizePct !== "number" || !Number.isFinite(sizePct) || sizePct <= 0) {
    return [null, 0, "signal.sizePct must be a positive number (bps)"];
  }

  type FollowerAlloc = { address: string; allocationBps: number };
  const followersRaw = Array.isArray(parsed.followers) ? (parsed.followers as FollowerAlloc[]) : null;
  if (followersRaw && followersRaw.length > 0) {
    for (const f of followersRaw) {
      if (typeof f.address !== "string" || !f.address.startsWith("0x") || f.address.length !== 42) {
        return [null, 0, "followers[].address must be a 20-byte hex address"];
      }
      if (typeof f.allocationBps !== "number" || f.allocationBps <= 0) {
        return [null, 0, "followers[].allocationBps must be positive"];
      }
    }
  } else if (typeof recipient !== "string" || !recipient.startsWith("0x") || recipient.length !== 42) {
    return [null, 0, "signal.recipient must be a 20-byte hex address string"];
  }

  // --- 3) Read FTSO feed prices ----------------------------------------
  // NOTE: This runs inside the TEE; it must NOT print decrypted fields.
  // FCC allow_env_override does not include FLARE_RPC_URL; CHAIN_URL may only
  // reach tee-node, not this Node process. Default to public Coston2 RPC.
  const rpcUrl =
    process.env.FLARE_RPC_URL ||
    process.env.CHAIN_URL ||
    "https://coston2-api.flare.network/ext/C/rpc";

  const { createPublicClient, http, getAddress, encodeFunctionData } = await import("viem");
  const client = createPublicClient({ chain: { id: 114 } as any, transport: http(rpcUrl) });

  const REGISTRY = "0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019";
  const REGISTRY_ABI = [
    {
      name: "getContractAddressByName",
      type: "function",
      stateMutability: "view",
      inputs: [{ name: "_name", type: "string" }],
      outputs: [{ name: "", type: "address" }],
    },
  ];

  const FTSO_ABI = [
    {
      name: "getFeedByIdInWei",
      type: "function",
      stateMutability: "view",
      inputs: [{ name: "_feedId", type: "bytes21" }],
      outputs: [
        { name: "valueWei", type: "uint256" },
        { name: "timestamp", type: "uint64" },
      ],
    },
  ];

  // bytes21 feed IDs (sourced from scripts/ftso/feedIds.ts):
  const FXRP_USD_FEED_ID = "0x015852502f55534400000000000000000000000000" as `0x${string}`;
  const USDT0_USD_FEED_ID = "0x01555344542f555344000000000000000000000000" as `0x${string}`;

  // Feed reads use the on-chain ContractRegistry indirection (no hardcoded oracle address).
  const ftsoV2 = (await client.readContract({
    address: getAddress(REGISTRY),
    abi: REGISTRY_ABI,
    functionName: "getContractAddressByName",
    args: ["FtsoV2"],
  })) as `0x${string}`;

  const fxrpFeed = (await client.readContract({
    address: ftsoV2,
    abi: FTSO_ABI,
    functionName: "getFeedByIdInWei",
    args: [FXRP_USD_FEED_ID],
  })) as [bigint, bigint];
  const usdt0Feed = (await client.readContract({
    address: ftsoV2,
    abi: FTSO_ABI,
    functionName: "getFeedByIdInWei",
    args: [USDT0_USD_FEED_ID],
  })) as [bigint, bigint];
  const fxrpUsd = fxrpFeed[0];
  const usdt0Usd = usdt0Feed[0];
  if (fxrpUsd === 0n || usdt0Usd === 0n) return [null, 0, "ftso returned zero price"];

  // Resolve token addresses via ContractRegistry (no reliance on env vars).
  const FXRP_ASSET_MANAGER = "AssetManagerFXRP";
  const USDT0_ASSET_MANAGER = "AssetManagerUSDT0";
  const ASSET_MANAGER_ABI = [
    {
      name: "fAsset",
      type: "function",
      stateMutability: "view",
      inputs: [],
      outputs: [{ name: "", type: "address" }],
    },
  ];

  let fxrpToken: `0x${string}`;
  let usdt0Token: `0x${string}`;

  if (process.env.C2_FXRP_ADDRESS && process.env.C2_FXRP_ADDRESS.startsWith("0x")) {
    fxrpToken = getAddress(process.env.C2_FXRP_ADDRESS as `0x${string}`);
  } else {
    const assetManagerFxrp = (await client.readContract({
      address: getAddress(REGISTRY),
      abi: REGISTRY_ABI,
      functionName: "getContractAddressByName",
      args: [FXRP_ASSET_MANAGER],
    })) as `0x${string}`;
    fxrpToken = (await client.readContract({
      address: assetManagerFxrp,
      abi: ASSET_MANAGER_ABI,
      functionName: "fAsset",
      args: [],
    })) as `0x${string}`;
  }

  if (process.env.C2_USDT0_ADDRESS && process.env.C2_USDT0_ADDRESS.startsWith("0x")) {
    usdt0Token = getAddress(process.env.C2_USDT0_ADDRESS as `0x${string}`);
  } else {
    const assetManagerUsdt0 = (await client.readContract({
      address: getAddress(REGISTRY),
      abi: REGISTRY_ABI,
      functionName: "getContractAddressByName",
      args: [USDT0_ASSET_MANAGER],
    })) as `0x${string}`;
    usdt0Token = (await client.readContract({
      address: assetManagerUsdt0,
      abi: ASSET_MANAGER_ABI,
      functionName: "fAsset",
      args: [],
    })) as `0x${string}`;
  }

  // --- 4) Position sizing ----------------------------------------------
  // UI sends 1–100 as percent; canaries may send bps (>100). FXRP/USDT0 are 6 dp.
  const sizePctBps = BigInt(sizePct <= 100 ? Math.trunc(sizePct * 100) : Math.trunc(sizePct));
  const tokenDecimals = 6n;
  const notionalCap = 1_000_000n * 10n ** tokenDecimals;
  const capNotional = (notionalCap * sizePctBps) / 10_000n;

  const leadAddr =
    typeof parsed.lead === "string" && parsed.lead.startsWith("0x") && parsed.lead.length === 42
      ? getAddress(parsed.lead as `0x${string}`)
      : null;

  const vaultAddr =
    process.env.MIRROR_VAULT_ADDRESS || "0x283aA87660cB02D1ffcEDd028B401766C076BdB4";
  const registryAddr =
    process.env.MIRROR_REGISTRY_ADDRESS || "0xfF4f9a603ebd126Db2BEc88A88a0fae6B2fB8065";
  let followersList: FollowerAlloc[] =
    followersRaw && followersRaw.length > 0
      ? followersRaw
      : [{ address: recipient as string, allocationBps: 10_000 }];
  const amountByFollower = new Map<string, bigint>();

  if (vaultAddr && registryAddr && leadAddr) {
    try {
      const VAULT_ABI = [
        {
          name: "getBalance",
          type: "function",
          stateMutability: "view",
          inputs: [
            { name: "follower", type: "address" },
            { name: "lead", type: "address" },
          ],
          outputs: [{ type: "uint256" }],
        },
        {
          name: "getPendingLocked",
          type: "function",
          stateMutability: "view",
          inputs: [
            { name: "follower", type: "address" },
            { name: "lead", type: "address" },
          ],
          outputs: [{ type: "uint256" }],
        },
      ] as const;
      const REG_ABI = [
        {
          name: "getFollowers",
          type: "function",
          stateMutability: "view",
          inputs: [{ name: "lead", type: "address" }],
          outputs: [{ type: "address[]" }],
        },
      ] as const;
      const onchainFollowers = (await client.readContract({
        address: getAddress(registryAddr as `0x${string}`),
        abi: REG_ABI,
        functionName: "getFollowers",
        args: [leadAddr],
      })) as `0x${string}`[];
      const targets =
        onchainFollowers.length > 0 ? onchainFollowers : followersList.map((f) => getAddress(f.address as `0x${string}`));
      const sized: FollowerAlloc[] = [];
      for (const addr of targets) {
        const bal = (await client.readContract({
          address: getAddress(vaultAddr as `0x${string}`),
          abi: VAULT_ABI,
          functionName: "getBalance",
          args: [addr, leadAddr],
        })) as bigint;
        const locked = (await client.readContract({
          address: getAddress(vaultAddr as `0x${string}`),
          abi: VAULT_ABI,
          functionName: "getPendingLocked",
          args: [addr, leadAddr],
        })) as bigint;
        const available = bal > locked ? bal - locked : 0n;
        const amount = (available * sizePctBps) / 10_000n;
        if (amount > 0n) {
          sized.push({ address: addr, allocationBps: 10_000 });
          amountByFollower.set(addr.toLowerCase(), amount);
        }
      }
      if (sized.length > 0) followersList = sized;
    } catch {
      // Fall through to notional-cap sizing (local smoke / missing contracts).
    }
  }

  const builds: Array<{
    to: string;
    data: string;
    venue: string;
    fee: number;
    recipient: string;
    amountIn: string;
    lead?: string;
    tokenIn?: string;
    tokenOut?: string;
  }> = [];

  for (const f of followersList) {
    const allocBps = BigInt(Math.trunc(f.allocationBps));
    const vaultAmt = amountByFollower.get(f.address.toLowerCase());
    const notionalWei = vaultAmt ?? (capNotional * allocBps) / 10_000n;
    if (notionalWei === 0n) continue;

    const tokenIn = direction === "BUY" ? usdt0Token : fxrpToken;
    const tokenOut = direction === "BUY" ? fxrpToken : usdt0Token;
    const priceIn = direction === "BUY" ? usdt0Usd : fxrpUsd;
    const priceOut = direction === "BUY" ? fxrpUsd : usdt0Usd;
    const expectedOut = (notionalWei * priceIn) / priceOut;
    const amountOutMinimum = (expectedOut * 9900n) / 10_000n;
    if (amountOutMinimum === 0n) return [null, 0, "sizing produced zero minOut"];

    const recipientAddr = getAddress(f.address as `0x${string}`);
    const now = BigInt(Math.floor(Date.now() / 1000));
    const deadline = now + 300n;
    const venue = (process.env.EXECUTION_VENUE ?? "mock-sparkdex").toLowerCase();

    let to: `0x${string}`;
    let calldata: `0x${string}`;

    if (venue === "blazeswap-v2") {
      const router = process.env.BLAZESWAP_ROUTER_ADDRESS;
      if (!router) return [null, 0, "missing BLAZESWAP_ROUTER_ADDRESS"];
      to = getAddress(router as `0x${string}`);
      const v2Abi = [
        {
          name: "swapExactTokensForTokens",
          type: "function",
          stateMutability: "nonpayable",
          inputs: [
            { name: "amountIn", type: "uint256" },
            { name: "amountOutMin", type: "uint256" },
            { name: "path", type: "address[]" },
            { name: "to", type: "address" },
            { name: "deadline", type: "uint256" },
          ],
          outputs: [{ name: "amounts", type: "uint256[]" }],
        },
      ] as const;
      calldata = encodeFunctionData({
        abi: v2Abi,
        functionName: "swapExactTokensForTokens",
        args: [notionalWei, amountOutMinimum, [tokenIn, tokenOut], recipientAddr, deadline],
      });
    } else {
      const router = process.env.MOCK_SPARKDEX_ROUTER_ADDRESS || "0x6F3A431c74Ef7Ff30ed93569D4e8A43466E7F9e1";
      if (!router) return [null, 0, "missing MOCK_SPARKDEX_ROUTER_ADDRESS"];
      to = getAddress(router as `0x${string}`);
      const exactInputSingleAbi = [
        {
          name: "exactInputSingle",
          type: "function",
          stateMutability: "nonpayable",
          inputs: [
            {
              name: "params",
              type: "tuple",
              components: [
                { name: "tokenIn", type: "address" },
                { name: "tokenOut", type: "address" },
                { name: "fee", type: "uint24" },
                { name: "recipient", type: "address" },
                { name: "deadline", type: "uint256" },
                { name: "amountIn", type: "uint256" },
                { name: "amountOutMinimum", type: "uint256" },
                { name: "sqrtPriceLimitX96", type: "uint160" },
              ],
            },
          ],
          outputs: [{ name: "amountOut", type: "uint256" }],
        },
      ] as const;
      calldata = encodeFunctionData({
        abi: exactInputSingleAbi,
        functionName: "exactInputSingle",
        args: [
          {
            tokenIn,
            tokenOut,
            fee: 500,
            recipient: recipientAddr,
            deadline,
            amountIn: notionalWei,
            amountOutMinimum,
            sqrtPriceLimitX96: 0n,
          },
        ],
      });
    }

    builds.push({
      to,
      data: calldata,
      venue,
      fee: venue === "blazeswap-v2" ? 0 : 500,
      recipient: recipientAddr,
      amountIn: notionalWei.toString(),
      lead: leadAddr ?? undefined,
      tokenIn,
      tokenOut,
    });
  }

  if (builds.length === 0) return [null, 0, "fan-out produced zero instructions"];

  const payload =
    builds.length === 1
      ? {
          to: builds[0]!.to,
          data: builds[0]!.data,
          venue: builds[0]!.venue,
          fee: builds[0]!.fee,
          recipient: builds[0]!.recipient,
          amountIn: builds[0]!.amountIn,
          lead: builds[0]!.lead,
          tokenIn: builds[0]!.tokenIn,
          tokenOut: builds[0]!.tokenOut,
        }
      : { fanOut: true, instructions: builds, venue: builds[0]!.venue };

  // Private outcome stub for AI agent (no signal plaintext beyond sizing aggregates).
  const outcomeLead = leadAddr ?? builds[0]!.recipient;
  appendOutcome({
    lead: outcomeLead,
    timestamp: Math.floor(Date.now() / 1000),
    pnlBps: 0,
    direction: direction as "BUY" | "SELL",
    sizePct: Math.trunc(sizePct),
  });

  return [bytesToHex(Buffer.from(JSON.stringify(payload), "utf-8")), 1, null];
}

/**
 * Phase 10 mock venue Stage B — Enosys CDP or Firelight strategy calldata.
 * Same response shape as swap path: { to, data, venue } or fan-out batch.
 */
function buildMockVenueStageB(
  parsed: any,
  venue: "enosys-cdp" | "firelight-strategy",
  sizePct: unknown,
): HandlerResult {
  if (typeof sizePct !== "number" || !Number.isFinite(sizePct) || sizePct <= 0) {
    return [null, 0, "signal.sizePct must be a positive number (bps)"];
  }

  type FollowerAlloc = { address: string; allocationBps: number };
  const followersRaw = Array.isArray(parsed.followers) ? (parsed.followers as FollowerAlloc[]) : null;
  const recipient = parsed.recipient;
  let targets: FollowerAlloc[];
  if (followersRaw && followersRaw.length > 0) {
    targets = followersRaw;
  } else if (typeof recipient === "string" && recipient.startsWith("0x") && recipient.length === 42) {
    targets = [{ address: recipient, allocationBps: 10_000 }];
  } else {
    return [null, 0, "signal.recipient or followers required for mock venue"];
  }

  const sizePctBps = BigInt(Math.trunc(sizePct));
  // FXRP 6 decimals notional cap for mock venues
  const notionalCap = 1_000_000n * 10n ** 6n;
  const baseNotional = (notionalCap * sizePctBps) / 10_000n;

  const builds: Array<{ to: string; data: string; venue: string; recipient: string; amountIn: string }> = [];

  for (const f of targets) {
    const notional = (baseNotional * BigInt(Math.trunc(f.allocationBps))) / 10_000n;
    if (notional === 0n) continue;
    const recipientAddr = getAddress(f.address as `0x${string}`);

    if (venue === "enosys-cdp") {
      const cdp = process.env.MOCK_ENOSYS_CDP_ADDRESS;
      if (!cdp) return [null, 0, "missing MOCK_ENOSYS_CDP_ADDRESS"];
      const to = getAddress(cdp as `0x${string}`);
      const mintAmount = notional / 2n;
      const abi = [
        {
          type: "function",
          name: "openCdp",
          stateMutability: "nonpayable",
          inputs: [
            { name: "collateralAmount", type: "uint256" },
            { name: "mintAmount", type: "uint256" },
          ],
          outputs: [],
        },
      ] as const;
      const data = encodeFunctionData({
        abi,
        functionName: "openCdp",
        args: [notional, mintAmount],
      });
      builds.push({ to, data, venue, recipient: recipientAddr, amountIn: notional.toString() });
    } else {
      const strat = process.env.MOCK_FIRELIGHT_STRATEGY_ADDRESS;
      if (!strat) return [null, 0, "missing MOCK_FIRELIGHT_STRATEGY_ADDRESS"];
      const to = getAddress(strat as `0x${string}`);
      const abi = [
        {
          type: "function",
          name: "deposit",
          stateMutability: "nonpayable",
          inputs: [{ name: "assets", type: "uint256" }],
          outputs: [{ name: "shares", type: "uint256" }],
        },
      ] as const;
      const data = encodeFunctionData({
        abi,
        functionName: "deposit",
        args: [notional],
      });
      builds.push({ to, data, venue, recipient: recipientAddr, amountIn: notional.toString() });
    }
  }

  if (builds.length === 0) return [null, 0, "mock venue fan-out produced zero instructions"];

  const leadAddr =
    typeof parsed.lead === "string" && parsed.lead.startsWith("0x")
      ? parsed.lead
      : builds[0]!.recipient;
  appendOutcome({
    lead: leadAddr,
    timestamp: Math.floor(Date.now() / 1000),
    pnlBps: 0,
    direction: "BUY",
    sizePct: Math.trunc(sizePct as number),
  });

  const payload =
    builds.length === 1
      ? { to: builds[0]!.to, data: builds[0]!.data, venue: builds[0]!.venue, fee: 0 }
      : { fanOut: true, instructions: builds, venue };

  return [bytesToHex(Buffer.from(JSON.stringify(payload), "utf-8")), 1, null];
}

/**
 * TOPUP_V1 — pre-authorized collateral top-up via MockKineticPool.supply calldata.
 * Message hex JSON: { follower, lead, amountWei, kineticPool }
 */
export function handleMirrorTopUpV1(msg: string): HandlerResult {
  let raw: Uint8Array;
  try {
    raw = hexToBytes(msg);
  } catch (e) {
    return [null, 0, `decoding request: invalid hex: ${String(e)}`];
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(Buffer.from(raw).toString("utf-8")) as Record<string, unknown>;
  } catch (e) {
    return [null, 0, `decoding request: ${String(e)}`];
  }

  const follower = typeof parsed.follower === "string" ? parsed.follower : "";
  const lead = typeof parsed.lead === "string" ? parsed.lead : "";
  const kineticPool =
    typeof parsed.kineticPool === "string"
      ? parsed.kineticPool
      : process.env.MOCK_KINETIC_POOL_ADDRESS ?? "";
  const amountWei = BigInt(String(parsed.amountWei ?? "0"));

  if (!follower.startsWith("0x") || !kineticPool.startsWith("0x") || amountWei <= 0n) {
    return [null, 0, "invalid top-up payload"];
  }

  const supplyAbi = [
    {
      type: "function",
      name: "supply",
      stateMutability: "nonpayable",
      inputs: [{ name: "amount", type: "uint256" }],
      outputs: [],
    },
  ] as const;

  const calldata = encodeFunctionData({
    abi: supplyAbi,
    functionName: "supply",
    args: [amountWei],
  });

  const payload = {
    to: kineticPool,
    data: calldata,
    venue: "mock-kinetic",
    follower,
    lead,
    amountWei: amountWei.toString(),
    op: "TOPUP_V1",
  };

  return [bytesToHex(Buffer.from(JSON.stringify(payload), "utf-8")), 1, null];
}
