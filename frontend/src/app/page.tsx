"use client";

import Link from "next/link";

export default function HomePage() {
  return (
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
            <Link className="btn" href="/discover">
              Start following
            </Link>
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
  );
}
