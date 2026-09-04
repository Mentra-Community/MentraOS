#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
swift build
bin_dir="$(swift build --show-bin-path)"
app="$PWD/build/Mentra SDK Mac.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin_dir/MentraMacExample" "$app/Contents/MacOS/"
cp Info.plist "$app/Contents/Info.plist"
for bundle in "$bin_dir"/*.bundle; do
  if [[ -d "$bundle" ]]; then cp -R "$bundle" "$app/Contents/Resources/"; fi
done
codesign --force --sign - --entitlements MentraMacExample.entitlements "$app"
if [[ "${1:-}" != "--build-only" ]]; then open "$app"; fi
