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
#   --full                   Use a selected full A/B ZIP; --end-firmware is required
# Requires an ASG build with the MTK-only self-reboot behavior (current builds).
#

set -euo pipefail

if [ -n "${ADB_SERIAL:-}" ] && [ -z "${ANDROID_SERIAL:-}" ]; then
    export ANDROID_SERIAL="$ADB_SERIAL"
fi

PORT=${OTA_TEST_PORT:-9876}
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WAIT_SECONDS=20
MAX_TRIGGER_ATTEMPTS=3
TRIGGER_RETRY_DELAY_SECONDS=8
TRIGGER_ACTIVITY_TIMEOUT_SECONDS=15
MTK_UPDATE_TIMEOUT_SECONDS=900
SERVE_DIR="$(mktemp -d)"
REVERSE_CREATED=false
FULL_OTA=false
PATCH_PATH=""
START_FIRMWARE_OVERRIDE=""
END_FIRMWARE_OVERRIDE=""
APP_COMPONENT="com.mentra.asg_client/com.mentra.asg_client.MainActivity"
DEBUG_RECEIVER_COMPONENT="com.mentra.asg_client/.receiver.DebugMtkOtaReceiver"

usage() {
    echo "Usage: ./scripts/test-mtk-ota.sh path/to/mtk_firmware_<start>_<end>.zip [--start-firmware VALUE] [--end-firmware VALUE] [--port PORT]"
    echo "       ./scripts/test-mtk-ota.sh path/to/full.zip --full --end-firmware MentraLive_YYYYMMDD[.N] [--port PORT]"
}

cleanup() {
    echo ""
    echo "🧹 Cleaning up..."
    if [ -n "${HTTP_PID:-}" ] && kill -0 "$HTTP_PID" 2>/dev/null; then
        kill "$HTTP_PID" 2>/dev/null || true
    fi
    if [ "$REVERSE_CREATED" = true ]; then
        adb reverse --remove "tcp:$PORT" 2>/dev/null || true
    fi
    rm -rf "$SERVE_DIR"
    echo "✅ Cleanup complete"
}
trap cleanup EXIT

fail() {
    echo ""
    echo "❌ $1"
    exit 1
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
    # One monotonic deadline owns logcat and every postboot read, including EOF.
    python3 "$SCRIPT_DIR/mtk-ota-observe.py" \
        --source-boot "$SOURCE_BOOT" --source-cid "$SOURCE_CID" \
        --target-version "$END_FIRMWARE" --target-slot "$TARGET_SLOT" \
        --timeout "$MTK_UPDATE_TIMEOUT_SECONDS" \
        --activity-timeout "$TRIGGER_ACTIVITY_TIMEOUT_SECONDS"
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
        --full)
            FULL_OTA=true
            shift
            ;;
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

DEVICE_VERSION="$(adb shell getprop ro.custom.ota.version 2>/dev/null | tr -d '\r\n')"
if [ -z "$DEVICE_VERSION" ]; then
    fail "Failed to read ro.custom.ota.version from device"
fi

# Serve precisely the bytes inspected and hashed below.
mkdir "$SERVE_DIR/input"
OTA_COPY="$SERVE_DIR/input/$(basename "$PATCH_PATH")"
cp "$PATCH_PATH" "$OTA_COPY"
MANIFEST_ARGS=("$SCRIPT_DIR/mtk-ota-manifest.py" "$OTA_COPY" --device-version "$DEVICE_VERSION" --port "$PORT")
[ "$FULL_OTA" = false ] || MANIFEST_ARGS+=(--full)
if [ "$FULL_OTA" = true ]; then MAX_TRIGGER_ATTEMPTS=1; fi
[ -z "$START_FIRMWARE_OVERRIDE" ] || MANIFEST_ARGS+=(--start-firmware "$START_FIRMWARE_OVERRIDE")
[ -z "$END_FIRMWARE_OVERRIDE" ] || MANIFEST_ARGS+=(--end-firmware "$END_FIRMWARE_OVERRIDE")
python3 "${MANIFEST_ARGS[@]}" > "$SERVE_DIR/version.json" || fail "Invalid OTA selection"
read -r START_FIRMWARE END_FIRMWARE SHA256 < <(python3 -c 'import json,sys; p=json.load(open(sys.argv[1]))["mtk_patches"][0]; print(p["start_firmware"], p["end_firmware"], p["sha256"])' "$SERVE_DIR/version.json")
mv "$OTA_COPY" "$SERVE_DIR/mtk_firmware.zip"
SOURCE_BOOT="$(adb shell cat /proc/sys/kernel/random/boot_id | tr -d '\r\n')"
SOURCE_CID="$(adb shell cat /sys/block/mmcblk0/device/cid | tr -d '\r\n')"
SOURCE_SLOT="$(adb shell getprop ro.boot.slot_suffix | tr -d '\r\n')"
[[ "$SOURCE_BOOT" =~ ^[0-9a-f-]{36}$ && "$SOURCE_CID" =~ ^[0-9a-fA-F]{32}$ ]] || fail "Missing source boot/eMMC identity"
case "$SOURCE_SLOT" in
    _a) TARGET_SLOT=_b ;;
    _b) TARGET_SLOT=_a ;;
    *) fail "Unknown source A/B slot" ;;
esac

echo "=========================================="
echo "🔧 MTK OTA Test"
echo "=========================================="
echo "Patch:          $PATCH_PATH"
echo "Patch size:     $(ls -lh "$PATCH_PATH" | awk '{print $5}')"
echo "Patch SHA256:   $SHA256"
echo "Device version: $DEVICE_VERSION"
echo "Start firmware: $START_FIRMWARE"
echo "End firmware:   $END_FIRMWARE"
echo "Full A/B mode:  $FULL_OTA (POWERWASH follows the inspected ZIP metadata)"
echo "Port:           $PORT"

print_phase "🌐 Starting HTTP server on port $PORT..."
cd "$SERVE_DIR"
python3 -m http.server --bind 127.0.0.1 "$PORT" > /dev/null 2>&1 &
HTTP_PID=$!
sleep 1

if ! kill -0 "$HTTP_PID" 2>/dev/null; then
    fail "HTTP server failed to start. Is port $PORT in use?"
fi
echo "✅ HTTP server running"

print_phase "🔌 Setting up ADB reverse port forwarding..."
adb reverse --no-rebind "tcp:$PORT" "tcp:$PORT" >/dev/null
REVERSE_CREATED=true
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
