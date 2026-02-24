#!/bin/bash
#
# test-all.sh - Run all Phase 1 ADB test scripts
#
# Runs photo, video, gallery sync, and battery tests sequentially.
# WiFi and storage tests are excluded by default (require args / are destructive).
#
# Usage: ./scripts/test-all.sh
#
# To include wifi test:  ./scripts/test-all.sh --wifi <ssid> <password>
# To include storage test: ./scripts/test-all.sh --storage
# To include everything: ./scripts/test-all.sh --all <ssid> <password>
#

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"

INCLUDE_WIFI=false
INCLUDE_STORAGE=false
WIFI_SSID=""
WIFI_PASS=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --wifi)
      INCLUDE_WIFI=true
      WIFI_SSID="$2"
      WIFI_PASS="$3"
      shift 3
      ;;
    --storage)
      INCLUDE_STORAGE=true
      shift
      ;;
    --all)
      INCLUDE_WIFI=true
      INCLUDE_STORAGE=true
      WIFI_SSID="$2"
      WIFI_PASS="$3"
      shift 3
      ;;
    *)
      shift
      ;;
  esac
done

echo "=========================================="
echo "MentraLive Full Test Suite"
echo "=========================================="

check_adb
check_service

BATTERY=$(get_battery)
FREE=$(free_storage_mb)
echo ""
info "Battery: ${BATTERY}%"
info "Free storage: ${FREE} MB"
info "Time: $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

run_test() {
  local name="$1"
  shift
  echo ""
  echo "##################################################"
  echo "## $name"
  echo "##################################################"
  echo ""
  "$@"
}

# Core tests (always run)
run_test "PHOTO TEST" "$SCRIPT_DIR/test-photo.sh" 3
run_test "VIDEO TEST" "$SCRIPT_DIR/test-video.sh"
run_test "GALLERY SYNC TEST" "$SCRIPT_DIR/test-gallery-sync.sh"
run_test "BATTERY TEST" "$SCRIPT_DIR/test-low-battery.sh"

# Optional tests
if [ "$INCLUDE_WIFI" = true ] && [ -n "$WIFI_SSID" ]; then
  run_test "WIFI TEST" "$SCRIPT_DIR/test-wifi.sh" "$WIFI_SSID" "$WIFI_PASS"
fi

if [ "$INCLUDE_STORAGE" = true ]; then
  run_test "STORAGE FULL TEST" "$SCRIPT_DIR/test-storage-full.sh"
fi

# Final report
echo ""
echo "=========================================="
echo "FULL SUITE COMPLETE"
echo "=========================================="
BATTERY_AFTER=$(get_battery)
info "Battery: ${BATTERY}% -> ${BATTERY_AFTER}% (drained $((BATTERY - BATTERY_AFTER))%)"
info "Time: $(date '+%Y-%m-%d %H:%M:%S')"
echo "=========================================="
