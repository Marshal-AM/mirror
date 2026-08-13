/**
 * Mirror AI Agent FCE handlers — SCORE_V1.
 */

import { bytesToHex, hexToBytes } from "../base/encoding.js";
import type { Framework, HandlerResult } from "../base/types.js";
import { decodeSayGoodbye } from "./abi.js";
import { classifyLead } from "./classify.js";
import { detectDrift } from "./drift.js";
import {
  OP_COMMAND_SAY_GOODBYE,
  OP_COMMAND_SAY_HELLO,
  OP_COMMAND_SCORE_V1,
  OP_TYPE_GREETING,
  OP_TYPE_MIRROR,
} from "./config.js";
import { scoreLead, type OutcomeEvent } from "./scoring.js";
import { syntheticMeanRevLead, syntheticMomentumLead } from "./synthetic.js";

let greetingCount = 0;
let lastGreeting = "";
let farewellCount = 0;
let lastFarewell = "";
let lastScoreRun: unknown = null;

export function resetState(): void {
  greetingCount = 0;
  lastGreeting = "";
  farewellCount = 0;
  lastFarewell = "";
  lastScoreRun = null;
}

export function register(framework: Framework): void {
  framework.handle(OP_TYPE_GREETING, OP_COMMAND_SAY_HELLO, handleSayHello);
  framework.handle(OP_TYPE_GREETING, OP_COMMAND_SAY_GOODBYE, handleSayGoodbye);
  framework.handle(OP_TYPE_MIRROR, OP_COMMAND_SCORE_V1, handleScoreV1);
}

export function reportState(): unknown {
  return {
    greetingCount,
    lastGreeting,
    farewellCount,
    lastFarewell,
    lastScoreRun,
  };
}

export function handleSayHello(msg: string): HandlerResult {
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
  const unknown = Object.keys(req).filter((k) => k !== "name").sort();
  if (unknown.length > 0) {
    return [null, 0, `decoding request: unknown field "${unknown[0]}"`];
  }
  const name = (req as { name?: unknown }).name;
  if (typeof name !== "string" || name === "") {
    return [null, 0, "name must not be empty"];
  }
  greetingCount++;
  const greeting = `Hello, ${name}! Welcome to Mirror AI Agent FCE.`;
  lastGreeting = greeting;
  return [bytesToHex(Buffer.from(JSON.stringify({ greeting, greetingNumber: greetingCount }), "utf-8")), 1, null];
}

export function handleSayGoodbye(msg: string): HandlerResult {
  let hex: string;
  try {
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
  if (!decoded.name) return [null, 0, "name must not be empty"];
  farewellCount++;
  const farewell = `Goodbye, ${decoded.name}! Reason: ${decoded.reason}`;
  lastFarewell = farewell;
  return [bytesToHex(Buffer.from(JSON.stringify({ farewell, farewellNumber: farewellCount }), "utf-8")), 1, null];
}

/**
 * SCORE_V1 payload (hex JSON):
 *   { lead: "0x...", events?: OutcomeEvent[], fixture?: "momentum"|"mean-reversion", attestationId?: "0x..." }
 */
export async function handleScoreV1(msg: string): Promise<HandlerResult> {
  let ciphertext: Uint8Array;
  try {
    ciphertext = hexToBytes(msg);
  } catch (e) {
    return [null, 0, `decoding request: invalid hex: ${String(e)}`];
  }

  let parsed: any;
  try {
    parsed = JSON.parse(Buffer.from(ciphertext).toString("utf-8"));
  } catch {
    return [null, 0, "payload: expected JSON object"];
  }
  if (!parsed || typeof parsed !== "object") {
    return [null, 0, "payload: expected JSON object"];
  }

  const lead = parsed.lead;
  if (typeof lead !== "string" || !lead.startsWith("0x") || lead.length !== 42) {
    return [null, 0, "lead must be a 20-byte hex address"];
  }

  let events: OutcomeEvent[] = [];
  // Canaries may pass `fixture`. Production SCORE_V1 (Vercel) must not.
  if (process.env.SYNTHETIC_OUTCOME_FIXTURE === "1" || parsed.fixture) {
    const fixture = parsed.fixture ?? "momentum";
    events =
      fixture === "mean-reversion" ? syntheticMeanRevLead(lead) : syntheticMomentumLead(lead);
  } else if (Array.isArray(parsed.events)) {
    events = parsed.events as OutcomeEvent[];
  } else {
    try {
      events = await fetchOutcomeLog(lead);
    } catch (e) {
      return [null, 0, `outcome log: ${e instanceof Error ? e.message : String(e)}`];
    }
  }

  const breakdown = scoreLead(events);
  const classification = classifyLead(events);
  const baselineStrategyType =
    typeof parsed.baselineStrategyType === "number" ? parsed.baselineStrategyType : 0;
  const cycle = typeof parsed.cycle === "number" ? parsed.cycle : 0;
  const drift = detectDrift({
    lead,
    baselineStrategyType,
    events,
    cycle,
  });
  const attestationId =
    typeof parsed.attestationId === "string" && parsed.attestationId.startsWith("0x")
      ? parsed.attestationId
      : "0x" + "00".repeat(32);

  const result = {
    lead,
    score: breakdown.aiScore,
    breakdown,
    classification,
    drift,
    attestationId,
    eventCount: events.length,
  };
  lastScoreRun = {
    lead,
    score: breakdown.aiScore,
    strategy: classification.strategy,
    drifted: drift.drifted,
  };
  return [bytesToHex(Buffer.from(JSON.stringify(result), "utf-8")), 1, null];
}

function outcomeLogUrl(base: string, lead: string): string {
  const trimmed = base.replace(/\/$/, "");
  const hasPath = /\/(internal\/outcome-log|api\/outcomes)$/.test(trimmed);
  const url = new URL(hasPath ? trimmed : `${trimmed}/internal/outcome-log`);
  url.searchParams.set("lead", lead);
  return url.toString();
}

async function fetchOneOutcomeLog(base: string, lead: string, token: string): Promise<OutcomeEvent[]> {
  const res = await fetch(outcomeLogUrl(base, lead), {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`${base} HTTP ${res.status}`);
  const body = (await res.json()) as { events?: OutcomeEvent[] };
  return Array.isArray(body.events) ? body.events : [];
}

async function fetchOutcomeLog(lead: string): Promise<OutcomeEvent[]> {
  const token = process.env.TEE_INTERNAL_TOKEN ?? "";
  const bases = [
    process.env.MATCHING_ENGINE_PRIVATE_LOG_URL,
    process.env.MIRROR_OUTCOME_LOG_URL,
  ].filter((u): u is string => Boolean(u && u.trim()));
  if (bases.length === 0 || !token) {
    throw new Error("MATCHING_ENGINE_PRIVATE_LOG_URL / TEE_INTERNAL_TOKEN not set (and no fixture)");
  }
  const collected: OutcomeEvent[] = [];
  const errors: string[] = [];
  for (const base of bases) {
    try {
      collected.push(...(await fetchOneOutcomeLog(base, lead, token)));
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (collected.length === 0 && errors.length === bases.length) {
    throw new Error(errors.join("; "));
  }
  const seen = new Set<string>();
  const out: OutcomeEvent[] = [];
  for (const e of collected) {
    const key = `${(e.lead ?? "").toLowerCase()}:${e.timestamp}:${e.pnlBps}:${e.sizePct ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}
