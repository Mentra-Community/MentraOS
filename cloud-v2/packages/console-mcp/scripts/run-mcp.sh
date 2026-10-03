#!/usr/bin/env bash
# MCP uses stdin/stdout for JSON-RPC — do NOT source .zshrc (prints break the protocol).
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

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

read_env_from_zshrc MENTRA_ADMIN_TOKEN
read_env_from_zshrc MENTRA_CORE_URL
read_env_from_zshrc MENTRA_ENV

# Cursor spawns MCP with a minimal PATH; resolve bun explicitly.
BUN="${BUN:-$(command -v bun 2>/dev/null)}"
if [[ -z "$BUN" && -x "${HOME}/.bun/bin/bun" ]]; then
  BUN="${HOME}/.bun/bin/bun"
fi
if [[ -z "$BUN" ]]; then
  echo "mentra-console-mcp: bun not found (install https://bun.sh or set BUN=...)" >&2
  exit 127
fi

# Cursor's spawn cwd is the MentraOS workspace. bun then walks up to the root
# lockfile and misses a package-local install. Keep deps in this directory and
# force that resolution path.
if [[ ! -f node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js ]]; then
  echo "mentra-console-mcp: installing @modelcontextprotocol/sdk into $ROOT" >&2
  "$BUN" install --cwd "$ROOT" >&2
fi
export NODE_PATH="$ROOT/node_modules${NODE_PATH:+:$NODE_PATH}"

exec "$BUN" --cwd "$ROOT" "$ROOT/src/index.ts"
