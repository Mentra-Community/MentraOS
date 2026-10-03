#!/usr/bin/env bash
set -euo pipefail
mobile_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Override permits proving the regression against a pristine package in a temp directory.
rnfs_ios="${RNFS_IOS_SOURCE_DIR:-$mobile_dir/node_modules/@dr.pogodin/react-native-fs/ios}"
build_dir="$(mktemp -d)"
trap 'rm -rf "$build_dir"' EXIT
xcrun clang++ -fobjc-arc -framework Foundation -Wno-incompatible-pointer-types \
  -I "$rnfs_ios" "$rnfs_ios/Downloader.mm" \
  "$mobile_dir/test/native/RNFSDownloadProgressTests.mm" -o "$build_dir/progress-test"
"$build_dir/progress-test"
