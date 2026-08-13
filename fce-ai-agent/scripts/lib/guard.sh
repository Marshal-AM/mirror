#!/usr/bin/env bash
# Isolation guards — never touch the matching-engine FCC stack.
#
# Sourced by fce-ai-agent scripts. Not executable on its own.

MATCHING_SENDER_FORBIDDEN="0xf082d53b50d08f0fdc06b0b4c6a1932db589d91f"
MATCHING_EXTENSION_FORBIDDEN="0x000000000000000000000000000000000000000000000000000000000001028b"

_guard_die() {
    echo -e "${RED:-}[fce-ai-agent] ERROR:${NC:-} $*" >&2
    exit 1
}

assert_ai_agent_project() {
    local dir="${1:?assert_ai_agent_project requires PROJECT_DIR}"
    local base
    base="$(basename "$dir")"
    [[ "$base" == "fce-ai-agent" ]] || _guard_die "must run from fce-ai-agent (got '$base' at $dir). Matching-engine scripts stay in fce-matching-engine."
}

assert_not_matching_path() {
    local path="${1:?path required}"
    case "$path" in
        *fce-matching-engine*)
            _guard_die "refusing to write matching-engine path: $path"
            ;;
    esac
}

assert_not_matching_sender() {
    local addr
    addr="$(echo "${1:-}" | tr 'A-Z' 'a-z')"
    [[ -n "$addr" ]] || return 0
    [[ "$addr" != "$MATCHING_SENDER_FORBIDDEN" ]] || _guard_die "refusing matching-engine InstructionSender $1 — deploy a new AiAgentSender"
}

assert_not_matching_extension() {
    local id
    id="$(echo "${1:-}" | tr 'A-Z' 'a-z')"
    [[ -n "$id" ]] || return 0
    # 66187 = 0x1028b
    [[ "$id" != "$MATCHING_EXTENSION_FORBIDDEN" ]] || _guard_die "refusing matching-engine extension id $1 (66187 / 0x1028b)"
    [[ "$id" != "0x1028b" ]] || _guard_die "refusing matching-engine extension id $1"
    [[ "$id" != "66187" ]] || _guard_die "refusing matching-engine extension id $1"
}
