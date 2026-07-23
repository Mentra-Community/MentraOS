#!/usr/bin/env bash
# start-local-stream.sh — stand up MediaMTX on this laptop for Mentra Live
# same-WiFi testing. RTMP is the primary path; WHIP/WHEP is a documented fallback.
#
# Detects the LAN IP fresh every run (DHCP-safe), exports it as
# MTX_WEBRTCADDITIONALHOSTS for WHIP ICE candidates, and prints publish/watch
# URLs to paste into Livestreamer / a browser / VLC.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

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

RTMP_PUBLISH_URL="rtmp://${LAN_IP}:1935/live"
HLS_WATCH_URL="http://${LAN_IP}:8888/live"
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
echo "  Publish (glasses / Livestreamer Custom + Local network):"
echo "    $RTMP_PUBLISH_URL"
echo "  Watch (HLS in a browser / VLC):"
echo "    $HLS_WATCH_URL"
echo ""
echo "FALLBACK — WHIP / WHEP (WebRTC; needs TCP 8889 + UDP 8189)"
echo "  Publish:"
echo "    $WHIP_PUBLISH_URL"
echo "  Watch:"
echo "    $WHIP_WATCH_URL"
echo "────────────────────────────────────────────────────────"
echo ""
echo "Firewall tip (RTMP): allow inbound TCP 1935 for Docker."
echo "Firewall/ICE tip (WHIP): allow inbound TCP 8889 and UDP 8189 —"
echo "  if WHIP returns 201 but no video appears, ICE/UDP is blocked."
echo ""
echo "Glasses-only smoke test (bypass miniapp):"
echo "  ./asg_client/scripts/test-rtmp-streaming.sh start $RTMP_PUBLISH_URL"
echo "  ./asg_client/scripts/test-webrtc-streaming.sh start $WHIP_PUBLISH_URL"
echo ""
echo "Stop:"
echo "  docker compose -f $SCRIPT_DIR/docker-compose.yml down"
