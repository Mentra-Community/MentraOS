#!/usr/bin/env bash
set -euo pipefail
mobile_dir="$(cd "$(dirname "$0")/.." && pwd)"
build_dir="$(mktemp -d "${TMPDIR:-/tmp}/mentra-permission-status.XXXXXX")"
trap 'rm -rf "$build_dir"' EXIT
xcrun swiftc "$mobile_dir/modules/crust/ios/PermissionStatusReceipt.swift" \
  "$mobile_dir/test/native/PermissionStatusReceiptTests.swift" -o "$build_dir/permission-status-tests"
"$build_dir/permission-status-tests"
xcrun --sdk iphoneos swiftc -typecheck -target arm64-apple-ios15.1 \
  -sdk "$(xcrun --sdk iphoneos --show-sdk-path)" \
  "$mobile_dir/modules/crust/ios/PermissionStatusReceipt.swift"
