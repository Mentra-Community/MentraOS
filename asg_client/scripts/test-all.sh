#!/bin/bash
#
# test-all.sh - Run all Phase 1 ADB test scripts
#
# Runs photo, video, gallery sync, and battery tests sequentially.
# WiFi and storage tests are excluded by default (require args / are destructive).
#
# Usage: ./scripts/test-all.sh
#
# To include wifi test:   ./scripts/test-all.sh --wifi <ssid> <password>
# To include storage test: ./scripts/test-all.sh --storage
# To include OTA test:     ./scripts/test-all.sh --ota (requires WiFi)
# To include everything:  ./scripts/test-all.sh --all <ssid> <password>
# Non-interactive (no prompts): ./scripts/test-all.sh --no-prompt
#

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"

INCLUDE_WIFI=false
INCLUDE_STORAGE=false
INCLUDE_OTA=false
SKIP_CLEANUP_PROMPTS=0
WIFI_SSID=""
WIFI_PASS=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --no-prompt)
      SKIP_CLEANUP_PROMPTS=1
      export SKIP_CLEANUP_PROMPTS
      shift
      ;;
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
    --ota)
      INCLUDE_OTA=true
      shift
      ;;
    --all)
      INCLUDE_WIFI=true
      INCLUDE_STORAGE=true
      INCLUDE_OTA=true
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
EXTRA_ARGS=""
[ "$SKIP_CLEANUP_PROMPTS" = "1" ] && EXTRA_ARGS="--no-prompt"
run_test "PHOTO TEST" "$SCRIPT_DIR/test-photo.sh" 3 $EXTRA_ARGS
run_test "VIDEO TEST" "$SCRIPT_DIR/test-video.sh" $EXTRA_ARGS
run_test "GALLERY SYNC TEST" "$SCRIPT_DIR/test-gallery-sync.sh" $EXTRA_ARGS
run_test "BATTERY TEST" "$SCRIPT_DIR/test-low-battery.sh" $EXTRA_ARGS

# Optional tests
if [ "$INCLUDE_WIFI" = true ] && [ -n "$WIFI_SSID" ]; then
  run_test "WIFI TEST" "$SCRIPT_DIR/test-wifi.sh" "$WIFI_SSID" "$WIFI_PASS"
fi

if [ "$INCLUDE_STORAGE" = true ]; then
  run_test "STORAGE FULL TEST" "$SCRIPT_DIR/test-storage-full.sh"
fi

if [ "$INCLUDE_OTA" = true ]; then
  run_test "OTA TEST" "$SCRIPT_DIR/test-ota.sh"
fi

# Final report and cleanup
echo ""
echo "=========================================="
echo "FULL SUITE COMPLETE"
echo "=========================================="
BATTERY_AFTER=$(get_battery)
info "Battery: ${BATTERY}% -> ${BATTERY_AFTER}% (drained $((BATTERY - BATTERY_AFTER))%)"
info "Time: $(date '+%Y-%m-%d %H:%M:%S')"

# Wipe all test data from device when --no-prompt
if [ "$SKIP_CLEANUP_PROMPTS" = "1" ]; then
  PHOTOS=$(count_photos)
  VIDEOS=$(count_videos)
  if [ "$PHOTOS" -gt 0 ] || [ "$VIDEOS" -gt 0 ]; then
    adb shell "rm -rf '$CAMERA_DIR'/IMG_* '$CAMERA_DIR'/VID_*" 2>/dev/null || true
    info "Wiped $PHOTOS photos and $VIDEOS videos from glasses"
  fi
  # Wipe local test-output dirs
  TEST_OUTPUT="$SCRIPT_DIR/../test-output"
  if [ -d "$TEST_OUTPUT/photos" ]; then
    rm -f "$TEST_OUTPUT/photos"/*.jpg "$TEST_OUTPUT/photos"/*.avif 2>/dev/null || true
  fi
  if [ -d "$TEST_OUTPUT/videos" ]; then
    rm -f "$TEST_OUTPUT/videos"/*.mp4 2>/dev/null || true
  fi
fi

echo "=========================================="
