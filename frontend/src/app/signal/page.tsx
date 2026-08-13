"use client";

import { useState } from "react";
import { useAccount, useWriteContract } from "wagmi";
import { config } from "@/lib/config";
import { instructionSenderAbi } from "@/lib/abis";
import { encryptSignal, FCC_INSTRUCTION_FEE_WEI } from "@/lib/encrypt";

export default function SignalPage() {
  const { address, isConnected } = useAccount();
  const [asset, setAsset] = useState("FXRP");
  const [sizePct, setSizePct] = useState(10);
  const [status, setStatus] = useState("");
  const [err, setErr] = useState("");
  const [fillTxs, setFillTxs] = useState<string[]>([]);
  const { writeContractAsync, isPending } = useWriteContract();
  const [busy, setBusy] = useState(false);

  async function resolveEncryptKey(): Promise<string> {
    try {
      const res = await fetch("/api/tee-info", { cache: "no-store" });
      const body = (await res.json()) as { ok?: boolean; encryptPubKey?: string; error?: string };
      if (body.encryptPubKey) return body.encryptPubKey;
      if (config.teeEncryptPubKey) return config.teeEncryptPubKey;
      throw new Error(body.error || "Matching TEE pubkey unavailable");
    } catch {
      if (config.teeEncryptPubKey) return config.teeEncryptPubKey;
      throw new Error(
        "TEE encrypt public key missing. Set MATCHING_TEE_PROXY_URL or NEXT_PUBLIC_TEE_ENCRYPT_PUBKEY.",
      );
    }
  }

  async function submit() {
    setErr("");
    setStatus("");
    setFillTxs([]);
    if (!address) return;
    setBusy(true);
    try {
      setStatus("Fetching live matching TEE key…");
      const pub = await resolveEncryptKey();
      const encrypted = await encryptSignal(
        {
          asset,
          direction: "SELL",
          sizePct,
          nonce: crypto.randomUUID(),
          recipient: address,
          lead: address,
        },
        pub,
      );
      setStatus("Encrypted. Submitting Stage B…");
      const tx = await writeContractAsync({
        address: config.instructionSender,
        abi: instructionSenderAbi,
        functionName: "sendMirrorMatchStageB",
        args: [encrypted],
        value: FCC_INSTRUCTION_FEE_WEI,
      });
      setStatus(`On-chain ${tx}. Waiting for TEE decrypt + vault fill…`);
      const fillRes = await fetch("/api/execute-match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ txHash: tx }),
      });
      const fill = (await fillRes.json()) as {
        ok?: boolean;
        skipped?: boolean;
        error?: string;
        fills?: number;
        txs?: string[];
      };
      if (fill.ok) {
        setFillTxs(fill.txs ?? []);
        setStatus(`Filled ${fill.fills} follower vault swap(s) on MockSparkDexRouter.`);
      } else if (fill.skipped) {
        setStatus(`Signal confirmed ${tx}. Fill skipped: ${fill.error}`);
      } else {
        throw new Error(fill.error || "execute-match failed");
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const sending = isPending || busy;

  return (
    <section className="section form-panel">
      <h2>Encrypted signal</h2>
      <p>
        Encrypts in-browser to the <strong>matching</strong> TEE, submits{" "}
        <code>MATCH_V1</code> on Coston2, then this app calls <code>executeMatch</code> so
        follower vault FXRP sells into USDT0 on MockSparkDexRouter (SparkDEX V3 ABI; the
        published SparkDEX router has no bytecode on chain 114).
      </p>
      {!isConnected && <p className="muted">Connect as lead to submit.</p>}
      <label>
        Asset
        <input value={asset} onChange={(e) => setAsset(e.target.value)} />
      </label>
      <p className="muted">Direction is SELL (vault is FXRP-only).</p>
      <label>
        Size % ({sizePct})
        <input
          type="range"
          min={1}
          max={100}
          value={sizePct}
          onChange={(e) => setSizePct(Number(e.target.value))}
        />
      </label>
      <button className="btn block" type="button" disabled={!isConnected || sending} onClick={submit}>
        {sending ? "Working…" : "Encrypt, submit & fill"}
      </button>
      {status && <p className="ok">{status}</p>}
      {fillTxs.map((t) => (
        <p key={t} className="ok">
          fill {t}
        </p>
      ))}
      {err && <p className="err">{err}</p>}
    </section>
  );
}
