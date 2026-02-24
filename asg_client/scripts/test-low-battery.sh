#!/bin/bash
#
# test-low-battery.sh - Test behavior at current battery level
#
# Reports current battery level and tests which operations are allowed/blocked.
# Glasses must be connected via ADB with AsgClientService running.
#
# Usage: ./scripts/test-low-battery.sh
#

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"

echo "=========================================="
echo "Battery Level Test"
echo "=========================================="

check_adb
check_service

BATTERY=$(get_battery)
CHARGING=$(adb shell dumpsys battery | grep "status:" | awk '{print $2}')

echo ""
info "Battery level: ${BATTERY}%"
case "$CHARGING" in
  2) info "Status: Charging" ;;
  3) info "Status: Discharging" ;;
  5) info "Status: Full" ;;
  *) info "Status: Unknown ($CHARGING)" ;;
esac
echo ""

# --- Test 1: Photo capture ---
echo "--- Test: Photo capture at ${BATTERY}% ---"
BEFORE=$(count_photos)
send_command '{"type":"take_photo","requestId":"test_batt_photo","transferMethod":"ble","size":"small"}'
sleep 4
AFTER=$(count_photos)

if [ "$BATTERY" -lt 10 ]; then
  if [ "$AFTER" -eq "$BEFORE" ]; then
    pass "Photo correctly REJECTED at ${BATTERY}% (below 10% threshold)"
  else
    fail "Photo should have been rejected at ${BATTERY}%"
  fi
else
  if [ "$AFTER" -gt "$BEFORE" ]; then
    pass "Photo captured at ${BATTERY}%"
  else
    fail "Photo failed at ${BATTERY}% (should have succeeded)"
  fi
fi

# --- Test 2: Video recording ---
echo ""
echo "--- Test: Video recording at ${BATTERY}% ---"
BEFORE=$(count_videos)
send_command '{"type":"start_video_recording","requestId":"test_batt_vid","save":true}'
sleep 3
send_command '{"type":"stop_video_recording","requestId":"test_batt_vid"}'
sleep 3
AFTER=$(count_videos)

if [ "$BATTERY" -lt 10 ]; then
  if [ "$AFTER" -eq "$BEFORE" ]; then
    pass "Video correctly REJECTED at ${BATTERY}%"
  else
    fail "Video should have been rejected at ${BATTERY}%"
  fi
else
  if [ "$AFTER" -gt "$BEFORE" ]; then
    pass "Video recorded at ${BATTERY}%"
  else
    fail "Video failed at ${BATTERY}% (should have succeeded)"
  fi
fi

# --- Test 3: Report battery drain ---
echo ""
echo "--- Battery drain report ---"
BATTERY_AFTER=$(get_battery)
DRAIN=$((BATTERY - BATTERY_AFTER))
info "Battery before tests: ${BATTERY}%"
info "Battery after tests:  ${BATTERY_AFTER}%"
info "Drain during tests:   ${DRAIN}%"

summary
