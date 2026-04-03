#!/bin/bash
# test-uvc-phase2.sh - Manual Phase 2 UVC camera pipeline helper
#
# Usage:
#   ./test-uvc-phase2.sh start-camera [sink]
#   ./test-uvc-phase2.sh start-synthetic [sink]
#   ./test-uvc-phase2.sh status
#   ./test-uvc-phase2.sh stop
#   ./test-uvc-phase2.sh preview-url
#   ./test-uvc-phase2.sh cycle [count]
#   ./test-uvc-phase2.sh soak [seconds]

set -e

SERVICE_CLASS="com.mentra.asg_client.io.uvc.core.UvcBridgeService"
ACTION_START="com.mentra.asg_client.action.START_UVC"
ACTION_STOP="com.mentra.asg_client.action.STOP_UVC"
ACTION_STATUS="com.mentra.asg_client.action.STATUS_UVC"
LOG_TAGS=("UvcBridgeService" "UvcBridgeManager" "Camera2UvcProducer" "UvcCommandHandler")

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

get_device_ip() {
  adb shell ip route 2>/dev/null | awk '/src/ {print $9; exit}'
}

start_with_mode() {
  local producer_mode="$1"
  local sink_type="${2:-NULL}"
  local output_dir="${3:-}"

  require_device
  PKG=$(detect_package)
  if [ -z "$PKG" ]; then
    echo "ERROR: ASG client package not found on device" >&2
    exit 1
  fi

  adb shell am start-foreground-service \
    -n "${PKG}/${SERVICE_CLASS}" \
    -a "${ACTION_START}" \
    --es uvc_producer_mode "${producer_mode}" \
    --es uvc_sink_type "${sink_type}" \
    --ei uvc_fps 15 \
    --ei uvc_width 640 \
    --ei uvc_height 480 \
    --ez uvc_allow_test_sinks true \
    --ez uvc_enable_preview true \
    ${output_dir:+--es uvc_output_dir "${output_dir}"}
}

cmd_start_camera() {
  local sink_type="${1:-NULL}"
  echo "Starting Phase 2 UVC with Camera2 producer and sink=${sink_type}"
  start_with_mode "CAMERA2" "${sink_type}"
}

cmd_start_synthetic() {
  local sink_type="${1:-NULL}"
  echo "Starting Phase 2 UVC with Synthetic producer and sink=${sink_type}"
  start_with_mode "SYNTHETIC" "${sink_type}"
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

cmd_preview_url() {
  require_device
  local ip
  ip="$(get_device_ip)"
  if [ -z "$ip" ]; then
    echo "ERROR: could not resolve device IP" >&2
    exit 1
  fi
  echo "Preview URL: http://${ip}:8089/api/uvc/preview"
  echo "Latest frame URL: http://${ip}:8089/api/uvc/latest-frame"
}

cmd_logs() {
  require_device
  adb logcat -v time \
    "${LOG_TAGS[0]}:D" \
    "${LOG_TAGS[1]}:D" \
    "${LOG_TAGS[2]}:D" \
    "${LOG_TAGS[3]}:D" \
    "*:S"
}

cmd_cycle() {
  local count="${1:-20}"
  echo "Running ${count} start/stop cycles with Camera2 producer"
  for i in $(seq 1 "${count}"); do
    echo "Cycle ${i}/${count}"
    cmd_start_camera "NULL"
    sleep 2
    cmd_status
    cmd_stop
    sleep 1
  done
  echo "Cycle test complete"
}

cmd_soak() {
  local duration="${1:-600}"
  echo "Starting Camera2 soak run for ${duration} seconds"
  cmd_start_camera "NULL"
  sleep "${duration}"
  cmd_status
  cmd_preview_url
  cmd_stop
  echo "Soak run complete"
}

case "${1:-}" in
  start-camera) cmd_start_camera "${2:-NULL}" ;;
  start-synthetic) cmd_start_synthetic "${2:-NULL}" ;;
  status) cmd_status ;;
  stop) cmd_stop ;;
  preview-url) cmd_preview_url ;;
  logs) cmd_logs ;;
  cycle) cmd_cycle "${2:-20}" ;;
  soak) cmd_soak "${2:-600}" ;;
  *)
    echo "Usage:"
    echo "  $0 start-camera [sink]"
    echo "  $0 start-synthetic [sink]"
    echo "  $0 status"
    echo "  $0 stop"
    echo "  $0 preview-url"
    echo "  $0 logs"
    echo "  $0 cycle [count]"
    echo "  $0 soak [seconds]"
    exit 1
    ;;
esac
