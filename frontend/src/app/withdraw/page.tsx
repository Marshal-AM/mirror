"use client";

import { useEffect, useState } from "react";
import { parseUnits } from "viem";
import { useAccount, usePublicClient, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { config, FXRP_DECIMALS } from "@/lib/config";
import { registryAbi, vaultAbi } from "@/lib/abis";

function shortAddr(addr: string) {
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

export default function WithdrawPage() {
  const { address, isConnected } = useAccount();
  const client = usePublicClient();
  const [leads, setLeads] = useState<`0x${string}`[]>([]);
  const [lead, setLead] = useState("");
  const [amount, setAmount] = useState("1");
  const [loadErr, setLoadErr] = useState("");
  const { writeContract, data: hash, error, isPending } = useWriteContract();
  const { isLoading, isSuccess } = useWaitForTransactionReceipt({ hash });

  useEffect(() => {
    if (!client || !address) {
      setLeads([]);
      setLead("");
      return;
    }
    let cancelled = false;
    (async () => {
      setLoadErr("");
      try {
        const followed = (await client.readContract({
          address: config.registry,
          abi: registryAbi,
          functionName: "getFollowedLeads",
          args: [address],
        })) as `0x${string}`[];
        if (cancelled) return;
        setLeads(followed);
        setLead((prev) => (followed.includes(prev as `0x${string}`) ? prev : (followed[0] ?? "")));
      } catch (e) {
        if (!cancelled) setLoadErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, address]);

  function submit() {
    writeContract({
      address: config.vault,
      abi: vaultAbi,
      functionName: "requestWithdrawal",
      args: [lead as `0x${string}`, parseUnits(amount || "0", FXRP_DECIMALS)],
    });
  }

  return (
    <section className="section form-panel">
      <h2>Request withdrawal</h2>
      <p>Queues a withdrawal from MirrorVault for a followed lead.</p>
      {!isConnected && <p className="muted">Connect a wallet to continue.</p>}
      <label>
        Lead
        <select value={lead} onChange={(e) => setLead(e.target.value)} disabled={!isConnected || leads.length === 0}>
          {leads.length === 0 ? (
            <option value="">
              {isConnected ? "No followed leads" : "Connect wallet"}
            </option>
          ) : (
            leads.map((addr) => (
              <option key={addr} value={addr}>
                {shortAddr(addr)}
              </option>
            ))
          )}
        </select>
      </label>
      <label>
        Amount (FXRP)
        <input value={amount} onChange={(e) => setAmount(e.target.value)} />
      </label>
      <button
        className="btn block"
        type="button"
        disabled={!isConnected || !lead || isPending || isLoading}
        onClick={submit}
      >
        {isPending || isLoading ? "Submitting…" : "Request withdrawal"}
      </button>
      {isSuccess && <p className="ok">Withdrawal requested.</p>}
      {loadErr && <p className="err">{loadErr}</p>}
      {error && <p className="err">{error.message}</p>}
    </section>
  );
}
