"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { usePublicClient } from "wagmi";
import { STRATEGY_LABELS, RISK_LABELS } from "@/lib/config";
import { loadDiscoverLeads, type DiscoverLead } from "@/lib/leads";
import { ensureLeadScored } from "@/lib/ensure-score";

export default function DiscoverPage() {
  const client = usePublicClient();
  const [rows, setRows] = useState<DiscoverLead[]>([]);
  const [strategyFilter, setStrategyFilter] = useState<string>("all");
  const [riskFilter, setRiskFilter] = useState<string>("all");
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [scoringNote, setScoringNote] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!client) return;
      setLoading(true);
      setError("");
      try {
        const next = await loadDiscoverLeads(client);
        if (cancelled) return;
        setRows(next);
        const unscored = next.filter((r) => r.score === 0);
        if (unscored.length === 0) return;
        setScoringNote("Publishing lead scores…");
        for (const row of unscored) {
          if (cancelled) return;
          try {
            const score = await ensureLeadScored(row.address);
            if (score == null || cancelled) continue;
            setRows((prev) =>
              prev.map((r) => (r.address === row.address ? { ...r, score } : r)),
            );
          } catch (e) {
            if (!cancelled) setError(e instanceof Error ? e.message : String(e));
          }
        }
        if (!cancelled) setScoringNote("");
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (strategyFilter !== "all" && STRATEGY_LABELS[r.strategyType] !== strategyFilter) {
        return false;
      }
      if (riskFilter !== "all") {
        // conservative prefers higher scores / lower fee; simple match heuristic
        const idx = RISK_LABELS.indexOf(riskFilter as (typeof RISK_LABELS)[number]);
        if (idx === 0 && r.score < 55) return false;
        if (idx === 2 && r.score > 90 && r.feeRateBps > 300) return false;
      }
      return true;
    });
  }, [rows, strategyFilter, riskFilter]);

  return (
    <>
      <div style={{ position: "relative" }}>
        <div className="hero-plane" aria-hidden />
        <section className="hero">
          <p className="hero-brand">Mirror</p>
          <h1>Copy leads you can measure.</h1>
          <p>
            Rule-based lead scores on Coston2. Encrypted signals. Follow with FXRP — without handing over your
            edge in the clear.
          </p>
          <div className="hero-cta">
            <a className="btn" href="#discover">
              Start following
            </a>
            <Link className="btn ghost" href="/lead/onboard">
              Register as lead
            </Link>
          </div>
        </section>
      </div>

      <section className="section" id="discover">
        <h2>Discovery</h2>
        <p>
          Registered leads on Coston2. Scores are a rule-based composite (Sharpe, drawdown,
          consistency, completeness) published automatically. Click Follow to deposit FXRP and copy
          that lead.
        </p>
        <div className="filters">
          <label>
            Strategy
            <select value={strategyFilter} onChange={(e) => setStrategyFilter(e.target.value)}>
              <option value="all">All</option>
              {STRATEGY_LABELS.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label>
            Risk match
            <select value={riskFilter} onChange={(e) => setRiskFilter(e.target.value)}>
              <option value="all">All</option>
              {RISK_LABELS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
        </div>
        {loading && <p className="muted">Loading Coston2 leaderboard…</p>}
        {scoringNote && <p className="muted">{scoringNote}</p>}
        {error && <p className="err">{error}</p>}
        {!loading && !error && filtered.length === 0 && (
          <p className="muted">No registered leads yet. Register as a lead first.</p>
        )}
        {filtered.length > 0 && (
          <table className="lead-table">
            <thead>
              <tr>
                <th>Lead</th>
                <th>Score</th>
                <th>Strategy</th>
                <th>Fee</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.address}>
                  <td>
                    <Link href={`/lead/${r.address}`}>
                      {r.address.slice(0, 8)}…{r.address.slice(-6)}
                    </Link>
                    {r.verified && <span className="badge" style={{ marginLeft: 8 }}>verified</span>}
                  </td>
                  <td className="score">{r.score}</td>
                  <td>
                    <span className="badge">{STRATEGY_LABELS[r.strategyType] ?? "unknown"}</span>
                  </td>
                  <td>{(r.feeRateBps / 100).toFixed(2)}%</td>
                  <td>
                    <Link className="btn" href={`/lead/${r.address}`}>
                      Follow
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
