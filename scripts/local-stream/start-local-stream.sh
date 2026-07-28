#!/usr/bin/env bash
# start-local-stream.sh — stand up MediaMTX on this laptop for Mentra Live
# same-WiFi testing. RTMP is the primary path; WHIP/WHEP is a documented fallback.
#
# Detects the LAN IP fresh every run (DHCP-safe), exports it as
# MTX_WEBRTCADDITIONALHOSTS for WHIP ICE candidates, prints publish/watch
# URLs, then stays attached and logs receive resolution / bitrate / FPS.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

POLL_SECONDS="${POLL_SECONDS:-1}"
MTX_API="${MTX_API:-http://127.0.0.1:9997}"
PATH_NAME="${PATH_NAME:-live/stream}"

detect_lan_ip() {
  local ip=""

  # Prefer Wi-Fi / primary Ethernet interfaces on macOS.
  if command -v ipconfig >/dev/null 2>&1; then
    ip="$(ipconfig getifaddr en0 2>/dev/null || true)"
    if [[ -z "$ip" ]]; then
      ip="$(ipconfig getifaddr en1 2>/dev/null || true)"
    fi
  fi

  # Fallback: interface used for the default route.
  if [[ -z "$ip" ]] && command -v route >/dev/null 2>&1; then
    local iface
    iface="$(route -n get default 2>/dev/null | awk '/interface:/{print $2}' || true)"
    if [[ -n "$iface" ]] && command -v ipconfig >/dev/null 2>&1; then
      ip="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
    fi
  fi

  # Last resort: first non-loopback IPv4 from ifconfig.
  if [[ -z "$ip" ]] && command -v ifconfig >/dev/null 2>&1; then
    ip="$(ifconfig 2>/dev/null | awk '/inet / && $2 != "127.0.0.1" {print $2; exit}' || true)"
  fi

  # Linux fallback.
  if [[ -z "$ip" ]] && command -v hostname >/dev/null 2>&1; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  fi

  printf '%s' "$ip"
}

monitor_receive_stats() {
  if ! command -v python3 >/dev/null 2>&1; then
    echo "WARN: python3 not found — skipping live receive stats monitor." >&2
    return 0
  fi

  echo "────────────────────────────────────────────────────────"
  echo "RECEIVE STATS (from MediaMTX — what this laptop gets)"
  echo "  Path: ${PATH_NAME}"
  echo "  Poll: every ${POLL_SECONDS}s"
  echo "  Ctrl-C stops this monitor (MediaMTX keeps running)."
  echo "────────────────────────────────────────────────────────"
  echo ""
  echo "[RECV] waiting for glasses to publish…"

  # API-first monitor: no ffprobe hang / no extra RTMP reader flap.
  POLL_SECONDS="$POLL_SECONDS" MTX_API="$MTX_API" PATH_NAME="$PATH_NAME" \
    STREAM_URL="rtmp://127.0.0.1:1935/live/stream" python3 - <<'PY'
import json, os, re, subprocess, sys, time, urllib.request

api = os.environ.get("MTX_API", "http://127.0.0.1:9997").rstrip("/")
path = os.environ.get("PATH_NAME", "live/stream")
poll = float(os.environ.get("POLL_SECONDS", "1"))
stream_url = os.environ.get("STREAM_URL", "rtmp://127.0.0.1:1935/live/stream")
url = f"{api}/v3/paths/get/{path}"

was_online = False
prev_bytes = None
prev_t = None
cached_fps = None
next_fps_probe_at = 0.0
FPS_RETRY_SECONDS = 5.0


def fetch():
    try:
        with urllib.request.urlopen(url, timeout=1.5) as resp:
            return json.load(resp)
    except Exception:
        return None


def parse_rate(rate):
    if not rate or rate == "0/0":
        return None
    try:
        if "/" in rate:
            num, den = rate.split("/", 1)
            den_f = float(den)
            if den_f == 0:
                return None
            return float(num) / den_f
        return float(rate)
    except Exception:
        return None


def probe_declared_fps():
    """ffprobe bitstream timing (declared fps). Avoid frequent calls — flaps RTMP readers."""
    try:
        proc = subprocess.run(
            [
                "ffprobe", "-v", "error", "-rw_timeout", "2000000",
                "-select_streams", "v:0",
                "-show_entries", "stream=avg_frame_rate,r_frame_rate",
                "-of", "json",
                stream_url,
            ],
            capture_output=True,
            text=True,
            timeout=5,
        )
        data = json.loads(proc.stdout or "{}")
        streams = data.get("streams") or []
        if not streams:
            return None
        s = streams[0]
        for key in ("avg_frame_rate", "r_frame_rate"):
            fps = parse_rate(s.get(key))
            if fps is not None and fps > 0:
                return fps
    except Exception:
        return None
    return None


while True:
    data = fetch()
    ts = time.strftime("%H:%M:%S")
    if not data:
        print(f"[RECV {ts}] MediaMTX API unreachable at {url}", flush=True)
        time.sleep(poll)
        continue

    online = bool(data.get("ready") or data.get("online"))
    if not online:
        if was_online:
            print(f"[RECV {ts}] stream offline", flush=True)
            was_online = False
            prev_bytes = None
            prev_t = None
            cached_fps = None
            next_fps_probe_at = 0.0
        time.sleep(poll)
        continue

    now = time.monotonic()
    if cached_fps is None and now >= next_fps_probe_at:
        print(f"[RECV {ts}] probing fps via ffprobe…", flush=True)
        cached_fps = probe_declared_fps()
        next_fps_probe_at = now + (0 if cached_fps is not None else FPS_RETRY_SECONDS)
        if cached_fps is not None:
            print(f"[RECV {ts}] fps={cached_fps:.2f} (bitstream declared)", flush=True)
        else:
            print(f"[RECV {ts}] fps probe failed — retry in {FPS_RETRY_SECONDS:.0f}s", flush=True)

    width = height = None
    codec = "?"
    for track in data.get("tracks2") or []:
        props = track.get("codecProps") or {}
        if "width" in props and "height" in props:
            width = props.get("width")
            height = props.get("height")
            codec = track.get("codec") or codec
            break

    bytes_rx = data.get("bytesReceived")
    if bytes_rx is None:
        bytes_rx = data.get("inboundBytes") or 0
    bitrate_kbps = None
    if prev_bytes is not None and prev_t is not None and now > prev_t:
        delta = max(0, int(bytes_rx) - int(prev_bytes))
        bitrate_kbps = (delta * 8.0 / (now - prev_t)) / 1000.0
    prev_bytes = bytes_rx
    prev_t = now

    res = f"{width}x{height}" if width and height else "n/a"
    br = f"{bitrate_kbps:.0f}" if bitrate_kbps is not None else "n/a"
    fps = f"{cached_fps:.2f}" if cached_fps is not None else "n/a"
    print(
        f"[RECV {ts}] online resolution={res} codec={codec} "
        f"fps={fps} recvBitrateKbps={br} bytesReceived={bytes_rx}",
        flush=True,
    )
    was_online = True
    time.sleep(poll)
PY
}

if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: docker not found. Install Docker Desktop and retry." >&2
  exit 1
fi

LAN_IP="$(detect_lan_ip)"
if [[ -z "$LAN_IP" ]]; then
  echo "ERROR: could not detect a LAN IP (tried en0, en1, default route, ifconfig)." >&2
  echo "Connect to Wi-Fi, then re-run." >&2
  exit 1
fi

export MTX_WEBRTCADDITIONALHOSTS="$LAN_IP"

# StreamPack requires /app/streamKey (two path segments). MediaMTX path becomes live/stream.
RTMP_PUBLISH_URL="rtmp://${LAN_IP}:1935/live/stream"
HLS_WATCH_URL="http://${LAN_IP}:8888/live/stream"
WHIP_PUBLISH_URL="http://${LAN_IP}:8889/live/whip"
WHIP_WATCH_URL="http://${LAN_IP}:8889/live"

echo "LAN IP                  : $LAN_IP"
echo "MTX_WEBRTCADDITIONALHOSTS=$MTX_WEBRTCADDITIONALHOSTS"
echo ""
echo "Starting MediaMTX (RTMP primary, WHIP fallback)…"
docker compose -f "$SCRIPT_DIR/docker-compose.yml" up -d

echo ""
echo "────────────────────────────────────────────────────────"
echo "PRIMARY — RTMP (recommended)"
echo "  Publish (Livestreamer Custom + Local network):"
echo "    $RTMP_PUBLISH_URL"
echo "  Watch on THIS LAPTOP (phone has no unmanaged preview):"
echo "    Browser HLS:  ${HLS_WATCH_URL}/"
echo "    VLC → Open Network: $RTMP_PUBLISH_URL"
echo "    VLC → Open Network: rtsp://${LAN_IP}:8554/live/stream"
echo ""
echo "FALLBACK — WHIP / WHEP (WebRTC; needs TCP 8889 + UDP 8189)"
echo "  Publish:"
echo "    $WHIP_PUBLISH_URL"
echo "  Watch:"
echo "    $WHIP_WATCH_URL"
echo "────────────────────────────────────────────────────────"
echo ""
echo "Note: Livestreamer Local-network mode shows 'No preview available'"
echo "on the phone by design — watch on the laptop URLs above."
echo ""
echo "Firewall tip (RTMP): allow inbound TCP 1935 for Docker."
echo "Firewall/ICE tip (WHIP): allow inbound TCP 8889 and UDP 8189 —"
echo "  if WHIP returns 201 but no video appears, ICE/UDP is blocked."
echo ""
echo "Glasses-only smoke test (bypass miniapp):"
echo "  ./asg_client/scripts/test-rtmp-streaming.sh start $RTMP_PUBLISH_URL"
echo "  ./asg_client/scripts/test-webrtc-streaming.sh start $WHIP_PUBLISH_URL"
echo ""
echo "Stop MediaMTX:"
echo "  docker compose -f $SCRIPT_DIR/docker-compose.yml down"
echo ""

# Stay attached and print receive resolution/bitrate live.
monitor_receive_stats
