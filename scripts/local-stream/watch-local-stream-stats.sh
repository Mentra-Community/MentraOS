#!/usr/bin/env bash
# watch-local-stream-stats.sh — print resolution + FPS received from glasses
# at MediaMTX (what this laptop actually sees on the RTMP ingest).
#
# Usage:
#   ./scripts/local-stream/watch-local-stream-stats.sh
#   ./scripts/local-stream/watch-local-stream-stats.sh rtmp://127.0.0.1:1935/live/stream
#
# Env:
#   SAMPLE_SECONDS=3   # sample window for measured fps
#   POLL_SECONDS=1     # pause between samples
#
# Ctrl-C to stop.
set -euo pipefail

STREAM_URL="${1:-rtmp://127.0.0.1:1935/live/stream}"
SAMPLE_SECONDS="${SAMPLE_SECONDS:-3}"
POLL_SECONDS="${POLL_SECONDS:-1}"
MTX_API="${MTX_API:-http://127.0.0.1:9997}"
PATH_NAME="${PATH_NAME:-live/stream}"

if ! command -v ffprobe >/dev/null 2>&1 || ! command -v ffmpeg >/dev/null 2>&1; then
  echo "ERROR: ffprobe/ffmpeg required. Install with: brew install ffmpeg" >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 required for JSON parsing" >&2
  exit 1
fi

echo "Watching receive stats from: $STREAM_URL"
echo "Sample window: ${SAMPLE_SECONDS}s   Poll gap: ${POLL_SECONDS}s"
echo "Waiting for glasses to publish…"
echo ""
echo "Note: no MediaMTX restart needed — if numbers looked crazy before, that was"
echo "a parser bug in this watcher (stream was already ~160x96 @ ~15fps)."
echo ""

was_online=0

probe_json() {
  ffprobe -v error -rw_timeout 1500000 -select_streams v:0 \
    -show_entries stream=width,height,avg_frame_rate,r_frame_rate,codec_name \
    -of json \
    "$STREAM_URL" 2>/dev/null || true
}

# stdin JSON → width height declared_fps codec
parse_probe_stdin() {
  python3 - <<'PY'
import json, sys

def rate_to_fps(rate):
    if not rate or rate in ("0/0", "N/A"):
        return None
    if "/" in rate:
        num, den = rate.split("/", 1)
        try:
            den_f = float(den)
            if den_f == 0:
                return None
            return float(num) / den_f
        except ValueError:
            return None
    try:
        return float(rate)
    except ValueError:
        return None

try:
    data = json.load(sys.stdin)
except Exception:
    sys.exit(1)

streams = data.get("streams") or []
if not streams:
    sys.exit(1)
s = streams[0]
width = s.get("width")
height = s.get("height")
codec = s.get("codec_name") or "?"
fps = rate_to_fps(s.get("avg_frame_rate")) or rate_to_fps(s.get("r_frame_rate"))
if width is None or height is None or fps is None:
    sys.exit(1)
print(f"{width} {height} {fps:.2f} {codec}")
PY
}

measure_fps() {
  # Wall-clock sample at the live edge. Avoid trusting ffmpeg's progress "fps="
  # (it often prints 0.0 when demuxing buffered packets at high speed).
  python3 - "$STREAM_URL" "$SAMPLE_SECONDS" <<'PY'
import subprocess, sys, time, re

url = sys.argv[1]
sample_s = float(sys.argv[2])
cmd = [
    "ffmpeg", "-hide_banner", "-nostats", "-loglevel", "info",
    "-fflags", "nobuffer", "-flags", "low_delay",
    "-rw_timeout", "2000000",
    "-i", url,
    "-an", "-t", str(sample_s),
    "-f", "null", "-",
]
start = time.monotonic()
proc = subprocess.run(cmd, capture_output=True, text=True)
elapsed = max(0.001, time.monotonic() - start)
log = (proc.stderr or "") + "\n" + (proc.stdout or "")

frames = None
for line in log.splitlines():
    # frame=   12 fps=0.0 ...
    m = re.search(r"\bframe=\s*(\d+)", line)
    if m:
        frames = int(m.group(1))

# Prefer frames / wall-clock. Fall back to frames / media-time if present.
media_time = None
m = re.search(r"\btime=(\d+):(\d+):(\d+(?:\.\d+)?)", log)
if m:
    media_time = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))

if frames is None:
    print("n/a")
    sys.exit(0)

# Live RTMP should take ~sample_s wall time; if it finishes instantly we still
# report frames/media_time when available (declared cadence of received packets).
if elapsed >= sample_s * 0.5:
    print(f"{frames / elapsed:.1f}")
elif media_time and media_time > 0:
    print(f"{frames / media_time:.1f}")
else:
    print(f"{frames / elapsed:.1f}")
PY
}

mtx_bytes() {
  curl -fsS -m 1 "${MTX_API}/v3/paths/get/${PATH_NAME}" 2>/dev/null \
    | python3 -c 'import json,sys
try:
  d=json.load(sys.stdin)
  print(d.get("bytesReceived") or d.get("inboundBytes") or 0)
except Exception:
  print("")' 2>/dev/null || true
}

while true; do
  json="$(probe_json || true)"
  if [[ -z "$json" ]]; then
    if [[ "$was_online" -eq 1 ]]; then
      echo "[RECV $(date '+%H:%M:%S')] stream offline"
      was_online=0
    fi
    sleep "$POLL_SECONDS"
    continue
  fi

  parsed="$(printf '%s' "$json" | parse_probe_stdin || true)"
  if [[ -z "$parsed" ]]; then
    sleep "$POLL_SECONDS"
    continue
  fi

  read -r width height declared codec <<<"$parsed"
  measured="$(measure_fps)"
  bytes="$(mtx_bytes)"
  ts="$(date '+%H:%M:%S')"
  if [[ -n "$bytes" ]]; then
    echo "[RECV $ts] resolution=${width}x${height} codec=${codec} declaredFps=${declared} measuredFps=${measured} bytesReceived=${bytes}"
  else
    echo "[RECV $ts] resolution=${width}x${height} codec=${codec} declaredFps=${declared} measuredFps=${measured}"
  fi
  was_online=1
  sleep "$POLL_SECONDS"
done
