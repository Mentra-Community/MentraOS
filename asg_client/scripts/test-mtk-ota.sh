#!/bin/bash
#
# Clean operator-focused MTK OTA test flow.
#
# Usage:
#   ./scripts/test-mtk-ota.sh path/to/mtk_firmware_20260204_20260421.zip
#
# Optional flags:
#   --start-firmware VALUE   Override start_firmware in generated version.json
#   --end-firmware VALUE     Override end_firmware in generated version.json
#   --port PORT              Override local HTTP server port (default: 9876)
#

set -euo pipefail

PORT=${OTA_TEST_PORT:-9876}
WAIT_SECONDS=20
MAX_TRIGGER_ATTEMPTS=3
TRIGGER_RETRY_DELAY_SECONDS=8
TRIGGER_ACTIVITY_TIMEOUT_SECONDS=15
SERVE_DIR="$(mktemp -d)"
PATCH_PATH=""
START_FIRMWARE_OVERRIDE=""
END_FIRMWARE_OVERRIDE=""
APP_COMPONENT="com.mentra.asg_client/com.mentra.asg_client.MainActivity"
DEBUG_RECEIVER_COMPONENT="com.mentra.asg_client/.receiver.DebugMtkOtaReceiver"

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
    echo "✅ Cleanup complete"
}
trap cleanup EXIT

fail() {
    echo ""
    echo "❌ $1"
    exit 1
}

extract_trailing_date() {
    local value="$1"
    if [[ "$value" =~ ([0-9]{8})$ ]]; then
        echo "${BASH_REMATCH[1]}"
        return 0
    fi
    return 1
}

print_phase() {
    echo ""
    echo "$1"
}

start_app_and_wait() {
    print_phase "🚀 Launching ASG Client..."
    adb shell am start -n "$APP_COMPONENT" >/dev/null 2>&1 || fail "Failed to launch ASG Client"

    echo "ℹ️  This process takes about 5 minutes. Keep your Mentra Live plugged in and do not disconnect it."
    for ((remaining=WAIT_SECONDS; remaining>0; remaining--)); do
        printf "\r⏳ Waiting to start: %2ds remaining..." "$remaining"
        sleep 1
    done
    printf "\r⏳ Waiting to start:  0s remaining...\n"
}

trigger_mtk_ota() {
    local attempt="$1"
    print_phase "🚀 Starting MTK OTA (attempt ${attempt}/${MAX_TRIGGER_ATTEMPTS})..."
    adb shell am broadcast \
        -a com.mentra.DEBUG_MTK_OTA \
        --es url "http://localhost:$PORT/version.json" \
        -n "$DEBUG_RECEIVER_COMPONENT" >/dev/null || fail "Failed to send MTK OTA trigger broadcast"
}

monitor_update() {
    local last_download=-1
    local last_install=-1
    local line=""
    local progress=0
    local raw_progress=0
    local idle_seconds=0
    local saw_activity=0

    exec 3< <(adb logcat -v time)
    while true; do
        if IFS= read -r -t 1 line <&3; then
            idle_seconds=0
        else
            idle_seconds=$((idle_seconds + 1))
            if [ "$saw_activity" -eq 0 ] && [ "$idle_seconds" -ge "$TRIGGER_ACTIVITY_TIMEOUT_SECONDS" ]; then
                exec 3<&-
                return 3
            fi
            continue
        fi

        if [[ "$line" == *"OtaHelper not initialized - is OtaService running?"* ]]; then
            exec 3<&-
            return 2
        fi

        if [[ "$line" == *"Failed to download MTK firmware"* ]] || \
           [[ "$line" == *"MTK firmware verification failed"* ]] || \
           [[ "$line" == *"MTK OTA error:"* ]]; then
            exec 3<&-
            fail "$line"
        fi

        if [[ "$line" == *"MTK OTA source URL:"* ]]; then
            saw_activity=1
            echo "📥 Downloading MTK patch..."
            continue
        fi

        if [[ "$line" =~ MTK\ firmware\ download\ progress:\ ([0-9]+)% ]]; then
            saw_activity=1
            progress="${BASH_REMATCH[1]}"
            if [ "$progress" -ne "$last_download" ]; then
                echo "📥 Downloading MTK patch: ${progress}%"
                last_download="$progress"
            fi
            continue
        fi

        if [[ "$line" == *"MTK firmware downloaded to:"* ]]; then
            saw_activity=1
            if [ "$last_download" -lt 100 ]; then
                echo "📥 Downloading MTK patch: 100%"
                last_download=100
            fi
            continue
        fi

        if [[ "$line" =~ MTK\ OTA\ update\ -\ cmd:\ write,\ msg:\ ([0-9]+) ]]; then
            saw_activity=1
            raw_progress="${BASH_REMATCH[1]}"
            progress=$((raw_progress / 2))
            if [ "$progress" -gt "$last_install" ]; then
                echo "🛠️ Installing MTK firmware: ${progress}%"
                last_install="$progress"
            fi
            continue
        fi

        if [[ "$line" =~ MTK\ OTA\ update\ -\ cmd:\ update,\ msg:\ ([0-9]+) ]]; then
            saw_activity=1
            raw_progress="${BASH_REMATCH[1]}"
            progress=$((50 + (raw_progress / 2)))
            if [ "$progress" -gt "$last_install" ]; then
                echo "🛠️ Installing MTK firmware: ${progress}%"
                last_install="$progress"
            fi
            continue
        fi

        if [[ "$line" == *'"type":"mtk_update_complete"'* ]] || \
           [[ "$line" == *"MTK OTA success:"* ]]; then
            exec 3<&-
            echo "✅ Complete. Rebooting glasses..."
            if adb shell reboot >/dev/null 2>&1; then
                echo "✅ Reboot command sent"
            else
                echo "⚠️  ADB disconnected before reboot completed. This can be expected after the update."
            fi
            echo "ℹ️  Done! Please wait for the glasses to reboot..."
            return 0
        fi
    done
}

run_mtk_ota() {
    local attempt=1
    local status=0

    while [ "$attempt" -le "$MAX_TRIGGER_ATTEMPTS" ]; do
        print_phase "🧼 Resetting logcat for OTA progress tracking..."
        adb logcat -c
        echo "✅ Progress log buffer cleared"

        trigger_mtk_ota "$attempt"

        set +e
        monitor_update
        status=$?
        set -e

        if [ "$status" -eq 0 ]; then
            return 0
        fi
        if [ "$status" -eq 2 ]; then
            if [ "$attempt" -lt "$MAX_TRIGGER_ATTEMPTS" ]; then
                echo "⚠️  OTA helper is not ready yet. Retrying in ${TRIGGER_RETRY_DELAY_SECONDS}s..."
                sleep "$TRIGGER_RETRY_DELAY_SECONDS"
                attempt=$((attempt + 1))
                continue
            fi
            fail "OTA helper never became ready after ${MAX_TRIGGER_ATTEMPTS} attempts"
        fi

        if [ "$status" -eq 3 ]; then
            fail "No MTK OTA activity detected within ${TRIGGER_ACTIVITY_TIMEOUT_SECONDS} seconds of the trigger"
        fi

        fail "MTK OTA monitoring exited unexpectedly with status ${status}"
    done
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
            fail "Unknown option: $1"
            ;;
        *)
            if [ -n "$PATCH_PATH" ]; then
                fail "Multiple patch paths provided"
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
    fail "Patch file not found: $PATCH_PATH"
fi

PATCH_NAME="$(basename "$PATCH_PATH")"
if [[ "$PATCH_NAME" =~ ([0-9]{8})_([0-9]{8})\.zip$ ]]; then
    FILE_START_DATE="${BASH_REMATCH[1]}"
    FILE_END_DATE="${BASH_REMATCH[2]}"
else
    fail "Could not parse start/end dates from filename: $PATCH_NAME"
fi

DEVICE_VERSION="$(adb shell getprop ro.custom.ota.version 2>/dev/null | tr -d '\r\n')"
if [ -z "$DEVICE_VERSION" ]; then
    fail "Failed to read ro.custom.ota.version from device"
fi

if ! DEVICE_START_DATE="$(extract_trailing_date "$DEVICE_VERSION")"; then
    fail "Device firmware version does not end with YYYYMMDD: $DEVICE_VERSION"
fi

START_FIRMWARE="${START_FIRMWARE_OVERRIDE:-$DEVICE_VERSION}"
if ! START_DATE="$(extract_trailing_date "$START_FIRMWARE")"; then
    fail "start_firmware does not end with YYYYMMDD: $START_FIRMWARE"
fi

if [ "$FILE_START_DATE" != "$START_DATE" ]; then
    fail "Patch start date ($FILE_START_DATE) does not match start_firmware date ($START_DATE)"
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
    fail "No sha256 tool found (need shasum or sha256sum)"
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
echo "Patch:          $PATCH_PATH"
echo "Patch size:     $(ls -lh "$PATCH_PATH" | awk '{print $5}')"
echo "Patch SHA256:   $SHA256"
echo "Device version: $DEVICE_VERSION"
echo "Start firmware: $START_FIRMWARE"
echo "End firmware:   $END_FIRMWARE"
echo "Port:           $PORT"

print_phase "🌐 Starting HTTP server on port $PORT..."
cd "$SERVE_DIR"
python3 -m http.server "$PORT" > /dev/null 2>&1 &
HTTP_PID=$!
sleep 1

if ! kill -0 "$HTTP_PID" 2>/dev/null; then
    fail "HTTP server failed to start. Is port $PORT in use?"
fi
echo "✅ HTTP server running"

print_phase "🔌 Setting up ADB reverse port forwarding..."
adb reverse "tcp:$PORT" "tcp:$PORT" >/dev/null
echo "✅ ADB reverse forwarding active"

print_phase "🗑️  Clearing MTK OTA cache on device..."
adb shell rm -f /storage/emulated/0/asg/mtk_firmware.zip
adb shell rm -f /storage/emulated/0/asg/mtk_firmware_backup.zip
adb shell "rm -f /data/data/com.mentra.asg_client/shared_prefs/ota_cache_state.xml" 2>/dev/null || true
echo "✅ Cache cleared"

print_phase "🧼 Clearing logcat buffer..."
adb logcat -c
echo "✅ Logcat cleared"

start_app_and_wait

run_mtk_ota
