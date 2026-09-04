#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
app="$PWD/build/Mentra SDK Mac.app"
if ps -axww -o command= | awk -v executable="$app/Contents/MacOS/MentraMacExample" '$0 == executable || index($0, executable " ") == 1 { found = 1 } END { exit !found }'; then
  printf 'Quit the running example at %s before rebuilding.\n' "$app" >&2
  exit 1
fi
swift build
bin_dir="$(swift build --show-bin-path)"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$bin_dir/MentraMacExample" "$app/Contents/MacOS/"
cp Info.plist "$app/Contents/Info.plist"
cp AppIcon.icns "$app/Contents/Resources/"
for bundle in "$bin_dir"/*.bundle; do
  if [[ -d "$bundle" ]]; then cp -R "$bundle" "$app/Contents/Resources/"; fi
done
codesign --force --sign - --entitlements MentraMacExample.entitlements "$app"
if [[ "${1:-}" != "--build-only" ]]; then open "$app"; fi
