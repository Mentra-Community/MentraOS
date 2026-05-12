#!/usr/bin/env bash
# scripts/dev-status.sh — quick health check of the MentraOS dev stack

set -euo pipefail

ROOT="/Users/hiyabuddy/sites/brendancopley/MentraOS"
CLOUD_COMPOSE="$ROOT/cloud/docker-compose.dev.yml"

GREEN=$'\033[1;32m'; RED=$'\033[1;31m'; YELLOW=$'\033[1;33m'; DIM=$'\033[2m'; NC=$'\033[0m'

# Status codes that count as "service is up and reachable" depending on the endpoint.
# 200 = healthy. 401 = up but auth-gated (e.g. supabase Kong). 404 = up but no route at /.
check() {
  local name="$1" url="$2" expect="${3:-200,401,404}"
  local code
  code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 8 "$url" 2>/dev/null || echo "ERR")
  if echo ",$expect," | grep -q ",$code,"; then
    printf "  ${GREEN}✓${NC} %-26s ${DIM}%-50s${NC} %s\n" "$name" "$url" "$code"
  else
    printf "  ${RED}✗${NC} %-26s ${DIM}%-50s${NC} %s\n" "$name" "$url" "$code"
  fi
}

echo "${YELLOW}Local services${NC}"
check "cloud /health"          "http://localhost:8002/health"
check "camera /api/health"     "http://localhost:3300/api/health"
check "metro /status"          "http://localhost:8081/status"
check "supabase Kong"          "http://localhost:8000/"
check "supabase logflare"      "http://localhost:4000/health"
check "console /"              "http://localhost:5173/"
check "account /"              "http://localhost:8052/"
check "store /"                "http://localhost:5174/"

echo ""
echo "${YELLOW}Public (zrok)${NC}"
check "mentracloud /health"      "https://mentracloud.share.zrok.io/health"
check "mentrayolo /api/health"   "https://mentrayolo.share.zrok.io/api/health"
check "mentrametro /status"      "https://mentrametro.share.zrok.io/status"
check "mentrasupabase /"         "https://mentrasupabase.share.zrok.io/"

echo ""
echo "${YELLOW}Docker — MentraOS cloud${NC}"
docker compose -f "$CLOUD_COMPOSE" -p dev ps --format "  {{.Service}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || echo "  (cloud stack not running)"

echo ""
echo "${YELLOW}zrok shares${NC}"
for token in mentracloud mentrayolo mentrametro mentrasupabase; do
  if pgrep -f "zrok share reserved $token" >/dev/null; then
    printf "  ${GREEN}\xe2\x9c\x93${NC} %-15s share running\n" "$token"
  else
    printf "  ${RED}\xe2\x9c\x97${NC} %-15s share NOT running\n" "$token"
  fi
done

echo ""
echo "${YELLOW}tmux session${NC}"
if command -v tmux >/dev/null 2>&1 && tmux has-session -t mentraos 2>/dev/null; then
  printf "  ${GREEN}✓${NC} session 'mentraos' active — attach with:  tmux attach -t mentraos\n"
  for win in stack websites; do
    if tmux list-windows -t mentraos -F '#{window_name}' 2>/dev/null | grep -qx "$win"; then
      printf "     ${DIM}window '%s'${NC}\n" "$win"
      tmux list-panes -t "mentraos:$win" -F "       pane #{pane_index}: #{pane_current_command} (#{pane_pid})" 2>/dev/null || true
    fi
  done
else
  printf "  ${RED}✗${NC} session 'mentraos' not running\n"
fi
