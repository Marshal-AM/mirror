"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { parseUnits } from "viem";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { config, STRATEGY_LABELS, FXRP_DECIMALS, RISK_LABELS } from "@/lib/config";
import { leaderboardAbi, registryAbi, vaultAbi, erc20Abi } from "@/lib/abis";
import { ensureLeadScored } from "@/lib/ensure-score";

export default function LeadProfilePage() {
  const params = useParams<{ address: string }>();
  const lead = params.address as `0x${string}`;
  const client = usePublicClient();
  const { address, isConnected } = useAccount();
  const [score, setScore] = useState<number | null>(null);
  const [attestationId, setAttestationId] = useState<string>("");
  const [strategyType, setStrategyType] = useState(0);
  const [verified, setVerified] = useState(false);
  const [feeRateBps, setFeeRateBps] = useState(0);
  const [registeredLead, setRegisteredLead] = useState(false);
  const [alreadyFollowing, setAlreadyFollowing] = useState(false);
  const [allocation, setAllocation] = useState("1");
  const [risk, setRisk] = useState(1);
  const [step, setStep] = useState<"idle" | "register" | "approve" | "deposit" | "follow">("idle");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const { writeContractAsync } = useWriteContract();

  useEffect(() => {
    if (!client || !lead) return;
    (async () => {
      try {
        const l = await client.readContract({
          address: config.registry,
          abi: registryAbi,
          functionName: "getLead",
          args: [lead],
        });
        setRegisteredLead(Boolean(l.wallet && l.wallet !== "0x0000000000000000000000000000000000000000"));
        setStrategyType(Number(l.strategyType));
        setVerified(Boolean(l.verified));
        setFeeRateBps(Number(l.feeRateBps));
        try {
          const s = await client.readContract({
            address: config.leaderboard,
            abi: leaderboardAbi,
            functionName: "getScore",
            args: [lead],
          });
          setScore(Number(s.score));
          setAttestationId(s.attestationId);
          if (Number(s.score) === 0) {
            const next = await ensureLeadScored(lead);
            if (next != null) setScore(next);
          }
        } catch {
          setScore(0);
          try {
            const next = await ensureLeadScored(lead);
            if (next != null) setScore(next);
          } catch {
            /* keep 0 if SCORE_V1 is down */
          }
        }
        if (address) {
          const alloc = await client.readContract({
            address: config.registry,
            abi: registryAbi,
            functionName: "getFollowAllocation",
            args: [address, lead],
          });
          setAlreadyFollowing(Boolean(alloc.active));
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [client, lead, address]);

  async function follow() {
    if (!address || !client) return;
    setErr("");
    setMsg("");
    try {
      const amt = parseUnits(allocation || "0", FXRP_DECIMALS);
      const follower = await client.readContract({
        address: config.registry,
        abi: registryAbi,
        functionName: "getFollower",
        args: [address],
      });
      if (!follower.registered) {
        setStep("register");
        await writeContractAsync({
          address: config.registry,
          abi: registryAbi,
          functionName: "registerFollower",
          args: [risk],
        });
      }

      if (amt > 0n) {
        const allowance = await client.readContract({
          address: config.fxrp,
          abi: erc20Abi,
          functionName: "allowance",
          args: [address, config.vault],
        });
        if (allowance < amt) {
          setStep("approve");
          await writeContractAsync({
            address: config.fxrp,
            abi: erc20Abi,
            functionName: "approve",
            args: [config.vault, amt],
          });
        }
        setStep("deposit");
        await writeContractAsync({
          address: config.vault,
          abi: vaultAbi,
          functionName: "deposit",
          args: [lead, amt],
        });
      }

      const alloc = await client.readContract({
        address: config.registry,
        abi: registryAbi,
        functionName: "getFollowAllocation",
        args: [address, lead],
      });
      if (!alloc.active) {
        setStep("follow");
        await writeContractAsync({
          address: config.registry,
          abi: registryAbi,
          functionName: "followLead",
          args: [lead, amt],
        });
      }
      setAlreadyFollowing(true);
      setMsg("Following. Open Portfolio to see your vault balance.");
      setStep("idle");
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setStep("idle");
    }
  }

  const busy = step !== "idle";

  return (
    <section className="section profile-hero">
      <p className="muted">Lead profile</p>
      <h2 style={{ wordBreak: "break-all" }}>{lead}</h2>
      <div className="score-xl">{score ?? "—"}</div>
      <p>
        <span className="badge">{STRATEGY_LABELS[strategyType] ?? "unknown"}</span>
        {verified && <span className="badge" style={{ marginLeft: 8 }}>verified</span>}
        <span className="muted" style={{ marginLeft: 12 }}>
          fee {(feeRateBps / 100).toFixed(2)}%
        </span>
      </p>
      {attestationId && attestationId !== "0x" + "0".repeat(64) && (
        <p className="muted" style={{ fontSize: "0.85rem" }}>
          Attestation:{" "}
          <a
            href={`https://coston2-explorer.flare.network`}
            target="_blank"
            rel="noreferrer"
            style={{ color: "var(--mint)" }}
          >
            {attestationId.slice(0, 18)}…
          </a>
        </p>
      )}
      {!registeredLead && <p className="err">This address is not a registered lead.</p>}
      {alreadyFollowing && <p className="ok">You already follow this lead. Deposit below adds more FXRP.</p>}
      <label>
        Risk profile (first-time followers)
        <select value={risk} onChange={(e) => setRisk(Number(e.target.value))}>
          {RISK_LABELS.map((r, i) => (
            <option key={r} value={i}>
              {r}
            </option>
          ))}
        </select>
      </label>
      <label>
        Deposit amount (FXRP)
        <input value={allocation} onChange={(e) => setAllocation(e.target.value)} />
      </label>
      <button
        className="btn"
        type="button"
        disabled={!isConnected || !registeredLead || busy}
        onClick={follow}
      >
        {busy ? `Working: ${step}…` : alreadyFollowing ? "Deposit more" : "Follow"}
      </button>
      <p>
        <Link href="/#discover">Back to Discover</Link>
        {" · "}
        <Link href="/portfolio">Portfolio</Link>
      </p>
      {msg && <p className="ok">{msg}</p>}
      {err && <p className="err">{err}</p>}
    </section>
  );
}
