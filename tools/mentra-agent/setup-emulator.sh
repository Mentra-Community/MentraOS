#!/usr/bin/env bash
# Prepare an emulator (or USB device) for unattended harness runs.
#
# The single biggest source of silent skew is a SYSTEM dialog the app's React
# tree can't see: an Android runtime-permission prompt ("Allow Mentra to record
# audio?") that pops on first mic/camera/location use and sits on top of every
# screen. Pre-granting every dangerous permission means no dialog ever appears,
# so the sweep and scenarios see the real app, not a prompt. Also (re)establishes
# the adb-reverse tunnels the bridge + Metro need.
#
#   tools/mentra-agent/setup-emulator.sh [serial] [metro-port]
set -euo pipefail

SERIAL="${1:-emulator-5554}"
METRO_PORT="${2:-8082}"
PKG="com.mentra.mentra"

echo "preparing $SERIAL for harness runs..."

# Runtime (dangerous) permissions — pm grant no-ops/errors on normal perms, so
# tolerate failures. Covers the mic/camera/location/notification/BT prompts.
for p in RECORD_AUDIO CAMERA ACCESS_FINE_LOCATION ACCESS_COARSE_LOCATION \
         ACCESS_BACKGROUND_LOCATION POST_NOTIFICATIONS \
         BLUETOOTH_CONNECT BLUETOOTH_SCAN BLUETOOTH_ADVERTISE \
         READ_PHONE_STATE CALL_PHONE READ_PHONE_NUMBERS; do
  adb -s "$SERIAL" shell pm grant "$PKG" "android.permission.$p" 2>/dev/null \
    && echo "  granted $p" || true
done

# adb-reverse tunnels: 8081 (app's default Metro port) -> your Metro; 8787 ->
# the harness bridge. localhost-over-adb-reverse is also what keeps the bridge
# alive through network-drop fault scenarios.
adb -s "$SERIAL" reverse tcp:8081 "tcp:$METRO_PORT" >/dev/null && echo "  reverse 8081 -> $METRO_PORT (metro)"
adb -s "$SERIAL" reverse tcp:8787 tcp:8787 >/dev/null && echo "  reverse 8787 (bridge)"

echo "done. (re)launch the app and the bridge will connect."
