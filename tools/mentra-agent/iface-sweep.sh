#!/usr/bin/env bash
# Sweep the remaining SDK Tester ifaces via CDP, one invoke per service, and
# collect results from the dev-server log (miniapp UI console) + logcat.
set -uo pipefail
cd "$(dirname "$0")"
DEVLOG=/tmp/example-miniapp-dev.log
fire() { # fire <tag> <iface> <method> [argsJson]
  local tag=$1 iface=$2 method=$3 args=${4:-[]}
  bun cdp.ts eval "mentra.request(\"tester:invoke\", {iface: \"$iface\", method: \"$method\", args: $args}).then(r=>console.log(\"[$tag-OK]\", JSON.stringify(r).slice(0,200))).catch(()=>console.log(\"[$tag-ERR]\")); \"fired\"" >/dev/null 2>&1
  echo "fired $iface.$method"
}

fire TTS speaker speak '["conformance test of text to speech"]'
sleep 6
fire LOC location getOnce
sleep 6
fire SYS system copyToClipboard '["conformance-clipboard"]'
sleep 4

echo "=== results (dev log) ==="
grep -E "TTS-OK|TTS-ERR|LOC-OK|LOC-ERR|SYS-OK|SYS-ERR|tester\]" "$DEVLOG" | tail -10
echo "=== glasses battery via app (real Live battery through remote bridge) ==="
adb -s emulator-5554 logcat -d -t 300 2>/dev/null | grep -iE "battery" | grep -vE "BatteryService|healthd" | tail -2
