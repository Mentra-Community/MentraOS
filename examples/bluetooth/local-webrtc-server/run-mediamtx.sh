#!/usr/bin/env bash
set -euo pipefail

if [ -n "${MENTRA_STREAM_PATH:-}" ]; then
  RTMP_STREAM_PATH="$MENTRA_STREAM_PATH"
  WEBRTC_STREAM_PATH="$MENTRA_STREAM_PATH"
else
  RTMP_STREAM_PATH="${MENTRA_RTMP_STREAM_PATH:-live/mentra-live}"
  WEBRTC_STREAM_PATH="${MENTRA_WEBRTC_STREAM_PATH:-mentra-live}"
fi

detect_host_ip() {
  if [ -n "${MENTRA_STREAM_HOST_IP:-}" ]; then
    printf '%s\n' "$MENTRA_STREAM_HOST_IP"
    return
  fi

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
  MENTRA_STREAM_HOST_IP=192.168.1.42 examples/local-webrtc-server/run-mediamtx.sh
EOF
  exit 1
}

HOST_IP="$(detect_host_ip)"

cat <<EOF
Starting local MediaMTX streaming server.

Use these URLs while the container is running:
  RTMP publish URL for the example app:
    rtmp://$HOST_IP:1935/$RTMP_STREAM_PATH

  RTMP browser preview (HLS):
    http://$HOST_IP:8888/$RTMP_STREAM_PATH

  Optional RTMP ffplay preview:
    ffplay -fflags nobuffer -flags low_delay -framedrop rtmp://$HOST_IP:1935/$RTMP_STREAM_PATH

  WHIP publish URL for the example app:
    http://$HOST_IP:8889/$WEBRTC_STREAM_PATH/whip

  WebRTC browser preview:
    http://$HOST_IP:8889/$WEBRTC_STREAM_PATH

  WHEP playback URL:
    http://$HOST_IP:8889/$WEBRTC_STREAM_PATH/whep

Keep the glasses, phone, and computer on a network where the phone and glasses can reach $HOST_IP.
Press Ctrl-C to stop the server.

EOF

exec docker run --rm -it --name mentra-webrtc \
  -e MTX_WEBRTCADDITIONALHOSTS="$HOST_IP" \
  -e MTX_HLSVARIANT=mpegts \
  -p 1935:1935 \
  -p 8888:8888 \
  -p 8889:8889 \
  -p 8890:8890/udp \
  -p 8189:8189/udp \
  bluenviron/mediamtx:1
