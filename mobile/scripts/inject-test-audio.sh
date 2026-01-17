#!/bin/bash
# Injects test audio into MentraOS via ADB broadcast
#
# Supports ANDROID_SERIAL env var for multi-device setups:
#   ANDROID_SERIAL=ABC123 ./scripts/inject-test-audio.sh kangaroos
#
# Usage:
#   ./scripts/inject-test-audio.sh                    # Uses hello-world.wav
#   ./scripts/inject-test-audio.sh kangaroos          # Uses hey-mentra-kangaroos.wav
#   ./scripts/inject-test-audio.sh president          # Uses hey-mentra-president.wav
#   ./scripts/inject-test-audio.sh numbers            # Uses numbers-count.wav
#   ./scripts/inject-test-audio.sh /full/path.wav     # Uses custom file

set -e

# Use specific device if ANDROID_SERIAL is set
ADB_CMD="adb"
if [ -n "$ANDROID_SERIAL" ]; then
    ADB_CMD="adb -s $ANDROID_SERIAL"
fi

# Primary: app's external files directory (no permissions needed)
DEVICE_TEST_DIR="/sdcard/Android/data/com.mentra.mentra/files/test-audio"
# Fallback for older Android or if app dir doesn't exist
DEVICE_FALLBACK_DIR="/sdcard/Download/mentra-test"

# Determine audio file
case "${1:-hello}" in
    kangaroos|kangaroo)
        AUDIO_FILE="hey-mentra-kangaroos.wav"
        ;;
    president)
        AUDIO_FILE="hey-mentra-president.wav"
        ;;
    numbers|count)
        AUDIO_FILE="numbers-count.wav"
        ;;
    hello|hello-world|"")
        AUDIO_FILE="hello-world.wav"
        ;;
    /*)
        # Full path provided
        FILE_PATH="$1"
        ;;
    *)
        # Assume it's a filename in the test dir
        AUDIO_FILE="$1"
        ;;
esac

# Build full path if not already set
if [ -z "$FILE_PATH" ]; then
    # Check which directory has the file
    if $ADB_CMD shell "test -f $DEVICE_TEST_DIR/$AUDIO_FILE" 2>/dev/null; then
        FILE_PATH="$DEVICE_TEST_DIR/$AUDIO_FILE"
    elif $ADB_CMD shell "test -f $DEVICE_FALLBACK_DIR/$AUDIO_FILE" 2>/dev/null; then
        FILE_PATH="$DEVICE_FALLBACK_DIR/$AUDIO_FILE"
    else
        echo "ERROR: Audio file not found on device: $AUDIO_FILE"
        echo "Run 'bun prep:device' to push test audio files"
        exit 1
    fi
fi

echo "Injecting test audio: $FILE_PATH"
if [ -n "$ANDROID_SERIAL" ]; then
    echo "Device: $ANDROID_SERIAL"
fi

# Send ADB broadcast
$ADB_CMD shell am broadcast \
    -a com.mentra.TEST_INJECT_AUDIO \
    --es filePath "$FILE_PATH" \
    -n com.mentra.mentra/com.mentra.core.testing.TestAudioReceiver

echo "Audio injection triggered (check logcat for TestAudioReceiver logs)"
