#!/usr/bin/env bash
# scripts/dev-up.sh — bring up the MentraOS dev stack in a tmux split-screen session
#
# Persistent (Docker, idempotent):
#   • MentraOS cloud (docker-compose.dev.yml)    → :8002, :8000/udp
#
# Assumes Supabase is started by your separate script.
#
# tmux session "mentraos" with two windows:
#
#   window "stack" (7 panes tiled):
#     • cloud logs (docker tail)
#     • camera app                  → :3300
#     • metro / expo                → :8081
#     • zrok mentracloud            → :8002
#     • zrok mentrayolo             → :3300
#     • zrok mentrametro            → :8081
#     • zrok mentrasupabase         → :8000
#
#   window "websites" (3 panes tiled):
#     • developer console           → :5173
#     • account portal              → :8052
#     • app store                   → :5174
#
# Reserved zrok shares are auto-created on first run (via `zrok reserve public`).
# After that, the share tokens are stable across runs.
#
# Attach with:  tmux attach -t mentraos
# Switch windows: Ctrl-b 0 (stack)  /  Ctrl-b 1 (websites)
# Detach with:  Ctrl-b d
# Tear down with: scripts/dev-down.sh

set -euo pipefail

# ───────── Paths ─────────
ROOT="/Users/hiyabuddy/sites/brendancopley/MentraOS"
CLOUD="$ROOT/cloud"
MOBILE="$ROOT/mobile"
CAMERA="/Users/hiyabuddy/sites/brendancopley/MentraOS-Camera-Example-App"
CONSOLE="$CLOUD/websites/console"
ACCOUNT="$CLOUD/websites/account"
STORE="$CLOUD/websites/store"

CLOUD_COMPOSE="$CLOUD/docker-compose.dev.yml"
SESSION="mentraos"
WINDOW="stack"
WEB_WINDOW="websites"

# ───────── Ports ─────────
CLOUD_PORT=8002
CAMERA_PORT=3300
METRO_PORT=8081
SUPABASE_PORT=8000

# Vite dev servers for the cloud-side web portals. Console and store both
# default to 5173, so we pin store to 5174 to avoid the collision and pass
# --port explicitly everywhere so the script is the source of truth.
CONSOLE_PORT=5173
ACCOUNT_PORT=8052
STORE_PORT=5174

# ───────── Reserved zrok shares (single source of truth: token → host port) ─────────
# Order: cloud, camera, metro, supabase
ZROK_SHARES=(
  "mentracloud:$CLOUD_PORT"
  "mentrayolo:$CAMERA_PORT"
  "mentrametro:$METRO_PORT"
  "mentrasupabase:$SUPABASE_PORT"
)

# ───────── Helpers ─────────
log() { printf '\033[1;36m→\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; }
ok()  { printf '\033[1;32m✓\033[0m %s\n' "$*"; }

require() {
  command -v "$1" >/dev/null 2>&1 || { err "Missing dependency: $1"; exit 1; }
}

# Send a command into a specific tmux pane (by stable pane-id like %0) and press Enter.
# Usage: tsend <pane-id> "<command>"
tsend() {
  local pane="$1"
  local cmd="$2"
  tmux send-keys -t "$pane" "$cmd" C-m
}

# Idempotently reserve a zrok public share with a stable share token (--unique-name).
# If the share token already appears in `zrok overview`, no-op. Otherwise reserve it.
# Usage: ensure_reserved_share <token> <port>
ensure_reserved_share() {
  local token="$1" port="$2"
  if zrok overview 2>/dev/null | grep -q "\"shareToken\":\"$token\""; then
    return 0
  fi
  log "Reserving zrok share '$token' → http://localhost:$port (one-time)..."
  if ! zrok reserve public "http://localhost:$port" --backend-mode proxy --unique-name "$token" >/dev/null; then
    err "Failed to reserve zrok share '$token'. Is zrok enabled? Try: zrok enable <token-from-zrok.io>"
    exit 1
  fi
  ok "Reserved '$token'."
}

# ───────── Preflight ─────────
require docker
require bun
require zrok
require tmux

if ! docker info >/dev/null 2>&1; then
  err "Docker daemon not running — start Docker Desktop and re-run."
  exit 1
fi

# ───────── Existing tmux session? ─────────
if tmux has-session -t "$SESSION" 2>/dev/null; then
  err "tmux session '$SESSION' already exists. Run scripts/dev-down.sh first, or attach with: tmux attach -t $SESSION"
  exit 1
fi

# ───────── Ensure all reserved zrok shares exist (idempotent) ─────────
log "Checking reserved zrok shares..."
for entry in "${ZROK_SHARES[@]}"; do
  token="${entry%%:*}"
  port="${entry##*:}"
  ensure_reserved_share "$token" "$port"
done

# ───────── Persistent services (idempotent Docker) ─────────
log "MentraOS cloud: docker compose up -d"
(cd "$CLOUD" && docker compose -f "$CLOUD_COMPOSE" -p dev up -d --remove-orphans) >/dev/null

# ───────── Clean up stale foreground processes ─────────
log "Killing any lingering zrok shares / camera / metro processes..."
for entry in "${ZROK_SHARES[@]}"; do
  token="${entry%%:*}"
  pkill -f "zrok share reserved $token" 2>/dev/null || true
done
# Also free the host ports for the foreground dev servers (skip Docker-owned
# listeners — they belong to other projects).
for port in "$CAMERA_PORT" "$METRO_PORT" "$CONSOLE_PORT" "$ACCOUNT_PORT" "$STORE_PORT"; do
  pid=$(lsof -ti :"$port" -sTCP:LISTEN 2>/dev/null || true)
  if [ -n "$pid" ]; then
    pname=$(ps -o comm= -p "$pid" 2>/dev/null || true)
    case "$pname" in
      *com.docker*|*Docker*|*docker-proxy*)
        err "Port $port is held by Docker ($pname, pid $pid). Refusing to kill — find the offending container with: docker ps --format 'table {{.Names}}\\t{{.Ports}}' | grep :$port  then 'docker stop <name>' or remap its host port."
        exit 1
        ;;
      *)
        kill "$pid" 2>/dev/null || true
        ;;
    esac
  fi
done
sleep 1

# ───────── tmux layout (using stable %-prefixed pane IDs, index-config-agnostic) ─────────
log "Creating tmux session '$SESSION'..."
tmux new-session -d -s "$SESSION" -n "$WINDOW" -x 240 -y 70

# Capture the initial pane's stable ID
P0=$(tmux list-panes -t "$SESSION:$WINDOW" -F '#{pane_id}' | head -1)

# Pane 0 (initial): cloud logs
tsend "$P0" "clear; echo '── cloud logs ──'; docker compose -f '$CLOUD_COMPOSE' -p dev logs -f --tail=50 cloud"

# Pane 1: camera app
P1=$(tmux split-window -h -t "$P0" -P -F '#{pane_id}')
tsend "$P1" "clear; echo '── camera app → :$CAMERA_PORT ──'; cd '$CAMERA' && bun run dev"

# Pane 2: metro / expo
P2=$(tmux split-window -h -t "$P1" -P -F '#{pane_id}')
tsend "$P2" "clear; echo '── metro / expo → :$METRO_PORT ──'; cd '$MOBILE' && bun expo start --dev-client --port $METRO_PORT"

# Pane 3: zrok mentracloud → :8002
P3=$(tmux split-window -v -t "$P0" -P -F '#{pane_id}')
tsend "$P3" "clear; echo '── zrok mentracloud → :$CLOUD_PORT ──'; zrok share reserved mentracloud --headless"

# Pane 4: zrok mentrayolo → :3300
P4=$(tmux split-window -v -t "$P1" -P -F '#{pane_id}')
tsend "$P4" "clear; echo '── zrok mentrayolo → :$CAMERA_PORT ──'; zrok share reserved mentrayolo --headless"

# Pane 5: zrok mentrametro → :8081
P5=$(tmux split-window -v -t "$P2" -P -F '#{pane_id}')
tsend "$P5" "clear; echo '── zrok mentrametro → :$METRO_PORT ──'; zrok share reserved mentrametro --headless"

# Pane 6: zrok mentrasupabase → :8000
P6=$(tmux split-window -v -t "$P3" -P -F '#{pane_id}')
tsend "$P6" "clear; echo '── zrok mentrasupabase → :$SUPABASE_PORT ──'; zrok share reserved mentrasupabase --headless"

# Tile evenly so all 7 panes are visible; focus on cloud logs
tmux select-layout -t "$SESSION:$WINDOW" tiled
tmux select-pane -t "$P0"

# ───────── Second window: cloud-side web portals (console / account / store) ─────────
log "Adding 'websites' window for console / account / store..."
tmux new-window -d -t "$SESSION:" -n "$WEB_WINDOW"

W0=$(tmux list-panes -t "$SESSION:$WEB_WINDOW" -F '#{pane_id}' | head -1)
tsend "$W0" "clear; echo '── developer console → :$CONSOLE_PORT ──'; cd '$CONSOLE' && bun run dev -- --port $CONSOLE_PORT --strictPort"

W1=$(tmux split-window -h -t "$W0" -P -F '#{pane_id}')
tsend "$W1" "clear; echo '── account portal → :$ACCOUNT_PORT ──'; cd '$ACCOUNT' && bun run dev -- --port $ACCOUNT_PORT --strictPort"

W2=$(tmux split-window -h -t "$W1" -P -F '#{pane_id}')
tsend "$W2" "clear; echo '── app store → :$STORE_PORT ──'; cd '$STORE' && bun run dev -- --port $STORE_PORT --strictPort"

tmux select-layout -t "$SESSION:$WEB_WINDOW" tiled

ok "Stack started in tmux session '$SESSION'."
echo ""
echo "Endpoints (give services ~10–20s to fully boot):"
echo "  cloud          → http://localhost:$CLOUD_PORT          (zrok: https://mentracloud.share.zrok.io)"
echo "  camera         → http://localhost:$CAMERA_PORT          (zrok: https://mentrayolo.share.zrok.io)"
echo "  metro / expo   → http://localhost:$METRO_PORT          (zrok: https://mentrametro.share.zrok.io)"
echo "  supabase kong  → http://localhost:$SUPABASE_PORT          (zrok: https://mentrasupabase.share.zrok.io)"
echo "  console        → http://localhost:$CONSOLE_PORT"
echo "  account        → http://localhost:$ACCOUNT_PORT"
echo "  store          → http://localhost:$STORE_PORT"
echo ""
echo "Attach:    tmux attach -t $SESSION"
echo "Switch windows in tmux: Ctrl-b 0 (stack), Ctrl-b 1 (websites)"
echo "Health:    $ROOT/scripts/dev-status.sh"
echo "Tear down: $ROOT/scripts/dev-down.sh"
