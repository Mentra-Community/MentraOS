#!/usr/bin/env bash
set -euo pipefail
mobile_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Override permits proving the checks against a pristine package in a temp directory.
webview_apple="${WEBVIEW_APPLE_SOURCE_DIR:-$mobile_dir/node_modules/react-native-webview/apple}"
build_dir="$(mktemp -d)"
trap 'rm -rf "$build_dir"' EXIT
xcrun clang -fobjc-arc -framework Foundation -framework WebKit -framework AppKit -I "$webview_apple" \
  "$webview_apple/RNCMiniappSchemeHandler.m" \
  "$mobile_dir/test/native/RNCWebViewMiniappOriginTests.m" -o "$build_dir/miniapp-origin-test"
"$build_dir/miniapp-origin-test"
