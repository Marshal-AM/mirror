#!/usr/bin/env bash
#
# Start the AI-agent FCC stack (Docker Compose only).
#
# Isolated from fce-matching-engine:
#   ports 6683/6684, Redis 6383, network extension-scaffold-ai-agent,
#   cloudflared project tunnel-ai.
#
# Usage:
#   ./scripts/start-services.sh --chain coston2 --tunnel
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${GREEN}[start-services]${NC} $*"; }
die()  { echo -e "${RED}[start-services] ERROR:${NC} $*" >&2; exit 1; }

# shellcheck source=lib/guard.sh
source "$SCRIPT_DIR/lib/guard.sh"
assert_ai_agent_project "$PROJECT_DIR"

USE_TUNNEL=false
CHAIN="${CHAIN:-}"
while [[ $# -gt 0 ]]; do
    case "$1" in
        --local) die "--local is not supported for the AI-agent FCE (TypeScript). Use Docker Compose." ;;
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

CONFIG_FILE="$PROJECT_DIR/config/extension.env"
if [[ -f "$CONFIG_FILE" ]]; then
    assert_not_matching_path "$CONFIG_FILE"
    # shellcheck disable=SC1090
    source "$CONFIG_FILE"
fi

EXTENSION_ID="${EXTENSION_ID:-}"
PROXY_PRIVATE_KEY="${PROXY_PRIVATE_KEY:-983760a4ebf75b2ac3a93531168a0f225d01e5dc6e3568adbd46233ba1fb4fa4}"
LOCAL_MODE="${LOCAL_MODE:-false}"
LANGUAGE="${LANGUAGE:-typescript}"

if [[ -z "$CHAIN" ]]; then
    if [[ "$LOCAL_MODE" == "true" ]]; then
        CHAIN="local"
    else
        CHAIN="coston2"
    fi
fi
case "$CHAIN" in
    local|coston2) ;;
    coston) die "AI-agent FCE is Coston2-only (got --chain coston)" ;;
    *) die "Unknown --chain value: $CHAIN (valid: local, coston2)" ;;
esac

[[ -n "$EXTENSION_ID" ]] || die "EXTENSION_ID not set. Run ./scripts/pre-register.sh first."
assert_not_matching_extension "$EXTENSION_ID"
assert_not_matching_sender "${INSTRUCTION_SENDER:-}"

# shellcheck source=lib/language.sh
source "$SCRIPT_DIR/lib/language.sh"
load_language "$PROJECT_DIR" || die "could not resolve LANGUAGE"

# shellcheck source=lib/versions.sh
source "$SCRIPT_DIR/lib/versions.sh"
load_versions "$PROJECT_DIR" || die "could not derive dependency versions"

log "Chain:          $CHAIN"
log "Language:       $LANGUAGE ($EXTENSION_DOCKERFILE)"
log "Extension ID:   $EXTENSION_ID"
log "tee-node ref:   $TEE_NODE_REF"
log "Tunnel project: tunnel-ai (never 'tunnel')"

# Always isolate from matching-engine's compose project `tunnel`.
TUNNEL_ACTIVE=false
sync_tunnel() {
    local cf_compose="$PROJECT_DIR/docker-compose.cloudflared.yaml"
    [[ -f "$cf_compose" ]] || die "$cf_compose not found"
    local -a proj=(-p tunnel-ai)
    export TUNNEL_TARGET="${TUNNEL_TARGET:-http://host.docker.internal:6684}"

    if docker compose "${proj[@]}" -f "$cf_compose" ps -q cloudflared 2>/dev/null | grep -q .; then
        log "AI Cloudflare tunnel already running — reusing tunnel-ai."
    elif [[ "$USE_TUNNEL" == "true" ]]; then
        docker compose "${proj[@]}" -f "$cf_compose" up -d || die "Failed to start tunnel-ai"
    else
        log "NOTE: no tunnel-ai running and --tunnel not passed — EXT_PROXY_URL must already be reachable."
        return
    fi
    TUNNEL_ACTIVE=true

    if [[ -n "${TUNNEL_ARGS:-}" ]]; then
        log "Named tunnel up — keeping EXT_PROXY_URL=${EXT_PROXY_URL:-<unset>}"
        return
    fi

    local cid started
    local -a since=()
    cid=$(docker compose "${proj[@]}" -f "$cf_compose" ps -q cloudflared 2>/dev/null | head -1 || true)
    started=$(docker inspect -f '{{.State.StartedAt}}' "$cid" 2>/dev/null | cut -c1-19 || true)
    [[ -n "$started" ]] && since=(--since "${started}Z")

    log "Reading the tunnel-ai quick-tunnel URL..."
    local url="" i
    for ((i = 0; i < 30; i++)); do
        url=$(docker compose "${proj[@]}" -f "$cf_compose" logs "${since[@]}" cloudflared 2>/dev/null \
              | grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' | tail -1 || true)
        [[ -n "$url" ]] && break
        sleep 1
    done
    [[ -n "$url" ]] || die "tunnel-ai printed no *.trycloudflare.com URL within 30s.\n  Check: docker compose -p tunnel-ai -f $cf_compose logs cloudflared"

    export EXT_PROXY_URL="$url"
    if [[ -f "$PROJECT_DIR/.env" ]]; then
        assert_not_matching_path "$PROJECT_DIR/.env"
        if grep -q '^EXT_PROXY_URL=' "$PROJECT_DIR/.env"; then
            sed -i.bak "s|^EXT_PROXY_URL=.*|EXT_PROXY_URL=$url|" "$PROJECT_DIR/.env"
            rm -f "$PROJECT_DIR/.env.bak"
        else
            echo "EXT_PROXY_URL=$url" >> "$PROJECT_DIR/.env"
        fi
        log "AI tunnel URL: $url  (written to fce-ai-agent/.env only)"
    else
        log "AI tunnel URL: $url  (no .env to update)"
    fi
}

if [[ "$CHAIN" != "local" ]]; then
    sync_tunnel
fi

log "Starting AI-agent services with Docker Compose..."

if [[ -z "${SOURCE_DATE_EPOCH:-}" ]]; then
    if SOURCE_DATE_EPOCH=$(git -C "$PROJECT_DIR" log -1 --format=%ct 2>/dev/null) && [[ -n "$SOURCE_DATE_EPOCH" ]]; then
        export SOURCE_DATE_EPOCH
    else
        export SOURCE_DATE_EPOCH=0
    fi
fi
log "SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH"

if grep -q 'tee-node-base' "$PROJECT_DIR/$EXTENSION_DOCKERFILE" 2>/dev/null; then
    log "Language '$LANGUAGE' needs the shared tee-node base image"
    "$SCRIPT_DIR/build-node-base.sh" || die "failed to build tee-node base image"
fi

if [[ -z "${REGISTRY:-}" ]]; then
    if ! docker image inspect local/tee-proxy >/dev/null 2>&1; then
        PROXY_DOCKERFILE="$PROJECT_DIR/proxy/Dockerfile"
        [[ -f "$PROXY_DOCKERFILE" ]] || die "Image local/tee-proxy not found and $PROXY_DOCKERFILE missing"
        log "Building local/tee-proxy from $PROXY_DOCKERFILE..."
        docker build -f "$PROXY_DOCKERFILE" -t local/tee-proxy "$PROJECT_DIR/proxy" || die "Failed to build tee-proxy image"
    else
        log "local/tee-proxy already exists — reusing (will not rebuild matching images)"
    fi
fi

COMPOSE_FILES=("-f" "$PROJECT_DIR/docker-compose.yaml")
if [[ "$CHAIN" == "coston2" ]]; then
    COMPOSE_FILES+=("-f" "$PROJECT_DIR/docker-compose.coston2.yaml")
fi

if [[ "$CHAIN" == "local" ]]; then
    PROXY_CFG="extension_proxy.docker.toml"
else
    PROXY_CFG="extension_proxy.$CHAIN.docker.toml"
fi
if [[ -d "$PROJECT_DIR/config/proxy/$PROXY_CFG" ]]; then
    die "config/proxy/$PROXY_CFG is a directory — docker created it when the file was missing.\n  rm -rf config/proxy/$PROXY_CFG && cp config/proxy/$PROXY_CFG.example config/proxy/$PROXY_CFG"
elif [[ ! -f "$PROJECT_DIR/config/proxy/$PROXY_CFG" ]]; then
    die "config/proxy/$PROXY_CFG not found.\n  cp config/proxy/$PROXY_CFG.example config/proxy/$PROXY_CFG   # then fill in the [db] credentials"
fi

export REDIS_BIND="${REDIS_BIND:-127.0.0.1:6383}"
export EXT_PROXY_INTERNAL_BIND="${EXT_PROXY_INTERNAL_BIND:-0.0.0.0:6683}"
export EXT_PROXY_EXTERNAL_BIND="${EXT_PROXY_EXTERNAL_BIND:-0.0.0.0:6684}"
export COMPOSE_NETWORK="${COMPOSE_NETWORK:-extension-scaffold-ai-agent}"

docker compose "${COMPOSE_FILES[@]}" up -d --build || die "docker compose up failed"

E2E="$SCRIPT_DIR/e2e.sh"
LOCAL_INFO="http://localhost:6684"
log "Waiting for AI extension proxy at $LOCAL_INFO/info ..."
"$E2E" wait-for-url "$LOCAL_INFO/info" 120

EXT_PROXY_URL="${EXT_PROXY_URL:-$LOCAL_INFO}"
log "Validating EXTENSION_ID against proxy..."
PROXY_INFO=$(curl -sf "$EXT_PROXY_URL/info" 2>/dev/null || curl -sf "$LOCAL_INFO/info" 2>/dev/null || true)
if [[ -n "$PROXY_INFO" ]]; then
    if ! echo "$PROXY_INFO" | grep -q "$EXTENSION_ID" 2>/dev/null; then
        echo -e "${RED}WARNING: EXTENSION_ID $EXTENSION_ID not found in proxy /info response${NC}" >&2
    fi
fi

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN} AI-agent services started${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "  Compose project:  fce-ai-agent"
echo "  Network:          $COMPOSE_NETWORK"
echo "  Ports:            6683 / 6684  Redis 6383"
echo "  Proxy URL:        $EXT_PROXY_URL"
[[ "$TUNNEL_ACTIVE" == "true" ]] && echo "  Tunnel:           tunnel-ai"
echo ""
echo "  Logs:  docker compose ${COMPOSE_FILES[*]} logs -f"
echo "  Stop:  ./scripts/stop-services.sh --chain $CHAIN"
[[ "$TUNNEL_ACTIVE" == "true" ]] && echo "  Stop tunnel-ai only: ./scripts/stop-services.sh --chain $CHAIN --tunnel"
echo ""
echo "  Matching TEE must still be running on :6674 / compose project tunnel."
