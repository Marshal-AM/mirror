import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { OutcomeEvent } from "../../fce-ai-agent/typescript/src/app/scoring.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const DIR = join(ROOT, "scripts/.outcomes");

export type StoredOutcome = OutcomeEvent & {
  txHash?: string;
  fxrpUsdWei?: string;
  amountIn?: string;
  amountOut?: string;
  quotedOut?: string;
};

function fileFor(lead: string): string {
  return join(DIR, `${lead.toLowerCase()}.json`);
}

export function loadLeadOutcomes(lead: string): StoredOutcome[] {
  const p = fileFor(lead);
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as StoredOutcome[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function appendLeadOutcome(lead: string, event: StoredOutcome): StoredOutcome[] {
  mkdirSync(DIR, { recursive: true });
  const prev = loadLeadOutcomes(lead);
  if (event.txHash) {
    const key = event.txHash.toLowerCase();
    if (prev.some((e) => e.txHash?.toLowerCase() === key)) return prev;
  }
  const next = [...prev, event].sort((a, b) => a.timestamp - b.timestamp);
  writeFileSync(fileFor(lead), JSON.stringify(next, null, 2));
  return next;
}

export function scoringEvents(rows: StoredOutcome[]): OutcomeEvent[] {
  return rows.map((e) => ({
    lead: e.lead,
    timestamp: e.timestamp,
    pnlBps: e.pnlBps,
    direction: e.direction,
    sizePct: e.sizePct,
  }));
}
