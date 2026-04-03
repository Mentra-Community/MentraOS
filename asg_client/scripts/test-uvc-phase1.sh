#!/bin/bash
# test-uvc-phase1.sh - Manual Phase 1 UVC pipeline test helper
#
# Usage:
#   ./test-uvc-phase1.sh start-null
#   ./test-uvc-phase1.sh start-file [output_dir_on_device]
#   ./test-uvc-phase1.sh status
#   ./test-uvc-phase1.sh stop
#   ./test-uvc-phase1.sh logs
#   ./test-uvc-phase1.sh cycle [count]
#   ./test-uvc-phase1.sh soak [seconds]

set -e

SERVICE_CLASS="com.mentra.asg_client.io.uvc.core.UvcBridgeService"
ACTION_START="com.mentra.asg_client.action.START_UVC"
ACTION_STOP="com.mentra.asg_client.action.STOP_UVC"
ACTION_STATUS="com.mentra.asg_client.action.STATUS_UVC"
LOG_TAGS=("UvcBridgeService" "UvcBridgeManager")

detect_package() {
  for pkg in com.mentra.asg_client.thirdparty com.mentra.asg_client; do
    if adb shell pm list packages 2>/dev/null | grep -qF "$pkg"; then
      echo "$pkg"
      return
    fi
  done
  echo ""
}

require_device() {
  if ! adb get-state &>/dev/null; then
    echo "ERROR: no ADB device detected" >&2
    exit 1
  fi
}

start_with_sink() {
  local sink_type="$1"
  local output_dir="$2"

  require_device
  PKG=$(detect_package)
  if [ -z "$PKG" ]; then
    echo "ERROR: ASG client package not found on device" >&2
    exit 1
  fi

  adb shell am start-foreground-service \
    -n "${PKG}/${SERVICE_CLASS}" \
    -a "${ACTION_START}" \
    --es uvc_sink_type "${sink_type}" \
    --ei uvc_fps 15 \
    --ei uvc_width 640 \
    --ei uvc_height 480 \
    --ez uvc_allow_test_sinks true \
    ${output_dir:+--es uvc_output_dir "${output_dir}"}
}

cmd_start_null() {
  echo "Starting UVC Phase 1 with NullSink"
  start_with_sink "NULL"
}

cmd_start_file() {
  local output_dir="${1:-/sdcard/Download/uvc_phase1_frames}"
  echo "Starting UVC Phase 1 with FileSink -> ${output_dir}"
  start_with_sink "FILE" "${output_dir}"
}

cmd_status() {
  require_device
  PKG=$(detect_package)
  if [ -z "$PKG" ]; then
    echo "ERROR: ASG client package not found on device" >&2
    exit 1
  fi

  adb shell am startservice \
    -n "${PKG}/${SERVICE_CLASS}" \
    -a "${ACTION_STATUS}" >/dev/null
  echo "Status request sent. Check logs."
}

cmd_stop() {
  require_device
  PKG=$(detect_package)
  if [ -z "$PKG" ]; then
    echo "ERROR: ASG client package not found on device" >&2
    exit 1
  fi

  adb shell am startservice \
    -n "${PKG}/${SERVICE_CLASS}" \
    -a "${ACTION_STOP}" >/dev/null
  echo "Stop request sent."
}

cmd_logs() {
  require_device
  adb logcat -v time \
    "${LOG_TAGS[0]}:D" \
    "${LOG_TAGS[1]}:D" \
    "*:S"
}

cmd_cycle() {
  local count="${1:-20}"
  echo "Running ${count} start/stop cycles with NullSink"
  for i in $(seq 1 "${count}"); do
    echo "Cycle ${i}/${count}"
    cmd_start_null
    sleep 1
    cmd_stop
    sleep 1
  done
  echo "Cycle test complete"
}

cmd_soak() {
  local duration="${1:-600}"
  echo "Starting soak run for ${duration} seconds with NullSink"
  cmd_start_null
  sleep "${duration}"
  cmd_status
  cmd_stop
  echo "Soak run complete"
}

case "${1:-}" in
  start-null) cmd_start_null ;;
  start-file) cmd_start_file "${2:-}" ;;
  status) cmd_status ;;
  stop) cmd_stop ;;
  logs) cmd_logs ;;
  cycle) cmd_cycle "${2:-20}" ;;
  soak) cmd_soak "${2:-600}" ;;
  *)
    echo "Usage:"
    echo "  $0 start-null"
    echo "  $0 start-file [output_dir_on_device]"
    echo "  $0 status"
    echo "  $0 stop"
    echo "  $0 logs"
    echo "  $0 cycle [count]"
    echo "  $0 soak [seconds]"
    exit 1
    ;;
esac
