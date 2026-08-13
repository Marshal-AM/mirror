"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useAccount, usePublicClient, useWriteContract } from "wagmi";
import { parseUnits } from "viem";
import { config, RISK_LABELS, FXRP_DECIMALS, STRATEGY_LABELS } from "@/lib/config";
import { registryAbi, vaultAbi, erc20Abi } from "@/lib/abis";
import { loadDiscoverLeads, type DiscoverLead } from "@/lib/leads";

function FollowerOnboardForm() {
  const search = useSearchParams();
  const preset = search.get("lead") ?? "";
  const { address, isConnected } = useAccount();
  const client = usePublicClient();
  const [risk, setRisk] = useState(1);
  const [lead, setLead] = useState(preset);
  const [amount, setAmount] = useState("1");
  const [leads, setLeads] = useState<DiscoverLead[]>([]);
  const [step, setStep] = useState<"idle" | "register" | "approve" | "deposit" | "follow">("idle");
  const { writeContractAsync, error } = useWriteContract();
  const [msg, setMsg] = useState("");

  useEffect(() => {
    if (!client) return;
    void loadDiscoverLeads(client).then(setLeads);
  }, [client]);

  useEffect(() => {
    if (preset) setLead(preset);
  }, [preset]);

  async function run() {
    if (!address || !client) return;
    setMsg("");
    try {
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

      const amt = parseUnits(amount || "0", FXRP_DECIMALS);
      if (lead && amt > 0n) {
        const leadAddr = lead as `0x${string}`;
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
          args: [leadAddr, amt],
        });
        const alloc = await client.readContract({
          address: config.registry,
          abi: registryAbi,
          functionName: "getFollowAllocation",
          args: [address, leadAddr],
        });
        if (!alloc.active) {
          setStep("follow");
          await writeContractAsync({
            address: config.registry,
            abi: registryAbi,
            functionName: "followLead",
            args: [leadAddr, amt],
          });
        }
      }
      setMsg("Follower onboarding complete.");
      setStep("idle");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
      setStep("idle");
    }
  }

  return (
    <section className="section form-panel">
      <h2>Follower onboarding</h2>
      <p>Pick a lead from Discover, deposit FXRP, then follow. Already-registered wallets skip the register tx.</p>
      {!isConnected && <p className="muted">Connect a wallet to continue.</p>}
      <label>
        Risk profile
        <select value={risk} onChange={(e) => setRisk(Number(e.target.value))}>
          {RISK_LABELS.map((r, i) => (
            <option key={r} value={i}>
              {r}
            </option>
          ))}
        </select>
      </label>
      <label>
        Lead to follow
        <select value={lead} onChange={(e) => setLead(e.target.value)}>
          <option value="">Select a lead…</option>
          {leads.map((l) => (
            <option key={l.address} value={l.address}>
              {STRATEGY_LABELS[l.strategyType] ?? "lead"} · {l.address.slice(0, 8)}…{l.address.slice(-6)}
              {l.score ? ` · score ${l.score}` : ""}
            </option>
          ))}
        </select>
      </label>
      <label>
        Deposit amount (FXRP)
        <input value={amount} onChange={(e) => setAmount(e.target.value)} />
      </label>
      <button
        className="btn block"
        type="button"
        disabled={!isConnected || !lead || step !== "idle"}
        onClick={run}
      >
        {step === "idle" ? "Follow this lead" : `Working: ${step}…`}
      </button>
      <p className="muted" style={{ marginTop: "1rem" }}>
        Prefer the list? <Link href="/#discover">Open Discover</Link>
        {" · "}
        XRPL path: <Link href="/follower/xrpl">Smart Account onboarding</Link>
      </p>
      {msg && <p className={msg.startsWith("Follower") ? "ok" : "err"}>{msg}</p>}
      {error && <p className="err">{error.message}</p>}
    </section>
  );
}

export default function FollowerOnboardPage() {
  return (
    <Suspense fallback={<p className="muted">Loading…</p>}>
      <FollowerOnboardForm />
    </Suspense>
  );
}
