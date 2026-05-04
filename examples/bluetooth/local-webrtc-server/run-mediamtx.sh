#!/usr/bin/env bash
set -euo pipefail

STREAM_PATH="${MENTRA_WEBRTC_STREAM_PATH:-mentra-live}"

detect_host_ip() {
  if [ -n "${MENTRA_WEBRTC_HOST_IP:-}" ]; then
    printf '%s\n' "$MENTRA_WEBRTC_HOST_IP"
    return
  fi

  if command -v ipconfig >/dev/null 2>&1; then
    for iface in en0 en1 en2; do
      local ip
      ip="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
      if [ -n "$ip" ]; then
        printf '%s\n' "$ip"
        return
      fi
    done
  fi

  if command -v hostname >/dev/null 2>&1; then
    local ip
    ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
    if [ -n "$ip" ]; then
      printf '%s\n' "$ip"
      return
    fi
  fi

  cat >&2 <<'EOF'
Could not detect a LAN IP address.

Set it explicitly, for example:
  MENTRA_WEBRTC_HOST_IP=192.168.1.42 examples/local-webrtc-server/run-mediamtx.sh
EOF
  exit 1
}

HOST_IP="$(detect_host_ip)"

cat <<EOF
Starting local MediaMTX WHIP/WHEP server.

Use these URLs while the container is running:
  WHIP publish URL for the example app:
    http://$HOST_IP:8889/$STREAM_PATH/whip

  Browser preview:
    http://$HOST_IP:8889/$STREAM_PATH

  WHEP playback URL:
    http://$HOST_IP:8889/$STREAM_PATH/whep

Keep the glasses, phone, and computer on a network where the phone and glasses can reach $HOST_IP.
Press Ctrl-C to stop the server.

EOF

exec docker run --rm -it --name mentra-webrtc \
  -e MTX_WEBRTCADDITIONALHOSTS="$HOST_IP" \
  -p 8889:8889 \
  -p 8890:8890/udp \
  -p 8189:8189/udp \
  bluenviron/mediamtx:1
