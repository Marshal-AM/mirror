"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { usePublicClient } from "wagmi";
import { STRATEGY_LABELS, RISK_LABELS } from "@/lib/config";
import { loadDiscoverLeads, type DiscoverLead } from "@/lib/leads";

export default function DiscoverPage() {
  const client = usePublicClient();
  const [rows, setRows] = useState<DiscoverLead[]>([]);
  const [strategyFilter, setStrategyFilter] = useState<string>("all");
  const [riskFilter, setRiskFilter] = useState<string>("all");
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState(true);

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
          <div className="hero-copy">
            <p className="hero-brand">Mirror</p>
            <h1>Private copy trading on Flare.</h1>
            <p>
              A lead encrypts a signal. Mirror’s TEE decrypts it and copies the trade into follower FXRP vaults.
              Scores from those fills help you pick who to follow — and skip who is not earning.
            </p>
            <div className="hero-cta">
              <a className="btn" href="#discover">
                Start following
              </a>
              <Link className="btn ghost" href="/lead/onboard">
                Register as lead
              </Link>
            </div>
          </div>
          <div className="hero-art" aria-hidden>
            <img src="/shard.png" alt="" />
          </div>
        </section>
      </div>

      <section className="section" id="discover">
        <h2>Discovery</h2>
        <p>
          Live leads on Coston2. Follow deposits FXRP into a vault; the next encrypted signal is
          copied for you. Scores are Sharpe, drawdown, consistency, and completeness from real fills.
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
