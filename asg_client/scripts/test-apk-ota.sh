#!/bin/bash
#
# Test ASG Client APK OTA update end-to-end
#
# Usage: ./scripts/test-apk-ota.sh [path-to-release.apk]
#
# If no path provided, builds a release APK automatically.
#
# How it works:
#   1. Computes SHA256 of the APK
#   2. Generates a version.json with versionCode = current + 1
#   3. Starts a local HTTP server serving the APK and JSON
#   4. Sets up ADB reverse port forwarding (glasses localhost:8080 -> computer:8080)
#   5. Triggers OTA check via broadcast with the local URL
#   6. Monitors logcat for OTA progress
#
# The glasses download the APK over HTTP through the USB connection,
# exercising the full OTA download+install path.
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ASG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PORT=${OTA_TEST_PORT:-9876}
SERVE_DIR=$(mktemp -d)

cleanup() {
    echo ""
    echo "🧹 Cleaning up..."
    # Kill the HTTP server
    if [ -n "$HTTP_PID" ] && kill -0 "$HTTP_PID" 2>/dev/null; then
        kill "$HTTP_PID" 2>/dev/null || true
    fi
    # Remove ADB reverse forwarding
    adb reverse --remove tcp:$PORT 2>/dev/null || true
    # Clean up temp directory
    rm -rf "$SERVE_DIR"
    echo "✅ Cleanup complete"
}
trap cleanup EXIT

# --- Determine APK path ---
if [ -n "$1" ]; then
    APK_PATH="$1"
    if [ ! -f "$APK_PATH" ]; then
        echo "❌ APK not found: $APK_PATH"
        exit 1
    fi
else
    echo "No APK specified. Building release APK..."
    cd "$ASG_DIR"
    ./gradlew assembleRelease
    APK_PATH="$ASG_DIR/app/build/outputs/apk/release/app-release.apk"
    if [ ! -f "$APK_PATH" ]; then
        echo "❌ Build failed - release APK not found at $APK_PATH"
        exit 1
    fi
fi

echo "=========================================="
echo "🔧 APK OTA Test"
echo "=========================================="
echo "APK: $APK_PATH"
echo "Size: $(ls -lh "$APK_PATH" | awk '{print $5}')"
echo ""

# --- Get current versionCode from device ---
CURRENT_VERSION=$(adb shell dumpsys package com.mentra.asg_client 2>/dev/null | grep versionCode | head -1 | sed 's/.*versionCode=\([0-9]*\).*/\1/')
if [ -z "$CURRENT_VERSION" ]; then
    echo "⚠️  Could not read versionCode from device, using 0"
    CURRENT_VERSION=0
fi
TEST_VERSION=$((CURRENT_VERSION + 1))
echo "Device versionCode: $CURRENT_VERSION"
echo "Test versionCode:   $TEST_VERSION (forces update)"

# --- Compute SHA256 ---
if command -v shasum &>/dev/null; then
    SHA256=$(shasum -a 256 "$APK_PATH" | awk '{print $1}')
elif command -v sha256sum &>/dev/null; then
    SHA256=$(sha256sum "$APK_PATH" | awk '{print $1}')
else
    echo "❌ No sha256 tool found (need shasum or sha256sum)"
    exit 1
fi
echo "SHA256: $SHA256"

# --- Copy APK and generate version JSON ---
cp "$APK_PATH" "$SERVE_DIR/update.apk"

cat > "$SERVE_DIR/version.json" <<EOF
{
  "apps": {
    "com.mentra.asg_client": {
      "versionCode": $TEST_VERSION,
      "versionName": "$TEST_VERSION.0",
      "apkUrl": "http://localhost:$PORT/update.apk",
      "sha256": "$SHA256"
    }
  }
}
EOF

echo ""
echo "📄 Generated version.json:"
cat "$SERVE_DIR/version.json"
echo ""

# --- Start HTTP server ---
echo "🌐 Starting HTTP server on port $PORT..."
cd "$SERVE_DIR"
python3 -m http.server $PORT &
HTTP_PID=$!
sleep 1

if ! kill -0 "$HTTP_PID" 2>/dev/null; then
    echo "❌ HTTP server failed to start. Is port $PORT in use?"
    exit 1
fi
echo "✅ HTTP server running (PID: $HTTP_PID)"

# --- Set up ADB reverse port forwarding ---
echo "🔌 Setting up ADB reverse port forwarding (device:$PORT -> host:$PORT)..."
adb reverse tcp:$PORT tcp:$PORT
echo "✅ ADB reverse forwarding active"
echo ""

# --- Clear OTA cache on device ---
echo "🗑️  Clearing OTA cache on device..."
adb shell rm -f /storage/emulated/0/asg/asg_client_update.apk
adb shell "rm -f /data/data/com.mentra.asg_client/shared_prefs/ota_cache_state.xml" 2>/dev/null || true
echo "✅ Cache cleared"
echo ""

# --- Trigger OTA ---
echo "🚀 Triggering APK OTA check..."
adb shell am broadcast \
    -a com.mentra.DEBUG_APK_OTA \
    --es url "http://localhost:$PORT/version.json" \
    -n com.mentra.asg_client/.receiver.DebugApkOtaReceiver

echo ""
echo "📋 Monitoring logs (Ctrl+C to exit)..."
echo "=========================================="
adb logcat -c && adb logcat | grep -E "(ASGClientOTA|DebugApkOta|OtaHelper|OtaService)"
