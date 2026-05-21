#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXAMPLE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

VERSION="${GSTREAMER_VERSION:-1.28.2}"
ARCHIVE_NAME="gstreamer-1.0-android-universal-${VERSION}.tar.xz"
BASE_URL="https://gstreamer.freedesktop.org/data/pkg/android/${VERSION}"
DEST="${GSTREAMER_ROOT_ANDROID:-$EXAMPLE_DIR/.gstreamer/Android.sdk}"

if [[ -f "$DEST/arm64/share/gst-android/ndk-build/gstreamer-1.0.mk" || -f "$DEST/share/gst-android/ndk-build/gstreamer-1.0.mk" ]]; then
  echo "GStreamer Android SDK already exists at $DEST"
  exit 0
fi

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

echo "Downloading GStreamer Android SDK ${VERSION}..."
curl -fL "$BASE_URL/$ARCHIVE_NAME" -o "$TMP_DIR/$ARCHIVE_NAME"
curl -fL "$BASE_URL/$ARCHIVE_NAME.sha256sum" -o "$TMP_DIR/$ARCHIVE_NAME.sha256sum"

echo "Verifying checksum..."
(cd "$TMP_DIR" && shasum -a 256 -c "$ARCHIVE_NAME.sha256sum")

PAYLOAD_DIR="$TMP_DIR/payload"
mkdir -p "$PAYLOAD_DIR"
echo "Extracting SDK..."
tar -xf "$TMP_DIR/$ARCHIVE_NAME" -C "$PAYLOAD_DIR"

SDK_ROOT="$PAYLOAD_DIR"
if [[ ! -f "$SDK_ROOT/arm64/share/gst-android/ndk-build/gstreamer-1.0.mk" ]]; then
  MATCH="$(find "$PAYLOAD_DIR" -path '*/arm64/share/gst-android/ndk-build/gstreamer-1.0.mk' -print -quit)"
  if [[ -z "$MATCH" ]]; then
    echo "Could not find the extracted GStreamer Android SDK root." >&2
    exit 1
  fi
  SDK_ROOT="${MATCH%/arm64/share/gst-android/ndk-build/gstreamer-1.0.mk}"
fi

mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
mkdir -p "$DEST"
cp -R "$SDK_ROOT"/. "$DEST"/

echo "GStreamer Android SDK installed at $DEST"
