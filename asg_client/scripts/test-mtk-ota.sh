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
    if [ -n "${LOGCAT_PID:-}" ]; then
        kill "$LOGCAT_PID" 2>/dev/null || true
        wait "$LOGCAT_PID" 2>/dev/null || true
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

wait_for_target_boot() {
    # The existing OTA deadline covers installation and reboot; do not reset it.
    local current_boot="" current_slot="" current_version="" current_cid="" completed=""
    while [ "$SECONDS" -lt "$UPDATE_DEADLINE" ]; do
        current_boot="$(adb shell cat /proc/sys/kernel/random/boot_id 2>/dev/null | tr -d '\r\n')" || true
        if [ -n "$current_boot" ] && [ "$current_boot" != "$SOURCE_BOOT" ]; then
            completed="$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r\n')" || true
            if [ "$completed" = "1" ]; then
                current_version="$(adb shell getprop ro.custom.ota.version 2>/dev/null | tr -d '\r\n')" || true
                current_slot="$(adb shell getprop ro.boot.slot_suffix 2>/dev/null | tr -d '\r\n')" || true
                current_cid="$(adb shell cat /sys/block/mmcblk0/device/cid 2>/dev/null | tr -d '\r\n')" || true
                if [ -z "$current_version" ] || [ -z "$current_slot" ] || [ -z "$current_cid" ]; then
                    sleep 1
                    continue
                fi
                [ "$current_cid" = "$SOURCE_CID" ] || fail "Different eMMC identity after reboot"
                [ "$current_version" = "$END_FIRMWARE" ] || fail "Postboot firmware is $current_version, expected $END_FIRMWARE"
                [ "$current_slot" = "$TARGET_SLOT" ] || fail "Postboot slot is $current_slot, expected $TARGET_SLOT"
                local closing_boot=""
                closing_boot="$(adb shell cat /proc/sys/kernel/random/boot_id 2>/dev/null | tr -d '\r\n')" || true
                if [ -z "$closing_boot" ]; then sleep 1; continue; fi
                [ "$closing_boot" = "$current_boot" ] || fail "Boot changed during target verification"
                echo "✅ Verified target MTK on the new boot and slot."
                return 0
            fi
        fi
        sleep 1
    done
    fail "Target boot was not verified before the OTA deadline; do not resend the update"
}

monitor_update() {
    local last_download=-1
    local last_install=-1
    local line=""
    local progress=0
    local raw_progress=0
    local idle_seconds=0
    local saw_activity=0
    UPDATE_DEADLINE=$((SECONDS + MTK_UPDATE_TIMEOUT_SECONDS))

    exec 3< <(adb logcat -v time)
    LOGCAT_PID=$!
    while true; do
        if [ "$SECONDS" -ge "$UPDATE_DEADLINE" ]; then
            exec 3<&-
            fail "MTK OTA did not complete within $((MTK_UPDATE_TIMEOUT_SECONDS / 60)) minutes"
        fi
        if IFS= read -r -t 1 line <&3; then
            idle_seconds=0
        else
            if ! kill -0 "$LOGCAT_PID" 2>/dev/null; then
                exec 3<&-
                echo "ℹ️  Log stream closed. Checking the target boot without resending OTA..."
                wait_for_target_boot
                return 0
            fi
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
            echo "✅ Payload staged. Waiting for the ASG-owned MTK-only reboot..."
            wait_for_target_boot
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
