#!/usr/bin/env bash
# scripts/dev-down.sh — tear down what dev-up.sh started
# Leaves Supabase + unrelated containers + your Terminal alone.

set -euo pipefail

ROOT="/Users/hiyabuddy/sites/brendancopley/MentraOS"
CLOUD="$ROOT/cloud"
CLOUD_COMPOSE="$CLOUD/docker-compose.dev.yml"
SESSION="mentraos"

# Ports (must match dev-up.sh)
CAMERA_PORT=3300
METRO_PORT=8081
CONSOLE_PORT=5173
ACCOUNT_PORT=8052
STORE_PORT=5174

# Reserved zrok share tokens started by dev-up.sh (must match dev-up.sh ZROK_SHARES tokens)
ZROK_TOKENS=(mentracloud mentrayolo mentrametro mentrasupabase)

log() { printf '\033[1;36m→\033[0m %s\n' "$*"; }
ok()  { printf '\033[1;32m✓\033[0m %s\n' "$*"; }

# Killing the tmux session SIGHUPs every pane process (zrok, camera bun, metro bun, docker logs).
if command -v tmux >/dev/null 2>&1 && tmux has-session -t "$SESSION" 2>/dev/null; then
  log "Killing tmux session '$SESSION' (kills all pane processes)..."
  tmux kill-session -t "$SESSION" || true
else
  log "No tmux session '$SESSION' to kill."
fi

# Belt-and-suspenders: kill anything still bound to the foreground ports.
# Skip Docker-owned listeners — those belong to other projects and Docker would just respawn them.
log "Killing any lingering zrok shares / port holders..."
for token in "${ZROK_TOKENS[@]}"; do
  pkill -f "zrok share reserved $token" 2>/dev/null || true
done
for port in "$CAMERA_PORT" "$METRO_PORT" "$CONSOLE_PORT" "$ACCOUNT_PORT" "$STORE_PORT"; do
  pid=$(lsof -ti :"$port" -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$pid" ]; then
    pname=$(ps -o comm= -p "$pid" 2>/dev/null || true)
    case "$pname" in
      *com.docker*|*Docker*|*docker-proxy*) ;;  # leave Docker alone
      *) kill "$pid" 2>/dev/null || true ;;
    esac
  fi
done

log "Stopping MentraOS cloud Docker stack..."
(cd "$CLOUD" && docker compose -f "$CLOUD_COMPOSE" -p dev down --timeout 5) || true

ok "Done. Supabase + other-project containers untouched."
