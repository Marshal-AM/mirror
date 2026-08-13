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
pkill -f "relayer/execute-match-from-tee.ts" 2>/dev/null || true
sleep 1
nohup npm run tee:execute-match -w scripts >> /tmp/fill-worker.log 2>&1 &
echo "fill-worker pid $!  log /tmp/fill-worker.log  proxy $EXT_PROXY_URL"
sleep 2
tail -n 20 /tmp/fill-worker.log || true
