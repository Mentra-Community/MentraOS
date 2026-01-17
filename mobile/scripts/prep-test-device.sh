#!/bin/bash
# Prepares a physical Android device for Maestro E2E testing
# Run this before any Maestro test session
#
# Supports ANDROID_SERIAL env var for multi-device setups:
#   ANDROID_SERIAL=ABC123 ./scripts/prep-test-device.sh

set -e

# Use specific device if ANDROID_SERIAL is set, otherwise auto-detect
ADB_CMD="adb"
if [ -n "$ANDROID_SERIAL" ]; then
    ADB_CMD="adb -s $ANDROID_SERIAL"
    echo "=== Preparing device $ANDROID_SERIAL for E2E testing ==="
else
    echo "=== Preparing Android device for E2E testing ==="
fi

# Check device is connected
if ! $ADB_CMD devices | grep -q "device$"; then
    echo "ERROR: No Android device connected"
    echo "Connect a device via USB and enable USB debugging"
    exit 1
fi

if [ -n "$ANDROID_SERIAL" ]; then
    DEVICE_ID="$ANDROID_SERIAL"
else
    DEVICE_ID=$($ADB_CMD devices | grep "device$" | head -1 | cut -f1)
fi
echo "Found device: $DEVICE_ID"

# Wake the device
echo "Waking device..."
$ADB_CMD shell input keyevent KEYCODE_WAKEUP
sleep 0.5

# Dismiss lock screen (swipe up) - works if no PIN/pattern
echo "Dismissing lock screen..."
$ADB_CMD shell input swipe 540 2000 540 1000 300

# Keep screen on while plugged in (1=AC, 2=USB, 4=Wireless, 3=AC+USB)
echo "Setting stay-on while plugged in..."
$ADB_CMD shell settings put global stay_on_while_plugged_in 3

# Set screen timeout to 30 minutes as fallback
echo "Setting screen timeout to 30 minutes..."
$ADB_CMD shell settings put system screen_off_timeout 1800000

# Dim brightness to 30/255 (~12%)
echo "Dimming screen brightness..."
$ADB_CMD shell settings put system screen_brightness 30
$ADB_CMD shell settings put system screen_brightness_mode 0

# Disable heads-up notifications (reduces test flakiness)
echo "Disabling heads-up notifications..."
$ADB_CMD shell settings put global heads_up_notifications_enabled 0

# Disable animations for faster, more reliable tests
echo "Disabling animations..."
$ADB_CMD shell settings put global window_animation_scale 0.0
$ADB_CMD shell settings put global transition_animation_scale 0.0
$ADB_CMD shell settings put global animator_duration_scale 0.0

# Setup test audio directory
# We use the app's external files directory which doesn't require special permissions
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_AUDIO_DIR="$SCRIPT_DIR/../.maestro/test-audio"
# App's external files dir - accessible without permissions
DEVICE_TEST_DIR="/sdcard/Android/data/com.mentra.mentra/files/test-audio"

echo "Setting up test audio..."
# Create directory (may fail if app hasn't been run yet, that's ok)
$ADB_CMD shell "mkdir -p $DEVICE_TEST_DIR" 2>/dev/null || true

# Fallback: also try the Download folder for older Android versions
DEVICE_FALLBACK_DIR="/sdcard/Download/mentra-test"
$ADB_CMD shell "rm -rf $DEVICE_FALLBACK_DIR && mkdir -p $DEVICE_FALLBACK_DIR" 2>/dev/null || true

# Push test audio files if they exist
if [ -d "$TEST_AUDIO_DIR" ]; then
    for wav in "$TEST_AUDIO_DIR"/*.wav; do
        if [ -f "$wav" ]; then
            filename=$(basename "$wav")
            echo "  Pushing $filename..."
            # Push to app's directory (preferred)
            $ADB_CMD push "$wav" "$DEVICE_TEST_DIR/" > /dev/null 2>&1 || true
            # Also push to Download as fallback
            $ADB_CMD push "$wav" "$DEVICE_FALLBACK_DIR/" > /dev/null 2>&1 || true
        fi
    done
    echo "  Test audio files pushed to device"
else
    echo "  WARNING: No test audio directory found at $TEST_AUDIO_DIR"
fi

echo ""
echo "=== Device ready for testing ==="
echo "Device: $DEVICE_ID"
echo "Test audio: $DEVICE_TEST_DIR"
echo ""
