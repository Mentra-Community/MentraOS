#!/bin/bash
#
# Test BES firmware OTA update
# Usage: ./scripts/test-bes-ota.sh <path-to-update_ota.bin> <target-version> [--no-follow]
#
# The artifact must be the release-packaged OTA container, never raw BES build output.
# Set ANDROID_SERIAL when more than one Android device may be attached.
#

set -euo pipefail

FIRMWARE_PATH="${1:-}"
TARGET_VERSION="${2:-}"
FOLLOW_LOGS=true

if [ -n "${4:-}" ]; then
    echo "Unknown option: $4"
    exit 1
elif [ "${3:-}" = "--no-follow" ]; then
    FOLLOW_LOGS=false
elif [ -n "${3:-}" ]; then
    echo "Unknown option: $3"
    exit 1
fi

if [ -z "$FIRMWARE_PATH" ] || [ -z "$TARGET_VERSION" ]; then
    echo "Usage: ./scripts/test-bes-ota.sh <path-to-update_ota.bin> <target-version> [--no-follow]"
    echo "Example: ANDROID_SERIAL=0123456789ABCDEF $0 ./update_ota.bin 17.26.7.9"
    exit 1
fi

if [ ! -f "$FIRMWARE_PATH" ]; then
    echo "❌ Firmware file not found: $FIRMWARE_PATH"
    exit 1
fi

if ! [[ "$TARGET_VERSION" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
    echo "❌ Target version must have four numeric components: $TARGET_VERSION"
    exit 1
fi
IFS=. read -r -a VERSION_COMPONENTS <<< "$TARGET_VERSION"
for component in "${VERSION_COMPONENTS[@]}"; do
    if ((10#$component > 255)); then
        echo "❌ Target version components must be in the 0-255 range: $TARGET_VERSION"
        exit 1
    fi
done

ADB=(adb)
DEVICE_SERIAL="${ANDROID_SERIAL:-${ADB_SERIAL:-}}"
if [ -n "$DEVICE_SERIAL" ]; then
    ADB+=( -s "$DEVICE_SERIAL" )
fi

"${ADB[@]}" get-state >/dev/null

if command -v shasum >/dev/null 2>&1; then
    FIRMWARE_SHA256="$(shasum -a 256 "$FIRMWARE_PATH" | awk '{print $1}')"
elif command -v sha256sum >/dev/null 2>&1; then
    FIRMWARE_SHA256="$(sha256sum "$FIRMWARE_PATH" | awk '{print $1}')"
else
    echo "❌ No SHA-256 tool found (need shasum or sha256sum)"
    exit 1
fi
ARTIFACT_ID="adb-${FIRMWARE_SHA256}.bin"
REMOTE_PATH="/storage/emulated/0/asg/debug_bes_${FIRMWARE_SHA256}.bin"
LEGACY_REMOTE_PATH="/storage/emulated/0/asg/bes_firmware.bin"
LEGACY_BACKUP_PATH="/storage/emulated/0/asg/bes_firmware.pre_adb_$$.bin"
LEGACY_PATH_STAGED=false
LEGACY_PATH_EXISTED=false

restore_legacy_path() {
    if [ "$LEGACY_PATH_STAGED" != true ]; then
        return 0
    fi
    "${ADB[@]}" shell rm -f "$LEGACY_REMOTE_PATH" >/dev/null 2>&1 || true
    if [ "$LEGACY_PATH_EXISTED" = true ]; then
        "${ADB[@]}" shell mv "$LEGACY_BACKUP_PATH" "$LEGACY_REMOTE_PATH" >/dev/null 2>&1 || {
            echo "❌ Could not restore pre-existing BES artifact from $LEGACY_BACKUP_PATH" >&2
            return 1
        }
    fi
    LEGACY_PATH_STAGED=false
}

trap restore_legacy_path EXIT

echo "=========================================="
echo "🔧 BES OTA Test"
echo "=========================================="
echo "Firmware: $FIRMWARE_PATH"
echo "Target: $TARGET_VERSION"
echo "Size: $(ls -lh "$FIRMWARE_PATH" | awk '{print $5}')"
echo "SHA-256: $FIRMWARE_SHA256"
echo ""

echo "📤 Pushing firmware to glasses..."
"${ADB[@]}" shell mkdir -p /storage/emulated/0/asg
"${ADB[@]}" push "$FIRMWARE_PATH" "$REMOTE_PATH"

REMOTE_SHA256="$("${ADB[@]}" shell sha256sum "$REMOTE_PATH" | awk '{print $1}' | tr -d '\r')"
if [ "$REMOTE_SHA256" != "$FIRMWARE_SHA256" ]; then
    echo "❌ Device SHA-256 mismatch after push"
    "${ADB[@]}" shell rm -f "$REMOTE_PATH"
    exit 1
fi

# ASG 36 predates target/hash extras and always reads this fixed path. Move any
# existing phone-owned artifact aside instead of overwriting its inode. ASG 36
# synchronously loads the debug file into memory during `am broadcast`; current
# ASG reads the separate hash-addressed path.
if "${ADB[@]}" shell test -e "$LEGACY_BACKUP_PATH"; then
    echo "❌ Refusing to overwrite stale compatibility backup: $LEGACY_BACKUP_PATH"
    exit 1
fi
if "${ADB[@]}" shell test -f "$LEGACY_REMOTE_PATH"; then
    "${ADB[@]}" shell mv "$LEGACY_REMOTE_PATH" "$LEGACY_BACKUP_PATH"
    LEGACY_PATH_EXISTED=true
fi
LEGACY_PATH_STAGED=true
"${ADB[@]}" shell cp "$REMOTE_PATH" "$LEGACY_REMOTE_PATH"
LEGACY_REMOTE_SHA256="$("${ADB[@]}" shell sha256sum "$LEGACY_REMOTE_PATH" | awk '{print $1}' | tr -d '\r')"
if [ "$LEGACY_REMOTE_SHA256" != "$FIRMWARE_SHA256" ]; then
    echo "❌ Device SHA-256 mismatch at legacy ASG 36 path"
    "${ADB[@]}" shell rm -f "$REMOTE_PATH" "$LEGACY_REMOTE_PATH"
    exit 1
fi

echo ""
echo "🚀 Triggering BES OTA..."
"${ADB[@]}" logcat -c
set +e
BROADCAST_OUTPUT="$("${ADB[@]}" shell am broadcast \
    -a com.mentra.DEBUG_BES_OTA \
    --es target_version "$TARGET_VERSION" \
    --es sha256 "$FIRMWARE_SHA256" \
    --es artifact_id "$ARTIFACT_ID" \
    -n com.mentra.asg_client/.receiver.DebugBesOtaReceiver 2>&1)"
BROADCAST_STATUS=$?
set -e
printf '%s\n' "$BROADCAST_OUTPUT"
restore_legacy_path
if [ "$BROADCAST_STATUS" -ne 0 ]; then
    echo "❌ BES OTA broadcast failed"
    exit "$BROADCAST_STATUS"
fi

if [ "$FOLLOW_LOGS" = false ]; then
    echo "✅ BES OTA triggered; log following disabled."
    exit 0
fi

echo ""
echo "📋 Monitoring logs (Ctrl+C to exit)..."
echo "=========================================="
"${ADB[@]}" logcat | grep --line-buffered -E "(BES-UART|BES_OTA_DIAG|BesOta|DebugBesOta|mh_ota|hm_ota|sr_syvr|cs_baud)"
