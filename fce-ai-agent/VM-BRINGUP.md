# AI-agent FCE — operator bring-up (same GCE VM as matching)

Run these **on the FCC GCE VM**, not Windows. Matching TEE stays up.

Do **not**:

- stop matching-engine compose
- write `fce-matching-engine/config/extension.env`
- use compose project `tunnel` (AI uses `tunnel-ai`)
- run `fce-matching-engine/scripts/pre-build.sh` or `post-build.sh`
- call `setExtensionId` on `0xf082D53B50D08f0fdC06B0B4C6A1932DB589d91f`

Simulated TEE (`SIMULATED_TEE=true`) may share on-chain `codeHash` with matching. Distinguish by **extension id**, **AiAgentSender address**, **ports 6683/6684**, and **SCORE_V1**. Do not claim hashes differ if `/info` matches.

## 1. Pull and enter the AI tree

```bash
cd /path/to/mirror
git pull
cd fce-ai-agent
chmod +x scripts/*.sh scripts/lib/*.sh
```

Never `cd fce-matching-engine` for the remaining steps.

## 2. Indexer credentials

```bash
cp ../fce-matching-engine/config/proxy/extension_proxy.coston2.docker.toml \
   config/proxy/extension_proxy.coston2.docker.toml
```

That file is gitignored. Same indexer host/user as matching (`34.38.42.208`, `hackathon_user_58`).

## 3. `.env`

```bash
cp .env.example .env
```

Copy from matching `.env`: `DEPLOYMENT_PRIVATE_KEY`, `INITIAL_OWNER`, `PROXY_PRIVATE_KEY`, `CHAIN_URL`.

**Do not** copy matching `EXT_PROXY_URL`. Keep:

```
REDIS_BIND=127.0.0.1:6383
EXT_PROXY_INTERNAL_BIND=0.0.0.0:6683
EXT_PROXY_EXTERNAL_BIND=0.0.0.0:6684
COMPOSE_NETWORK=extension-scaffold-ai-agent
TUNNEL_TARGET=http://host.docker.internal:6684
LOCAL_MODE=false
SIMULATED_TEE=true
LANGUAGE=typescript
TEE_VERSION=v0.1.0-ai
```

## 4. Deploy AiAgentSender

From repo root. Hardhat wants `DEPLOYER_PRIVATE_KEY`; matching `.env` usually has `DEPLOYMENT_PRIVATE_KEY`:

```bash
cd /path/to/mirror
set -a
source fce-matching-engine/.env
set +a
export DEPLOYER_PRIVATE_KEY="${DEPLOYER_PRIVATE_KEY:-$DEPLOYMENT_PRIVATE_KEY}"
npm run deploy:ai-sender
```

Save the printed `AI_AGENT_SENDER`. It must **not** be `0xf082…`. Copy the same `DEPLOYMENT_PRIVATE_KEY` into `fce-ai-agent/.env` for `pre-register.sh` / `post-build.sh`.

## 5. Register the extension (AI config only)

```bash
cd fce-ai-agent
./scripts/pre-register.sh 0x<AI_AGENT_SENDER>
```

Confirm `EXTENSION_ID` is **not** `0x…1028b` (66187). File written: `fce-ai-agent/config/extension.env` only.

## 6. Start the AI TEE

```bash
./scripts/start-services.sh --chain coston2 --tunnel
```

Expect a **new** `*.trycloudflare.com` URL and containers named `fce-ai-agent-*`.

```bash
docker ps
# matching stack still up (:6674 / project tunnel)
# AI stack up (:6684 / project tunnel-ai)
```

## 7. Post-build (AI extension)

```bash
./scripts/post-build.sh
```

If this fails, matching should still answer:

```bash
curl -sf "$MATCHING_EXT_PROXY_URL/info" | head
```

Rollback AI only:

```bash
cd fce-ai-agent
./scripts/stop-services.sh --chain coston2 --tunnel
```

Do **not** run `fce-matching-engine/scripts/stop-services.sh --tunnel`.

## 8. Latch extension id (NEW sender)

From repo root (gitignored env, do not commit):

```bash
AI_AGENT_SENDER=0x<AI_AGENT_SENDER> npm run ai:set-extension-id
```

## 8b. Live scoring (no synthetic fixture)

Same `TEE_INTERNAL_TOKEN` in `fce-matching-engine/.env`, `fce-ai-agent/.env`, and Vercel.

Matching (picks up `127.0.0.1:7702` + token — does **not** mint a new teeId):

```bash
cd fce-matching-engine
# add TEE_INTERNAL_TOKEN=mirror-coston2-tee-internal to .env if missing
docker compose -p tunnel up -d
```

AI (rebuild so SCORE_V1 fetches the log):

```bash
cd fce-ai-agent
# MATCHING_ENGINE_PRIVATE_LOG_URL=http://host.docker.internal:7702
# MIRROR_OUTCOME_LOG_URL=https://YOUR-VERCEL-APP.vercel.app/api/outcomes
# SYNTHETIC_OUTCOME_FIXTURE must be unset
./scripts/start-services.sh --chain coston2 --tunnel
```

Do **not** run matching `post-build.sh` or `setExtensionId` on `0xf082…`.

## 9. SCORE_V1 canary

```bash
AI_AGENT_SENDER=0x<AI_AGENT_SENDER> \
AI_EXT_PROXY_URL=https://<ai-trycloudflare-host> \
npm run ai:score-v1-tee
```

Expect SAY_HELLO `greetingNumber >= 1` and SCORE_V1 `status=1` with a numeric `score`.

## 10. Hand back

Keep matching UI pubkey as the **matching** TEE `/info` key. Paste:

- `AI_AGENT_SENDER`
- AI `EXTENSION_ID`
- AI tunnel URL
