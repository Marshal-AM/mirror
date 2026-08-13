#!/usr/bin/env bash
# Production vault-fill worker. Runs on the FCC VM next to matching proxy:6674.
# Vercel only submits Stage B; this process calls executeMatch.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi
if [[ -f "$ROOT/fce-matching-engine/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/fce-matching-engine/.env"
  set +a
fi
export PATH="${PATH}:/usr/local/go/bin:${HOME}/.local/bin"
export EXT_PROXY_URL="${EXT_PROXY_URL:-http://127.0.0.1:6674}"
export DEPLOYER_PRIVATE_KEY="${DEPLOYER_PRIVATE_KEY:-${DEPLOYMENT_PRIVATE_KEY:-}}"
export FLARE_RPC_URL="${FLARE_RPC_URL:-${CHAIN_URL:-https://coston2-api.flare.network/ext/C/rpc}}"

if [[ -z "${DEPLOYER_PRIVATE_KEY:-}" ]]; then
  echo "DEPLOYER_PRIVATE_KEY / DEPLOYMENT_PRIVATE_KEY missing" >&2
  exit 1
fi

pkill -f "relayer/execute-match-from-tee.ts" 2>/dev/null || true
docker rm -f mirror-fill-worker 2>/dev/null || true

if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  nohup npm run tee:execute-match -w scripts >> /tmp/fill-worker.log 2>&1 &
  echo "fill-worker host-node pid $!  log /tmp/fill-worker.log  proxy $EXT_PROXY_URL"
  sleep 2
  tail -n 20 /tmp/fill-worker.log || true
  exit 0
fi

echo "node not on PATH — starting fill-worker in Docker (host network → :6674)"
docker rm -f mirror-fill-worker 2>/dev/null || true
docker run -d --restart unless-stopped --name mirror-fill-worker --network host \
  -v "$ROOT:/app" \
  -w /app \
  -e EXT_PROXY_URL="$EXT_PROXY_URL" \
  -e DEPLOYER_PRIVATE_KEY="$DEPLOYER_PRIVATE_KEY" \
  -e FLARE_RPC_URL="$FLARE_RPC_URL" \
  -e FILL_LOOKBACK_BLOCKS="${FILL_LOOKBACK_BLOCKS:-400}" \
  node:22-bookworm \
  bash -lc "cd /app/scripts && npm install --omit=dev && npx tsx relayer/execute-match-from-tee.ts"
echo "container mirror-fill-worker"
sleep 8
docker logs --tail 30 mirror-fill-worker || true
