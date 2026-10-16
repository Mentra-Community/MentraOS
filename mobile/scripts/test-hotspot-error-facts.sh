#!/usr/bin/env bash
set -euo pipefail
mobile_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
wifi_ios="${WIFI_IOS_SOURCE_DIR:-$mobile_dir/node_modules/react-native-wifi-reborn/ios}"
build_dir="$(mktemp -d)"
trap 'rm -rf "$build_dir"' EXIT
xcrun clang -fobjc-arc -framework Foundation -I "$wifi_ios" \
  "$mobile_dir/test/native/RNWifiErrorFactsTests.m" -o "$build_dir/error-facts-test"
"$build_dir/error-facts-test"
