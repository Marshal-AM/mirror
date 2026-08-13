# Known Limitations on Testnet

This document lists venues and features explicitly deferred or mocked on Coston2 (chain ID 114), per [phaseImplementation.md](./phaseImplementation.md).

## Deferred / Mocked (not real on Coston2 for MVP)

| Venue / Feature | Status | Reason |
|-----------------|--------|--------|
| **SparkDEX spot V3** | Interface-live mock (Phase 4A) | Published `SwapRouter` `0x8a1E…2781` still has **no bytecode** on Coston2 (re-verified 2026-08-13). Execution uses `MockSparkDexRouter` `0x6F3A431c74Ef7Ff30ed93569D4e8A43466E7F9e1` — same `exactInputSingle` ABI, real ERC20 transfers at live FTSO prices. Wire with `npm run tee:wire-execution`; fill TEE results with `npm run tee:execute-match`. |
| **BlazeSwap FXRP/USDT0** | Self-seeded test liquidity (Phase 4B) | Pair `0xa0B211953a3d8f42E82AfB01303933DdA5c434fe` created/funded by `scripts/venues/seed-blazeswap-pool.ts`. This is **not** third-party depth — the deployer is the LP. BlazeSwap `addLiquidity` uses extra `feeBipsA/feeBipsB` args (not Uniswap V2). Default `EXECUTION_VENUE` remains `mock-sparkdex`. |
| **AI agent TEE-to-TEE channel** | Partial (Phase 6) | Matching engine `GET /internal/outcome-log` gated by `TEE_INTERNAL_TOKEN`. Live AI FCC stack is `fce-ai-agent` (ports 6683/6684, `tunnel-ai`, `AiAgentSender`, `SCORE_V1`) — see `fce-ai-agent/VM-BRINGUP.md`. Synthetic fixture canaries do not need the private log. Full enclave-to-enclave outcome channel still optional. |
| **Simulated TEE codeHash** | May collide | With `SIMULATED_TEE=true`, matching and AI `/info` codeHash often share the FCC test hash (`0x194844cf…`). Distinguish FCEs by extension id (≠ 66187), `AiAgentSender` (≠ `0xf082…`), image/container, and op command. Do not claim on-chain hashes differ if `/info` matches. |
| **Web2Json dual-attestation canary** | Derived 2nd id | `ai:score-canary` uses one live Web2Json DA proof; lead2 `attestationId = keccak256(attBase, lead)`. Second full FDC round optional for demos. |
| **FSA XRPL path** | Live (Phase 8) | `MasterAccountController` + FDC Payment + `MirrorFsaOnboarder`. Combined Core Vault `0xFE` mint+onboard needs mint liquidity; canary covers FDC Payment + onboarder. Operator: `rEyj8nsHLdgt79KJWzXR5BgF7ZbaohbXwq`. |
| **Kinetic** | Mocked (Phase 9) | `MockKineticPool` `0x6ce64f1F6D60198281a4eA0aA639cAA10202554A` — stand-in until Kinetic Coston2 addresses verified |
| **Drift thresholds** | Configurable | `DRIFT_CONFIDENCE_THRESHOLD` default 0.55; `LIQUIDATION_ALERT_BPS` default 13000 (alert before mock liquidate at 11000) |
| **Enosys** | Mocked (Phase 10) | No usable Coston2 deployment (Enosys tests on Coston/Songbird). Deployed `MockEnosysCDP` `0xB2f32371D761F52895E697C8b2910098cf57FA60`. Routed when `MIRROR_MOCK_VENUES=true`. Demo CR params are **not** real Enosys risk. |
| **Firelight (passive staking)** | Mocked for MVP (Phase 10) | Real vault exists on Coston2 (`0xC90D6847747b85d1fa2E07859869fb9fB72c0361` = `firelightVaultReal`) but passive-staking UX is out of MVP. MVP router uses `MockFirelightStrategy` `0xa652DFD628be13feC4D56710D1cf281692deCE02`. |
| **FBTC market** | Unconfirmed | Not verified on Coston2 |
| **Flare mainnet SparkDEX spot** | Deferred | Real execution on chain ID 14 only. Hub guide / mainnet `SwapRouter` `0x8a1E35F5c98C4E85B36B7B253222eE17773b2781` — do **not** point Coston2 configs at these. |
| **Songbird canary FCC** | Deferred | Out of MVP scope |
| **FCC tooling** | Bleeding-edge | Extension SDKs, compose images, and registry helpers may shift; pin versions used in canaries and re-verify after FCC upgrades. |
| **Live FCC extension registration** | Operator step | Matching FCE is live (ext 66187). AI FCE bring-up is `fce-ai-agent/VM-BRINGUP.md` (new sender + `pre-register.sh` + `post-build.sh`). Local artifact hashes: `fce:compare-hashes` → `config/fce-code-hashes.json`. |
| **PMW executable batch signing** | Partial | Stage B assembles venue calldata `{to,data,venue}`; full TEE-resident PMW signing of the settlement tx depends on live tee-node `SIGN_PORT` in the FCC stack. |
| **Vault settleBatch** | Gated (Phase 5) | Default `legacySettleBatchEnabled=false` — proof-free settleBatch reverts; use `settleFromProof` / `applyFdcSettlement`. |

## Real on Coston2 (used or planned)

- FTSO v2, FDC, FAssets/FXRP, Flare Smart Accounts, FCC/FCE
- Firelight vault (`0xC90D6847747b85d1fa2E07859869fb9fB72c0361`) — real address reserved; MVP staking deferred
- BlazeSwap factory/router — deployed; insufficient FXRP/USDT0 liquidity for copy-trading fills without self-seed

## Phase 11 packaging scripts

| Script | Purpose |
|--------|---------|
| `npm run e2e:load-followers` | 1 lead + 5 followers Stage B fan-out |
| `npm run e2e:adversarial-plaintext` | Ciphertext-only public surfaces (prod path; no plaintext-fallback smoke) |
| `npm run demo:lifecycle` | One-command lifecycle demo (`DEMO_SKIP_SLOW_FDC=1` optional) |
| `npm run tee:proxy` | Phase 3 operator proxy to matching-engine FCE |
| `npm run ai:drift-monitor` / `ai:health-monitor` | Continuous Phase 9 loops (`DRIFT_MONITOR_CYCLES=3` for smoke) |
| `npm run fce:compare-hashes` | Rebuild-twice + ME≠AI digests → `config/fce-code-hashes.json` |
| `npm run ai:score-v1-tee` | Live AI FCE SAY_HELLO + SCORE_V1 (needs `AI_AGENT_SENDER` + `AI_EXT_PROXY_URL`) |

Bounty mapping: [SUBMISSION.md](./SUBMISSION.md).

## Remaining operator checklist (not auto-closed by code)

1. Fund all personas (faucet) until `npm run smoke` shows non-zero C2FLR.
2. Matching FCE is registered (ext 66187). Bring up the AI FCE with `fce-ai-agent/VM-BRINGUP.md`; record the new sender + extension id (not 0xf082 / 66187).
3. Run full `npm run fdc:cycle` (10 live rounds) outside PR CI and keep the console log for submission.
4. Independent reviewer re-runs `e2e:adversarial-plaintext`.

## Verification method

Venue state verified via `eth_getCode` / `eth_call` against Coston2 RPC (`https://coston2-api.flare.network/ext/C/rpc`), August 2026 — not docs alone. See Appendix A in phaseImplementation.md.
