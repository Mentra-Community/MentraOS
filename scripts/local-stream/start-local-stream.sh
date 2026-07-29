#!/usr/bin/env bash
# start-local-stream.sh — stand up MediaMTX on this laptop for Mentra Live
# same-WiFi testing. RTMP is primary; SRT and WHIP/WHEP are also available.
#
# Detects the LAN IP fresh every run (DHCP-safe), exports it as
# MTX_WEBRTCADDITIONALHOSTS for WHIP ICE candidates, prints publish/watch
# URLs, then stays attached and logs receive resolution / bitrate / FPS.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

POLL_SECONDS="${POLL_SECONDS:-1}"
MTX_API="${MTX_API:-http://127.0.0.1:9997}"
PATH_NAMES="${PATH_NAMES:-live/stream,live}"

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
  echo "  Paths: ${PATH_NAMES}"
  echo "  Poll: every ${POLL_SECONDS}s"
  echo "  Ctrl-C stops this monitor (MediaMTX keeps running)."
  echo "────────────────────────────────────────────────────────"
  echo ""
  echo "[RECV] waiting for glasses to publish…"

  # API-first monitor. FPS via ffprobe packet sample over RTSP/TCP
  # (decode undercounts; bare metadata is often 0/0 or 90000).
  POLL_SECONDS="$POLL_SECONDS" MTX_API="$MTX_API" PATH_NAMES="$PATH_NAMES" \
    python3 - <<'PY'
import json, os, shutil, subprocess, sys, time, urllib.request

api = os.environ.get("MTX_API", "http://127.0.0.1:9997").rstrip("/")
paths = [p.strip() for p in os.environ.get("PATH_NAMES", "live/stream,live").split(",") if p.strip()]
poll = float(os.environ.get("POLL_SECONDS", "1"))

was_online = False
active_path = None
prev_bytes = None
prev_t = None
cached_fps = None
fps_failures = 0
next_fps_probe_at = 0.0
# Read packets briefly so ffprobe can estimate rate (needs TCP + sample window).
FPS_SAMPLE_SECONDS = 2.0
FPS_RETRY_BASE = 8.0
FPS_RETRY_MAX = 60.0
FPS_MIN, FPS_MAX = 1.0, 120.0


def fetch(path):
    url = f"{api}/v3/paths/get/{path}"
    try:
        with urllib.request.urlopen(url, timeout=1.5) as resp:
            return json.load(resp)
    except Exception:
        return None


def fetch_active():
    reachable = False
    for path in paths:
        data = fetch(path)
        if data is None:
            continue
        reachable = True
        if data.get("ready") or data.get("online"):
            return path, data, True
    return None, None, reachable


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


def sane_fps(fps):
    return fps is not None and FPS_MIN <= fps <= FPS_MAX


def probe_measured_fps(path):
    """Sample RTSP/TCP packets; prefer estimated frame rate, else packets/sec."""
    if not shutil.which("ffprobe"):
        return None
    stream_url = f"rtsp://127.0.0.1:8554/{path}"
    try:
        proc = subprocess.run(
            [
                "ffprobe", "-v", "error",
                "-rtsp_transport", "tcp",
                "-select_streams", "v:0",
                "-count_packets",
                "-read_intervals", f"%+{FPS_SAMPLE_SECONDS:g}",
                "-show_entries", "stream=avg_frame_rate,r_frame_rate,nb_read_packets",
                "-of", "json",
                stream_url,
            ],
            capture_output=True,
            text=True,
            timeout=FPS_SAMPLE_SECONDS + 10,
        )
        data = json.loads(proc.stdout or "{}")
        streams = data.get("streams") or []
        if not streams:
            return None
        s = streams[0]
        for key in ("avg_frame_rate", "r_frame_rate"):
            fps = parse_rate(s.get(key))
            if sane_fps(fps):
                return fps
        packets = s.get("nb_read_packets")
        if packets is not None and FPS_SAMPLE_SECONDS > 0:
            fps = float(packets) / FPS_SAMPLE_SECONDS
            if sane_fps(fps):
                return fps
    except Exception:
        return None
    return None


while True:
    path, data, api_reachable = fetch_active()
    ts = time.strftime("%H:%M:%S")
    if not api_reachable:
        print(f"[RECV {ts}] MediaMTX API unreachable at {api}", flush=True)
        time.sleep(poll)
        continue

    if data is None or path is None:
        if was_online:
            print(f"[RECV {ts}] stream offline path={active_path}", flush=True)
            was_online = False
            active_path = None
            prev_bytes = None
            prev_t = None
            cached_fps = None
            fps_failures = 0
            next_fps_probe_at = 0.0
        time.sleep(poll)
        continue

    if path != active_path:
        active_path = path
        prev_bytes = None
        prev_t = None
        cached_fps = None
        fps_failures = 0
        next_fps_probe_at = 0.0
        source = data.get("source") or {}
        transport = source.get("type") if isinstance(source, dict) else None
        print(
            f"[RECV {ts}] publisher online path={path} transport={transport or 'unknown'}",
            flush=True,
        )

    now = time.monotonic()
    if cached_fps is None and now >= next_fps_probe_at:
        print(f"[RECV {ts}] sampling fps (~{FPS_SAMPLE_SECONDS:.0f}s RTSP packets)…", flush=True)
        cached_fps = probe_measured_fps(path)
        if cached_fps is not None:
            fps_failures = 0
            print(f"[RECV {ts}] fps={cached_fps:.1f} (packet sample)", flush=True)
        else:
            fps_failures += 1
            retry = min(FPS_RETRY_MAX, FPS_RETRY_BASE * (2 ** min(fps_failures - 1, 3)))
            next_fps_probe_at = now + retry
            print(
                f"[RECV {ts}] fps measure failed — retry in {retry:.0f}s "
                f"(resolution/bitrate below still valid)",
                flush=True,
            )

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
    fps = f"{cached_fps:.1f}" if cached_fps is not None else "n/a"
    print(
        f"[RECV {ts}] online path={path} resolution={res} codec={codec} "
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
# MediaMTX SRT uses streamid=publish:<path> (not a path after the host).
SRT_PUBLISH_URL="srt://${LAN_IP}:8890?streamid=publish:live/stream"
SRT_WATCH_URL="srt://${LAN_IP}:8890?streamid=read:live/stream"
HLS_WATCH_URL="http://${LAN_IP}:8888/live/stream"
WHIP_PUBLISH_URL="http://${LAN_IP}:8889/live/whip"
WHIP_WATCH_URL="http://${LAN_IP}:8889/live"

echo "LAN IP                  : $LAN_IP"
echo "MTX_WEBRTCADDITIONALHOSTS=$MTX_WEBRTCADDITIONALHOSTS"
echo ""
echo "Starting MediaMTX (RTMP primary, SRT + WHIP available)…"
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
echo "ALSO — SRT (UDP 8890; MediaMTX streamid syntax)"
echo "  Publish (Livestreamer Custom + protocol SRT):"
echo "    $SRT_PUBLISH_URL"
echo "  Watch SRT:"
echo "    $SRT_WATCH_URL"
echo "  Or watch the same stream over HLS after SRT publish:"
echo "    ${HLS_WATCH_URL}/"
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
echo "Firewall tip (SRT): allow inbound UDP 8890 for Docker."
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
