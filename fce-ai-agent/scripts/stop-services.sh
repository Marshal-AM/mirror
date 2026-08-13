#!/usr/bin/env bash
#
# Stop the AI-agent FCC stack only.
# Never stops matching-engine compose or compose project `tunnel`.
#
#   ./scripts/stop-services.sh --chain coston2
#   ./scripts/stop-services.sh --chain coston2 --tunnel   # also stop tunnel-ai
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; NC='\033[0m'
log()  { echo -e "${GREEN}[stop-services]${NC} $*"; }
die()  { echo -e "${RED}[stop-services] ERROR:${NC} $*" >&2; exit 1; }

# shellcheck source=lib/guard.sh
source "$SCRIPT_DIR/lib/guard.sh"
assert_ai_agent_project "$PROJECT_DIR"

USE_TUNNEL=false
CHAIN="${CHAIN:-}"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --local) die "--local is not supported for the AI-agent FCE" ;;
        --tunnel) USE_TUNNEL=true; shift ;;
        --chain) [[ $# -ge 2 ]] || die "--chain requires a value (local|coston2)"
                 CHAIN="$2"; shift 2 ;;
        --chain=*) CHAIN="${1#--chain=}"; shift ;;
        *) die "Unknown argument: $1" ;;
    esac
done

if [[ -f "$PROJECT_DIR/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$PROJECT_DIR/.env"
    set +a
fi

LOCAL_MODE="${LOCAL_MODE:-false}"
if [[ -z "$CHAIN" ]]; then
    [[ "$LOCAL_MODE" == "true" ]] && CHAIN="local" || CHAIN="coston2"
fi
case "$CHAIN" in
    local|coston2) ;;
    *) die "Unknown --chain value: $CHAIN (valid: local, coston2)" ;;
esac

COMPOSE_FILES=("-f" "$PROJECT_DIR/docker-compose.yaml")
[[ "$CHAIN" == "coston2" ]] && COMPOSE_FILES+=("-f" "$PROJECT_DIR/docker-compose.coston2.yaml")

export SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-0}"
export COMPOSE_NETWORK="${COMPOSE_NETWORK:-extension-scaffold-ai-agent}"

log "Stopping AI-agent Docker Compose (chain: $CHAIN)..."
docker compose "${COMPOSE_FILES[@]}" down

CF_COMPOSE="$PROJECT_DIR/docker-compose.cloudflared.yaml"
CF_PROJ=(-p tunnel-ai)
if [[ -f "$CF_COMPOSE" ]]; then
    if [[ "$USE_TUNNEL" == "true" ]]; then
        if docker compose "${CF_PROJ[@]}" -f "$CF_COMPOSE" ps -q cloudflared 2>/dev/null | grep -q .; then
            log "Stopping tunnel-ai only (matching 'tunnel' is untouched)..."
            docker compose "${CF_PROJ[@]}" -f "$CF_COMPOSE" down || log "WARNING: failed to stop tunnel-ai"
        else
            log "No tunnel-ai running — nothing to stop."
        fi
    elif docker compose "${CF_PROJ[@]}" -f "$CF_COMPOSE" ps -q cloudflared 2>/dev/null | grep -q .; then
        log "Leaving tunnel-ai running (pass --tunnel to stop it)."
    fi
fi

log "Done. Matching-engine stack was not touched."
