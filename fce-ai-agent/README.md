# Mirror AI Agent FCE (Phase 6–9)

Independently code-hashed Flare Compute Extension for:

- Performance scoring (Sharpe-equivalent, max drawdown, consistency → composite score 0–100; rule-based, not an LLM)
- Strategy classification (`momentum` | `mean-reversion` | `yield-arb`)
- Drift detection vs registered `strategyType` baseline (`DRIFT_CONFIDENCE_THRESHOLD`, default 0.55)
- Position health vs MockKinetic + FTSO-informed alert line (`LIQUIDATION_ALERT_BPS`)
- FDC Web2Json market context (CoinGecko / DeFiLlama)
- `MirrorLeaderboard.updateScore` via the `ai-agent-signer` persona

## Run locally

```bash
cd fce-ai-agent/typescript
npm install
npm test
npm run build
EXTENSION_PORT=8200 SYNTHETIC_OUTCOME_FIXTURE=1 npm start
```

Op commands: `MIRROR` / `SCORE_V1` (distinct from matching-engine `MATCH_V1` / `TOPUP_V1`).

## Live FCC (Coston2, same VM as matching)

Second enclave: own `AiAgentSender`, own extension id, ports **6683/6684**, compose project `tunnel-ai`. Do not stop the matching TEE.

Operator copy-paste: [VM-BRINGUP.md](./VM-BRINGUP.md).

```bash
# after VM bring-up
AI_AGENT_SENDER=0x... AI_EXT_PROXY_URL=https://... npm run ai:score-v1-tee
```

Simulated TEE may share on-chain `codeHash` with matching — distinguish by extension id / sender / SCORE_V1.

## TEE-to-TEE outcome log

The matching engine exposes `GET /internal/outcome-log` gated by `TEE_INTERNAL_TOKEN`.
Set `MATCHING_ENGINE_PRIVATE_LOG_URL` on the AI agent. For canaries, use `SYNTHETIC_OUTCOME_FIXTURE=1`.

## Coston2 canaries

```bash
npm run fce:compare-hashes   # distinct code hashes
npm run ai:score-canary      # 2 leads + Web2Json + updateScore (slow; needs FDC)
npm run ai:drift-canary      # 50-cycle false-positive + injection
npm run ai:health-canary     # MockKinetic price-drop + TOPUP_V1
```
