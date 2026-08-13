const inFlight = new Map<string, Promise<number | null>>();
const done = new Set<string>();

/** Publish a rule-based lead score once per address per browser session. */
export function ensureLeadScored(lead: string): Promise<number | null> {
  const key = lead.toLowerCase();
  if (done.has(key)) return Promise.resolve(null);
  const existing = inFlight.get(key);
  if (existing) return existing;

  const run = (async () => {
    try {
      const res = await fetch("/api/refresh-score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lead }),
      });
      const body = (await res.json()) as { ok?: boolean; score?: number; error?: string };
      if (!body.ok) throw new Error(body.error || `score HTTP ${res.status}`);
      done.add(key);
      return typeof body.score === "number" ? body.score : null;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, run);
  return run;
}
