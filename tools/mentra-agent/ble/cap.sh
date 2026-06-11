#!/usr/bin/env bash
# Live captions from the real glasses mic, on the lens + in the terminal.
#
# Assumes the daemon is up and connected to the glasses:
#   ./gd.sh start && bun glasses.mjs connect <serial>
#
# Then:  ./cap.sh
#
# Streams glasses LC3 audio -> cloud (Soniox) -> transcripts, and mirrors each
# caption back onto the lens. QA creds come from Doppler (cloud-v2/dev), same as
# the cloud-client e2e test. Ctrl-C turns the mic back off.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
CLOUD_V2="$(cd "$HERE/../../../cloud-v2" && pwd)"

# Confirm the daemon is up + connected before paying for a cloud connection.
PORT="${GLASSES_PORT:-8799}"
if ! curl -s "http://127.0.0.1:$PORT/status" | grep -q '"connected": *true'; then
  echo "glasses not connected — run: ./gd.sh start && bun glasses.mjs connect <serial>" >&2
  exit 1
fi

cd "$CLOUD_V2"
exec doppler run --project cloud-v2 --config dev -- bun scripts/glasses-captions.ts
