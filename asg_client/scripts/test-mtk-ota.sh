#!/bin/bash
#
# Test MTK firmware OTA update end-to-end via ASG Client's debug OTA path.
#
# Usage:
#   ./scripts/test-mtk-ota.sh path/to/mtk_firmware_20260204_20260421.zip
#
# Optional flags:
#   --start-firmware VALUE   Override start_firmware in generated version.json
#   --end-firmware VALUE     Override end_firmware in generated version.json
#   --port PORT              Override local HTTP server port (default: 9876)
#
# How it works:
#   1. Reads the device's current MTK firmware version via adb
#   2. Parses the patch filename for start/end date tokens
#   3. Generates an MTK-only version.json with a matching patch entry
#   4. Starts a local HTTP server serving the patch zip and JSON
#   5. Sets up ADB reverse port forwarding (glasses localhost:PORT -> host:PORT)
#   6. Triggers MTK OTA via DebugMtkOtaReceiver
#   7. Monitors logcat for OTA progress until interrupted or ADB disconnects
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT=${OTA_TEST_PORT:-9876}
SERVE_DIR="$(mktemp -d)"
LOG_FILE="$(mktemp /tmp/test-mtk-ota.XXXXXX.log)"
PATCH_PATH=""
START_FIRMWARE_OVERRIDE=""
END_FIRMWARE_OVERRIDE=""

usage() {
    echo "Usage: ./scripts/test-mtk-ota.sh path/to/mtk_firmware_<start>_<end>.zip [--start-firmware VALUE] [--end-firmware VALUE] [--port PORT]"
}

cleanup() {
    echo ""
    echo "🧹 Cleaning up..."
    if [ -n "${HTTP_PID:-}" ] && kill -0 "$HTTP_PID" 2>/dev/null; then
        kill "$HTTP_PID" 2>/dev/null || true
    fi
    adb reverse --remove tcp:$PORT 2>/dev/null || true
    rm -rf "$SERVE_DIR"
    echo "📝 Log file: $LOG_FILE"
    echo "✅ Cleanup complete"
}
trap cleanup EXIT

extract_trailing_date() {
    local value="$1"
    if [[ "$value" =~ ([0-9]{8})$ ]]; then
        echo "${BASH_REMATCH[1]}"
        return 0
    fi
    return 1
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --start-firmware)
            START_FIRMWARE_OVERRIDE="${2:-}"
            shift 2
            ;;
        --end-firmware)
            END_FIRMWARE_OVERRIDE="${2:-}"
            shift 2
            ;;
        --port)
            PORT="${2:-}"
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        -*)
            echo "❌ Unknown option: $1"
            usage
            exit 1
            ;;
        *)
            if [ -n "$PATCH_PATH" ]; then
                echo "❌ Multiple patch paths provided"
                usage
                exit 1
            fi
            PATCH_PATH="$1"
            shift
            ;;
    esac
done

if [ -z "$PATCH_PATH" ]; then
    usage
    exit 1
fi

if [ ! -f "$PATCH_PATH" ]; then
    echo "❌ Patch file not found: $PATCH_PATH"
    exit 1
fi

PATCH_NAME="$(basename "$PATCH_PATH")"
if [[ "$PATCH_NAME" =~ ([0-9]{8})_([0-9]{8})\.zip$ ]]; then
    FILE_START_DATE="${BASH_REMATCH[1]}"
    FILE_END_DATE="${BASH_REMATCH[2]}"
else
    echo "❌ Could not parse start/end dates from filename: $PATCH_NAME"
    echo "   Expected something like: mtk_firmware_20260204_20260421.zip"
    exit 1
fi

DEVICE_VERSION="$(adb shell getprop ro.custom.ota.version 2>/dev/null | tr -d '\r\n')"
if [ -z "$DEVICE_VERSION" ]; then
    echo "❌ Failed to read ro.custom.ota.version from device"
    exit 1
fi

if ! DEVICE_START_DATE="$(extract_trailing_date "$DEVICE_VERSION")"; then
    echo "❌ Device firmware version does not end with YYYYMMDD: $DEVICE_VERSION"
    exit 1
fi

START_FIRMWARE="${START_FIRMWARE_OVERRIDE:-$DEVICE_VERSION}"
if ! START_DATE="$(extract_trailing_date "$START_FIRMWARE")"; then
    echo "❌ start_firmware does not end with YYYYMMDD: $START_FIRMWARE"
    exit 1
fi

if [ "$FILE_START_DATE" != "$START_DATE" ]; then
    echo "❌ Patch start date ($FILE_START_DATE) does not match start_firmware date ($START_DATE)"
    echo "   Device reports: $DEVICE_VERSION"
    echo "   Patch file: $PATCH_NAME"
    exit 1
fi

if [ -n "$END_FIRMWARE_OVERRIDE" ]; then
    END_FIRMWARE="$END_FIRMWARE_OVERRIDE"
else
    END_FIRMWARE="${START_FIRMWARE%$START_DATE}$FILE_END_DATE"
fi

if command -v shasum >/dev/null 2>&1; then
    SHA256="$(shasum -a 256 "$PATCH_PATH" | awk '{print $1}')"
elif command -v sha256sum >/dev/null 2>&1; then
    SHA256="$(sha256sum "$PATCH_PATH" | awk '{print $1}')"
else
    echo "❌ No sha256 tool found (need shasum or sha256sum)"
    exit 1
fi

cp "$PATCH_PATH" "$SERVE_DIR/mtk_firmware.zip"

cat > "$SERVE_DIR/version.json" <<EOF
{
  "apps": {},
  "mtk_patches": [
    {
      "start_firmware": "$START_FIRMWARE",
      "end_firmware": "$END_FIRMWARE",
      "url": "http://localhost:$PORT/mtk_firmware.zip",
      "sha256": "$SHA256"
    }
  ]
}
EOF

echo "=========================================="
echo "🔧 MTK OTA Test"
echo "=========================================="
echo "Patch:            $PATCH_PATH"
echo "Patch size:       $(ls -lh "$PATCH_PATH" | awk '{print $5}')"
echo "Patch SHA256:     $SHA256"
echo "Device version:   $DEVICE_VERSION"
echo "Start firmware:   $START_FIRMWARE"
echo "End firmware:     $END_FIRMWARE"
echo "Port:             $PORT"
echo "Log file:         $LOG_FILE"
echo ""
echo "📄 Generated version.json:"
cat "$SERVE_DIR/version.json"
echo ""

echo "🌐 Starting HTTP server on port $PORT..."
cd "$SERVE_DIR"
python3 -m http.server "$PORT" > /dev/null 2>&1 &
HTTP_PID=$!
sleep 1

if ! kill -0 "$HTTP_PID" 2>/dev/null; then
    echo "❌ HTTP server failed to start. Is port $PORT in use?"
    exit 1
fi
echo "✅ HTTP server running (PID: $HTTP_PID)"

echo "🔌 Setting up ADB reverse port forwarding (device:$PORT -> host:$PORT)..."
adb reverse "tcp:$PORT" "tcp:$PORT"
echo "✅ ADB reverse forwarding active"
echo ""

echo "🗑️  Clearing MTK OTA cache on device..."
adb shell rm -f /storage/emulated/0/asg/mtk_firmware.zip
adb shell rm -f /storage/emulated/0/asg/mtk_firmware_backup.zip
adb shell "rm -f /data/data/com.mentra.asg_client/shared_prefs/ota_cache_state.xml" 2>/dev/null || true
echo "✅ Cache cleared"
echo ""

echo "🧼 Clearing logcat buffer..."
adb logcat -c
echo "✅ Logcat cleared"
echo ""

echo "🚀 Triggering MTK OTA check..."
adb shell am broadcast \
    -a com.mentra.DEBUG_MTK_OTA \
    --es url "http://localhost:$PORT/version.json" \
    -n com.mentra.asg_client/.receiver.DebugMtkOtaReceiver

echo ""
echo "📋 Monitoring logs (Ctrl+C to exit)..."
echo "=========================================="
adb logcat | grep -E "(ASGClientOTA|DebugMtkOta|MtkOtaReceiver|OtaHelper|OtaService|SysControl)" | tee "$LOG_FILE"
