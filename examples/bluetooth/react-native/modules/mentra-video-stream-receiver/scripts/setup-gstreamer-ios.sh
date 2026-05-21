#!/usr/bin/env bash
set -euo pipefail

VERSION="${GSTREAMER_VERSION:-1.28.2}"
PKG_NAME="gstreamer-1.0-devel-${VERSION}-ios-universal.pkg"
BASE_URL="https://gstreamer.freedesktop.org/data/pkg/ios/${VERSION}"
DEST="$HOME/Library/Developer/GStreamer/iPhone.sdk"

if [[ -d "$DEST/GStreamer.framework" ]]; then
  echo "GStreamer iOS SDK already exists at $DEST"
  exit 0
fi

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

echo "Downloading GStreamer iOS SDK ${VERSION}..."
curl -fL "$BASE_URL/$PKG_NAME" -o "$TMP_DIR/$PKG_NAME"
curl -fL "$BASE_URL/$PKG_NAME.sha256sum" -o "$TMP_DIR/$PKG_NAME.sha256sum"

echo "Verifying checksum..."
(cd "$TMP_DIR" && shasum -a 256 -c "$PKG_NAME.sha256sum")

echo "Installing GStreamer iOS SDK..."
installer -pkg "$TMP_DIR/$PKG_NAME" -target CurrentUserHomeDirectory

if [[ ! -d "$DEST/GStreamer.framework" ]]; then
  echo "Installed package, but did not find GStreamer.framework at $DEST." >&2
  echo "Set GSTREAMER_ROOT_IOS to the installed iPhone.sdk path when building." >&2
  exit 1
fi

echo "GStreamer iOS SDK installed at $DEST"
