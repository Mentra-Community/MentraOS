#!/bin/bash
#
# test-wifi.sh - Test WiFi connectivity on Mentra Live glasses
#
# Tests WiFi connection and disconnection via ADB commands.
# Glasses must be connected via ADB with AsgClientService running.
#
# Usage: ./scripts/test-wifi.sh <ssid> <password>
#

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"

SSID="${1:-}"
PASSWORD="${2:-}"

if [ -z "$SSID" ]; then
  echo "Usage: ./scripts/test-wifi.sh <ssid> <password>"
  echo "  ssid: WiFi network name"
  echo "  password: WiFi password"
  exit 1
fi

echo "=========================================="
echo "WiFi Connectivity Test"
echo "=========================================="

check_adb
check_service

info "SSID: $SSID"
echo ""

# --- Test 1: Connect to WiFi ---
echo "--- Test: Connect to WiFi ---"
adb logcat -c 2>/dev/null

send_command "{\"type\":\"connect_wifi\",\"ssid\":\"$SSID\",\"password\":\"$PASSWORD\"}"
info "WiFi connect command sent, waiting..."
sleep 10

# Check if connected by pinging
PING_RESULT=$(adb shell "ping -c 2 -W 3 8.8.8.8 2>/dev/null" | grep -c "bytes from" || true)
if [ "${PING_RESULT:-0}" -gt 0 ]; then
  pass "WiFi connected (ping to 8.8.8.8 succeeded)"

  # Get IP address
  IP=$(adb shell "ip route | grep wlan0" 2>/dev/null | awk '{print $9}' | head -1)
  info "IP address: ${IP:-unknown}"
else
  fail "WiFi connection failed (ping to 8.8.8.8 failed)"
fi

# --- Test 2: WiFi scan ---
echo ""
echo "--- Test: WiFi scan ---"
adb logcat -c 2>/dev/null

send_command '{"type":"request_wifi_scan"}'
sleep 5

SCAN_RESULT=$(adb logcat -d | grep -c "wifi_scan" || true)
if [ "${SCAN_RESULT:-0}" -gt 0 ]; then
  pass "WiFi scan returned results"
else
  warn "No WiFi scan results in logs (may need more time)"
fi

# --- Test 3: Disconnect from WiFi ---
echo ""
echo "--- Test: Disconnect from WiFi ---"
send_command '{"type":"disconnect_wifi"}'
sleep 5

PING_RESULT=$(adb shell "ping -c 2 -W 3 8.8.8.8 2>/dev/null" | grep -c "bytes from" || true)
if [ "${PING_RESULT:-0}" -eq 0 ]; then
  pass "WiFi disconnected (ping failed as expected)"
else
  warn "WiFi may still be connected after disconnect command"
fi

summary
