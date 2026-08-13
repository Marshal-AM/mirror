"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { formatUnits, type PublicClient } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import { config, STRATEGY_LABELS } from "@/lib/config";
import { registryAbi, vaultAbi, leaderboardAbi, vaultEventsAbi } from "@/lib/abis";

/** Coston2 public RPC: eth_getLogs max span is 30 blocks inclusive. */
const RPC_LOG_BLOCK_LIMIT = 30n;
/** ~3 FTSO epochs (~90s each, ~50 blocks) for settle-based P&L. */
const PNL_LOOKBACK_BLOCKS = 150n;

type HealthBadge = "Healthy" | "Drift Detected" | "Liquidation Risk";

type Position = {
  lead: `0x${string}`;
  balance: bigint;
  pending: bigint;
  score: number;
  strategy: string;
  health: HealthBadge;
  epochPnlFxrp: number;
  tradeSummary: string;
};

const FXRP_DECIMALS = 6;

function plainLanguageSummary(strategy: string, pnl: number, score: number): string {
  const dir =
    pnl > 0 ? "ahead on epoch P&L" : pnl < 0 ? "behind on epoch P&L" : "flat on epoch P&L";
  return `${strategy} lead — ${dir}; score ${score}/100 (rule-based composite).`;
}

type SettledFromProofLog = {
  args: {
    follower?: `0x${string}`;
    lead?: `0x${string}`;
    delta?: bigint;
  };
};

async function getSettledLogsChunked(
  client: PublicClient,
  follower: `0x${string}`,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<SettledFromProofLog[]> {
  const logs: SettledFromProofLog[] = [];
  let to = toBlock;
  while (to >= fromBlock) {
    const spanStart = to + 1n > RPC_LOG_BLOCK_LIMIT ? to + 1n - RPC_LOG_BLOCK_LIMIT : 0n;
    const from = spanStart < fromBlock ? fromBlock : spanStart;
    const chunk = await client.getContractEvents({
      address: config.vault,
      abi: vaultEventsAbi,
      eventName: "SettledFromProof",
      args: { follower },
      fromBlock: from,
      toBlock: to,
    });
    logs.push(...(chunk as unknown as SettledFromProofLog[]));
    if (from === fromBlock) break;
    to = from - 1n;
  }
  return logs;
}

export default function PortfolioPage() {
  const { address, isConnected } = useAccount();
  const client = usePublicClient();
  const [positions, setPositions] = useState<Position[]>([]);
  const [epochLabel, setEpochLabel] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!client || !address) return;
    (async () => {
      try {
        const block = await client.getBlockNumber();
        // ~90s FTSO epochs ≈ 50 blocks @1.8s; label for UI only
        const epoch = Number(block / 50n);
        setEpochLabel(`Epoch ~${epoch} (block ${block})`);

        const alertMap = new Map<string, HealthBadge>();
        try {
          const alertRes = await fetch(config.alertsUrl);
          if (alertRes.ok) {
            const alerts = (await alertRes.json()) as Array<{
              type: string;
              lead?: string;
              follower?: string;
            }>;
            for (const a of alerts) {
              if (a.follower && a.follower.toLowerCase() !== address.toLowerCase()) continue;
              if (!a.lead) continue;
              if (a.type === "liquidation_risk") alertMap.set(a.lead.toLowerCase(), "Liquidation Risk");
              else if (a.type === "drift" && !alertMap.has(a.lead.toLowerCase())) {
                alertMap.set(a.lead.toLowerCase(), "Drift Detected");
              }
            }
          }
        } catch {
          /* alerts optional */
        }

        const leads = (await client.readContract({
          address: config.registry,
          abi: registryAbi,
          functionName: "getFollowedLeads",
          args: [address],
        })) as `0x${string}`[];

        const fromBlock = block > PNL_LOOKBACK_BLOCKS ? block - PNL_LOOKBACK_BLOCKS : 0n;
        const settleByLead = new Map<string, bigint>();
        try {
          const settleLogs = await getSettledLogsChunked(client, address, fromBlock, block);
          for (const log of settleLogs) {
            const leadAddr = log.args.lead;
            const delta = log.args.delta;
            if (!leadAddr || delta === undefined) continue;
            const k = leadAddr.toLowerCase();
            settleByLead.set(k, (settleByLead.get(k) ?? 0n) + delta);
          }
        } catch {
          /* public RPC log window is optional; balances still load */
        }

        const rows: Position[] = [];
        for (const lead of leads) {
          const balance = (await client.readContract({
            address: config.vault,
            abi: vaultAbi,
            functionName: "getBalance",
            args: [address, lead],
          })) as bigint;
          const pending = (await client.readContract({
            address: config.vault,
            abi: vaultAbi,
            functionName: "getPendingWithdrawal",
            args: [address, lead],
          })) as bigint;
          const scoreRec = await client.readContract({
            address: config.leaderboard,
            abi: leaderboardAbi,
            functionName: "getScore",
            args: [lead],
          });
          const leadInfo = await client.readContract({
            address: config.registry,
            abi: registryAbi,
            functionName: "getLead",
            args: [lead],
          });
          const strategy = STRATEGY_LABELS[Number(leadInfo.strategyType)] ?? "unknown";
          const score = Number(scoreRec.score);
          const settled = settleByLead.get(lead.toLowerCase()) ?? 0n;
          const epochPnlFxrp = Number(formatUnits(settled, FXRP_DECIMALS));
          rows.push({
            lead,
            balance,
            pending,
            score,
            strategy,
            health: alertMap.get(lead.toLowerCase()) ?? "Healthy",
            epochPnlFxrp,
            tradeSummary: plainLanguageSummary(strategy, epochPnlFxrp, score),
          });
        }
        setPositions(rows);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [client, address]);

  return (
    <section className="section">
      <h2>Portfolio</h2>
      <p>
        Per-lead vault balances from live Coston2. Epoch P&L from recent FDC settle logs
        (public RPC allows 30 blocks per query). Trade summaries are classification-level
        only (PRD §6.2/§7).
      </p>
      {epochLabel && <p className="muted">{epochLabel}</p>}
      {!isConnected && <p className="muted">Connect to load positions.</p>}
      {err && <p className="err">{err}</p>}
      {isConnected && positions.length === 0 && !err && (
        <p className="muted">
          No followed leads yet. <Link href="/discover">Discover leads</Link>
        </p>
      )}
      {positions.length > 0 && (
        <table className="lead-table">
          <thead>
            <tr>
              <th>Lead</th>
              <th>Strategy</th>
              <th>Health</th>
              <th>Score</th>
              <th>Balance</th>
              <th>Epoch P&L</th>
              <th>Pending out</th>
            </tr>
          </thead>
          <tbody>
            {positions.map((p) => (
              <tr key={p.lead}>
                <td>
                  <Link href={`/lead/${p.lead}`}>
                    {p.lead.slice(0, 8)}…{p.lead.slice(-6)}
                  </Link>
                </td>
                <td>
                  <span className="badge">{p.strategy}</span>
                </td>
                <td>
                  <span className="badge">{p.health}</span>
                </td>
                <td className="score">{p.score}</td>
                <td>{formatUnits(p.balance, FXRP_DECIMALS)} FXRP</td>
                <td>
                  {p.epochPnlFxrp >= 0 ? "+" : ""}
                  {p.epochPnlFxrp.toFixed(4)} FXRP
                </td>
                <td>{formatUnits(p.pending, FXRP_DECIMALS)} FXRP</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {positions.length > 0 && (
        <div className="section" style={{ paddingTop: "1.5rem" }}>
          <h2 style={{ fontSize: "1.15rem" }}>Trade summaries</h2>
          <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
            {positions.map((p) => (
              <li key={`sum-${p.lead}`} className="muted" style={{ marginBottom: "0.5rem" }}>
                {p.tradeSummary}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
