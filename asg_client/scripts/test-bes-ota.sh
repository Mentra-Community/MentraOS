#!/bin/bash
#
# Test BES firmware OTA update
# Usage: ./scripts/test-bes-ota.sh [path-to-firmware.bin]
#
# If no path provided, uses bes_firmware.bin in the same directory as this script.
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEFAULT_FIRMWARE="$SCRIPT_DIR/bes_firmware.bin"

if [ -z "$1" ]; then
    if [ -f "$DEFAULT_FIRMWARE" ]; then
        FIRMWARE_PATH="$DEFAULT_FIRMWARE"
        echo "Using default firmware: $FIRMWARE_PATH"
    else
        echo "Usage: ./scripts/test-bes-ota.sh [path-to-firmware.bin]"
        echo "Or place bes_firmware.bin next to this script."
        exit 1
    fi
else
    FIRMWARE_PATH="$1"
fi

if [ ! -f "$FIRMWARE_PATH" ]; then
    echo "❌ Firmware file not found: $FIRMWARE_PATH"
    exit 1
fi

echo "=========================================="
echo "🔧 BES OTA Test"
echo "=========================================="
echo "Firmware: $FIRMWARE_PATH"
echo "Size: $(ls -lh "$FIRMWARE_PATH" | awk '{print $5}')"
echo ""

echo "📤 Pushing firmware to glasses..."
adb push "$FIRMWARE_PATH" /storage/emulated/0/asg/bes_firmware.bin

echo ""
echo "🚀 Triggering BES OTA..."
adb shell am broadcast -a com.mentra.DEBUG_BES_OTA -n com.mentra.asg_client/.receiver.DebugBesOtaReceiver

echo ""
echo "📋 Monitoring logs (Ctrl+C to exit)..."
echo "=========================================="
adb logcat -c && adb logcat | grep -E "(BesOta|DebugBesOta|K900CommandHandler.*ota|mh_ota|hm_ota)"
