#!/usr/bin/env bash

set -eo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT_DIR"

echo "[dev-local] stopping stale Cloud V2 listeners…"
for port in 3000 3001 3002 3102; do
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    kill $pids
  fi
done

udp_pids="$(lsof -tiUDP:8000 2>/dev/null || true)"
if [[ -n "$udp_pids" ]]; then
  kill $udp_pids
fi

echo "[dev-local] starting local Mongo and Redis…"
bun run setup:test

if ! command -v doppler >/dev/null 2>&1; then
  echo "[dev-local] Doppler CLI is required for Cloud V2 server credentials." >&2
  echo "[dev-local] Install it, then run: doppler login" >&2
  exit 1
fi

echo "[dev-local] starting Core, Runtime, and Test OEM with mock audio…"
exec doppler run \
  --project cloud-v2 \
  --config dev \
  -- \
  env AUDIO_PROVIDER=mock bun scripts/dev-stack.ts
