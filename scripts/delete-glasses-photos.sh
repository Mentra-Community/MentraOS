#!/bin/bash
# scripts/delete-glasses-photos.sh
# Delete photos from connected Mentra glasses via ADB
# Usage: ./scripts/delete-glasses-photos.sh

set -e

DEVICE_CAMERA="/sdcard/Android/data/com.mentra.asg_client/files/com.mentra.asg_client.camera"
DEVICE_THUMBNAILS="/sdcard/Android/data/com.mentra.asg_client/files/thumbnails"

if ! command -v adb &>/dev/null; then
  echo "Error: adb not found. Install Android SDK platform-tools."
  exit 1
fi

if ! adb devices | grep -qE '\tdevice$'; then
  echo "Error: No device connected. Connect glasses via USB and enable USB debugging."
  exit 1
fi

echo "Deleting photos from device..."
adb shell "rm -rf $DEVICE_CAMERA"
adb shell "rm -rf $DEVICE_THUMBNAILS"

echo "Done. Camera photos and thumbnails removed from glasses."
