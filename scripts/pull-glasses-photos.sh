#!/bin/bash
# scripts/pull-glasses-photos.sh
# Pull photos from connected Mentra glasses via ADB and extract flat JPEGs to glasses_photos/
# Usage: ./scripts/pull-glasses-photos.sh

set -e

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$REPO_ROOT/glasses_photos"
DEVICE_PATH="/sdcard/Android/data/com.mentra.asg_client/files/com.mentra.asg_client.camera"

if ! command -v adb &>/dev/null; then
  echo "Error: adb not found. Install Android SDK platform-tools."
  exit 1
fi

if ! adb devices | grep -qE '\tdevice$'; then
  echo "Error: No device connected. Connect glasses via USB and enable USB debugging."
  exit 1
fi

mkdir -p "$OUT_DIR"

echo "Pulling camera photos from device..."
adb pull "$DEVICE_PATH" "$OUT_DIR/" >/dev/null 2>&1

CAMERA_DIR="$OUT_DIR/com.mentra.asg_client.camera"
if [ ! -d "$CAMERA_DIR" ]; then
  echo "Error: Pull failed or no camera data on device."
  exit 1
fi

echo "Extracting JPEGs..."
count=0
for dir in "$CAMERA_DIR"/IMG_*; do
  [ -d "$dir" ] || continue
  [ -f "$dir/base.jpg" ] || continue
  name=$(basename "$dir")
  cp -f "$dir/base.jpg" "$OUT_DIR/$name.jpg"
  ((count++)) || true
done

rm -rf "$CAMERA_DIR"

echo "Done. Extracted $count photos to $OUT_DIR/"
