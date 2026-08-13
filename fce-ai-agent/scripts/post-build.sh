#!/usr/bin/env bash
# Register TEE version + machine for the AI-agent extension only.
#
# Sources fce-ai-agent/.env + fce-ai-agent/config/extension.env.
# Uses matching-engine/tools as a read-only Go CLI.
# Writes state to fce-ai-agent/config/register-tee.state.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$PROJECT_DIR/.." && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${GREEN}[post-build]${NC} $*"; }
step() { echo -e "\n${CYAN}=== Step $1: $2 ===${NC}"; }
die()  { echo -e "${RED}[post-build] ERROR:${NC} $*" >&2; exit 1; }

# shellcheck source=lib/guard.sh
source "$SCRIPT_DIR/lib/guard.sh"
assert_ai_agent_project "$PROJECT_DIR"

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

assert_not_matching_sender "${INSTRUCTION_SENDER:-}"
assert_not_matching_extension "${EXTENSION_ID:-}"

if [[ -z "${EXT_PROXY_URL:-}" ]]; then
    EXT_PROXY_URL="http://localhost:6684"
fi
NORMAL_PROXY_URL="${NORMAL_PROXY_URL:-https://tee-proxy-coston2-1.flare.rocks}"
CHAIN_URL="${CHAIN_URL:-https://coston2-api.flare.network/ext/C/rpc}"
TEE_VERSION="${TEE_VERSION:-v0.1.0-ai}"
WAIT_TIMEOUT="${WAIT_TIMEOUT:-120}"
LOCAL_MODE="${LOCAL_MODE:-false}"

ADDRESSES_FILE="${ADDRESSES_FILE:-$PROJECT_DIR/config/coston2/deployed-addresses.json}"
if [[ "$ADDRESSES_FILE" != /* ]]; then
    ADDRESSES_FILE="$PROJECT_DIR/$ADDRESSES_FILE"
fi
[[ -f "$ADDRESSES_FILE" ]] || die "addresses file not found: $ADDRESSES_FILE"
ADDRESSES_FILE="$(cd "$(dirname "$ADDRESSES_FILE")" && pwd)/$(basename "$ADDRESSES_FILE")"

TOOLS_DIR="${FCC_TOOLS_DIR:-$REPO_ROOT/fce-matching-engine/tools}"
[[ -d "$TOOLS_DIR" ]] || die "FCC tools not found at $TOOLS_DIR"

STATE_FILE="$PROJECT_DIR/config/register-tee.state"
assert_not_matching_path "$STATE_FILE"

[[ -n "${DEPLOYMENT_PRIVATE_KEY:-}" ]] || die "DEPLOYMENT_PRIVATE_KEY not set"

log "Extension proxy: $EXT_PROXY_URL"
log "Normal proxy:    $NORMAL_PROXY_URL"
log "Chain URL:       $CHAIN_URL"
log "TEE version:     $TEE_VERSION"
log "Tools (read):    $TOOLS_DIR"
log "State file:      $STATE_FILE"

wait_for_url() {
    local url="$1"
    local label="${2:-$url}"
    local timeout="${3:-$WAIT_TIMEOUT}"
    local interval=2
    local elapsed=0

    log "Waiting for $label ($url) ..."
    while ! curl -sf -o /dev/null "$url" 2>/dev/null; do
        elapsed=$((elapsed + interval))
        if [[ $elapsed -ge $timeout ]]; then
            die "Timed out after ${timeout}s waiting for $label"
        fi
        sleep "$interval"
    done
    log "$label is ready"
}

wait_for_url "$EXT_PROXY_URL/info" "AI extension proxy"
wait_for_url "$NORMAL_PROXY_URL/info" "Normal proxy"

cd "$TOOLS_DIR"

step 1 "Allow TEE version (AI extension)"
go run ./cmd/allow-tee-version \
    -a "$ADDRESSES_FILE" \
    -c "$CHAIN_URL" \
    -p "$EXT_PROXY_URL" \
    -version "$TEE_VERSION" \
    || die "Allow TEE version failed"

step 2 "Set TEE governance"
go run ./cmd/set-governance \
    -a "$ADDRESSES_FILE" \
    -c "$CHAIN_URL" \
    -p "$EXT_PROXY_URL" \
    || die "Set TEE governance failed"

export SIMULATED_TEE="${SIMULATED_TEE:-true}"
log "Simulated TEE: $SIMULATED_TEE"

step 3 "Register TEE machine"
go run ./cmd/register-tee \
    -a "$ADDRESSES_FILE" \
    -c "$CHAIN_URL" \
    -p "$EXT_PROXY_URL" \
    -h "${EXT_PROXY_HOST_URL:-$EXT_PROXY_URL}" \
    -ep "$NORMAL_PROXY_URL" \
    -state "$STATE_FILE" \
    -command "${REGISTER_TEE_COMMAND:-rRap}" \
    || die "Register TEE failed"

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN} AI-agent post-build complete${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo "  Next — latch extension id on the NEW sender only:"
echo "    AI_AGENT_SENDER=${INSTRUCTION_SENDER:-<sender>} npm run ai:set-extension-id"
echo ""
echo "  Do NOT call setExtensionId on 0xf082D53B50D08f0fdC06B0B4C6A1932DB589d91f"
