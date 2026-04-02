#!/bin/bash
# test-webrtc-streaming.sh — Manual test driver for WhipStreamingService (WHIP)
#
# Usage:
#   ./test-webrtc-streaming.sh start <whip_url> [stream_id]
#   ./test-webrtc-streaming.sh stop
#   ./test-webrtc-streaming.sh logs            # tail logcat (Ctrl-C to exit)
#   ./test-webrtc-streaming.sh status          # check if service process is running
#
# Prerequisites:
#   - adb in PATH and device/emulator connected
#   - App already installed (debug or thirdparty build)
#   - CAMERA + RECORD_AUDIO permissions granted
#
# Examples:
#   ./test-webrtc-streaming.sh start https://ingest.example.com/whip/live
#   ./test-webrtc-streaming.sh start https://ingest.example.com/whip/live my-stream-01
#   ./test-webrtc-streaming.sh logs
#   ./test-webrtc-streaming.sh stop

set -e

SERVICE_CLASS="com.mentra.asg_client.io.streaming.services.WhipStreamingService"
LOG_TAG="WhipStreamingService"

# ── Detect installed package name ──────────────────────────────────────────────
detect_package() {
  for pkg in com.mentra.asg_client.thirdparty com.mentra.asg_client; do
    if adb shell pm list packages 2>/dev/null | grep -qF "$pkg"; then
      echo "$pkg"
      return
    fi
  done
  echo ""
}

# ── Require ADB connection ─────────────────────────────────────────────────────
require_device() {
  if ! adb get-state &>/dev/null; then
    echo "ERROR: No ADB device found. Connect the glasses and run 'adb devices'." >&2
    exit 1
  fi
}

# ── Subcommands ────────────────────────────────────────────────────────────────

cmd_start() {
  local whip_url="$1"
  local stream_id="${2:-test-$(date +%s)}"

  if [ -z "$whip_url" ]; then
    echo "Usage: $0 start <whip_url> [stream_id]" >&2
    exit 1
  fi

  require_device
  PKG=$(detect_package)
  if [ -z "$PKG" ]; then
    echo "ERROR: App not installed. Build and install with: ./gradlew installDebug" >&2
    exit 1
  fi

  echo "Package : $PKG"
  echo "WHIP URL: $whip_url"
  echo "Stream  : $stream_id"
  echo ""

  # Grant runtime permissions if not already granted
  echo "→ Granting camera + microphone permissions…"
  adb shell pm grant "$PKG" android.permission.CAMERA            2>/dev/null || true
  adb shell pm grant "$PKG" android.permission.RECORD_AUDIO      2>/dev/null || true

  echo "→ Starting WhipStreamingService…"
  adb shell am start-foreground-service \
    -n "${PKG}/${SERVICE_CLASS}" \
    --es whip_url  "$whip_url" \
    --es stream_id "$stream_id" \
    --ez enable_led   true \
    --ez enable_sound true

  echo ""
  echo "Service started. Run '$0 logs' to follow output."
}

cmd_stop() {
  require_device
  PKG=$(detect_package)
  if [ -z "$PKG" ]; then
    echo "App not installed — nothing to stop." >&2
    exit 1
  fi

  echo "→ Stopping WhipStreamingService (${PKG})…"
  adb shell am stopservice -n "${PKG}/${SERVICE_CLASS}" || true
  echo "Done."
}

cmd_logs() {
  require_device
  echo "Tailing logcat for tag '$LOG_TAG' (Ctrl-C to exit)…"
  echo "──────────────────────────────────────────────────"
  # Include a few related tags for full picture
  adb logcat -v time \
    "$LOG_TAG:D" \
    "WhipStreamingService:D" \
    "PeerConnection:W" \
    "libjingle:W" \
    "*:S"
}

cmd_status() {
  require_device
  PKG=$(detect_package)
  if [ -z "$PKG" ]; then
    echo "App not installed." >&2
    exit 1
  fi

  echo "=== Running services for ${PKG} ==="
  adb shell dumpsys activity services "$PKG" 2>/dev/null \
    | grep -E "(ServiceRecord|running|foreground|Whip)" || echo "(none found)"

  echo ""
  echo "=== Recent $LOG_TAG log lines ==="
  # Dump the last 200 lines of logcat filtered to our tag
  adb logcat -d -v time "$LOG_TAG:D" "*:S" 2>/dev/null | tail -30
}

# ── Entry point ────────────────────────────────────────────────────────────────

case "${1:-}" in
  start)  cmd_start  "${2:-}" "${3:-}" ;;
  stop)   cmd_stop ;;
  logs)   cmd_logs ;;
  status) cmd_status ;;
  *)
    echo "WebRTC / WHIP streaming test script"
    echo ""
    echo "Usage:"
    echo "  $0 start <whip_url> [stream_id]   Start streaming to a WHIP endpoint"
    echo "  $0 stop                            Stop the stream"
    echo "  $0 logs                            Tail logcat output (Ctrl-C to exit)"
    echo "  $0 status                          Show service status + recent logs"
    echo ""
    echo "Example:"
    echo "  $0 start https://ingest.example.com/whip/live"
    exit 1
    ;;
esac
