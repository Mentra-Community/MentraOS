#!/usr/bin/env bash
# MCP uses stdin/stdout for JSON-RPC — do NOT source .zshrc (prints break the protocol).
cd "$(dirname "$0")/.."

export MENTRA_API_HOST="${MENTRA_API_HOST:-https://api.mentra.glass}"

read_env_from_zshrc() {
  local key="$1"
  [[ -n "${!key:-}" ]] && return
  [[ ! -f "$HOME/.zshrc" ]] && return
  local line
  line=$(grep -E "^export ${key}=" "$HOME/.zshrc" 2>/dev/null | tail -1) || return
  local val="${line#export ${key}=}"
  val="${val%\"}"
  val="${val#\"}"
  val="${val%\'}"
  val="${val#\'}"
  [[ -n "$val" ]] && export "$key=$val"
}

read_env_from_zshrc MENTRA_AGENT_API_KEY
read_env_from_zshrc MENTRA_CLI_TOKEN
read_env_from_zshrc MENTRA_ADMIN_JWT
read_env_from_zshrc MENTRA_ADMIN_TOKEN

# Cursor spawns MCP with a minimal PATH; resolve bun explicitly.
BUN="${BUN:-$(command -v bun 2>/dev/null)}"
if [[ -z "$BUN" && -x "${HOME}/.bun/bin/bun" ]]; then
  BUN="${HOME}/.bun/bin/bun"
fi
if [[ -z "$BUN" ]]; then
  echo "mentra-console-mcp: bun not found (install https://bun.sh or set BUN=...)" >&2
  exit 127
fi

exec "$BUN" run src/index.ts
