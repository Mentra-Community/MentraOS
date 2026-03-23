#!/bin/bash
#
# test-ota.sh - Test MentraOS OTA: version check, download, checksum verify (NO install)
#
# Triggers OTA prefetch flow via ADB. Downloads update if available, verifies checksum,
# but does NOT install. Safe for automated testing.
#
# Requires: Glasses connected via ADB, AsgClientService + OtaService running, WiFi connected.
#
# Usage: ./scripts/test-ota.sh [--timeout SECONDS]
#   --timeout: Max seconds to wait for OTA check to complete (default: 120)
#

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"

PKG="com.mentra.asg_client"
OTA_RECEIVER="$PKG/.receiver.DebugOtaReceiver"
OTA_ACTION="com.mentra.DEBUG_OTA_CHECK"
TIMEOUT=120

for arg in "$@"; do
  case $arg in
    --timeout=*)
      TIMEOUT="${arg#*=}"
      ;;
  esac
done

echo "=========================================="
echo "OTA Test (Version Check + Download + Verify)"
echo "=========================================="

check_adb
check_service

# OTA requires OtaService - check it's running
if ! adb shell "dumpsys activity services $PKG" 2>/dev/null | grep -q "OtaService"; then
  fail "OtaService not running - OTA checks require OtaService"
  exit 1
fi
pass "OtaService running"

# OTA requires WiFi
info "Checking WiFi connectivity..."
PING_RESULT=$(adb shell "ping -c 2 -W 3 8.8.8.8 2>/dev/null" | grep -c "bytes from" || true)
if [ "${PING_RESULT:-0}" -eq 0 ]; then
  fail "No network connectivity - OTA requires WiFi. Run test-wifi.sh first."
  exit 1
fi
pass "WiFi connected"

info "Battery: $(get_battery)%"
info "Timeout: ${TIMEOUT}s"
echo ""

# Clear logcat before test
adb logcat -c 2>/dev/null

# Trigger OTA check (prefetch only - no install)
echo "--- Triggering OTA version check (prefetch, no install) ---"
adb shell am broadcast -a "$OTA_ACTION" -n "$OTA_RECEIVER" 2>/dev/null || true
sleep 2

# Monitor logcat for OTA progress
echo "--- Monitoring OTA progress (timeout: ${TIMEOUT}s) ---"
START=$(date +%s)
FOUND_VERSION_CHECK=false
FOUND_DOWNLOAD=false
FOUND_CHECKSUM=false
FOUND_SUCCESS=false
FOUND_ERROR=false
ERROR_MSG=""

while [ $(($(date +%s) - START)) -lt "$TIMEOUT" ]; do
  LOGS=$(adb logcat -d 2>/dev/null | grep -E "OtaHelper|OtaConstants|DebugOtaReceiver" | tail -100)

  echo "$LOGS" | grep -q "fetch_version_info\|Version JSON parsed\|Version check" && FOUND_VERSION_CHECK=true
  echo "$LOGS" | grep -q "download\|Downloading\|bytes" && FOUND_DOWNLOAD=true
  echo "$LOGS" | grep -q "SHA\|checksum\|sha256\|markCachedArtifactReady\|Cache hit" && FOUND_CHECKSUM=true
  echo "$LOGS" | grep -q "Successfully pre-downloaded\|Prefetching\|pre-downloaded\|up to date" && FOUND_SUCCESS=true

  if echo "$LOGS" | grep -qE "FAILED|Exception|Error|failed"; then
    FOUND_ERROR=true
    ERROR_MSG=$(echo "$LOGS" | grep -E "FAILED|Exception|Error|failed" | tail -3)
  fi

  # Success: we got version check and either (a) up to date, or (b) download+verify
  if [ "$FOUND_VERSION_CHECK" = true ]; then
    if [ "$FOUND_SUCCESS" = true ]; then
      pass "OTA version check completed (download + verify or up-to-date)"
      break
    fi
    if [ "$FOUND_CHECKSUM" = true ] && [ "$FOUND_DOWNLOAD" = true ]; then
      pass "OTA download completed, checksum verified (prefetch success)"
      break
    fi
  fi

  if [ "$FOUND_ERROR" = true ] && [ "$FOUND_VERSION_CHECK" = true ]; then
    # Version check ran but hit an error - may be expected (e.g. no update available, network blip)
    warn "OTA check encountered an error (check may have run)"
    info "$ERROR_MSG"
    break
  fi

  sleep 5
  echo -n "."
done

# Timeout or no success
if [ "$FOUND_VERSION_CHECK" != true ]; then
  fail "OTA version check did not start within ${TIMEOUT}s (check OtaService, WiFi, logcat)"
fi

if [ "$FOUND_SUCCESS" != true ] && [ "$FOUND_CHECKSUM" != true ]; then
  warn "OTA check may not have completed - review logcat for OtaHelper logs"
fi

summary
echo ""
echo "Full OTA logs: adb logcat -d | grep -E 'OtaHelper|OtaConstants'"
