#!/usr/bin/env bash
# Pull photos from Mentra Live glasses (current asg_media + legacy app-files paths).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../../scripts/lib/glasses-device.sh
source "${SCRIPT_DIR}/../../scripts/lib/glasses-device.sh"

CLEAN=0
for arg in "$@"; do
  case "$arg" in
    --clean) CLEAN=1 ;;
    -h|--help)
      echo "Usage: $0 [--clean]"
      echo "  ADB_SERIAL=…  optional; if unset, requires exactly one connected device"
      echo "  OUTPUT_DIR=… host folder (default mobile/Camera_comparison/new_focus)"
      exit 0
      ;;
  esac
done

MOBILE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUTPUT_DIR="${OUTPUT_DIR:-${MOBILE_ROOT}/Camera_comparison/new_focus}"

resolve_serial
resolve_package
resolve_media_roots

mkdir -p "$OUTPUT_DIR"
if [[ "$CLEAN" -eq 1 ]]; then
  find "$OUTPUT_DIR" -maxdepth 1 -type f -name '*.jpg' -delete 2>/dev/null || true
  echo "Cleaned existing JPGs in $OUTPUT_DIR"
fi

TOTAL=0
for ROOT in "${MEDIA_ROOTS[@]}"; do
  ROOT_COUNT=0
  if ! adb -s "$SERIAL" shell "test -d '$ROOT'"; then
    echo "Skip (missing on device): $ROOT"
    continue
  fi

  TMP="$(mktemp -d)"
  # Fail on transport errors; empty directories still pull successfully.
  if ! adb -s "$SERIAL" pull "$ROOT" "$TMP/root"; then
    rm -rf "$TMP"
    echo "Error: adb pull failed for $ROOT" >&2
    exit 1
  fi

  # Flatten capture packages: **/IMG_*/base.jpg → {capture_id}.jpg
  # Also pick up any other base.jpg (legacy layouts).
  while IFS= read -r -d '' base; do
    parent="$(basename "$(dirname "$base")")"
    capture_id="$parent"
    dest="${OUTPUT_DIR}/${capture_id}.jpg"
    cp "$base" "$dest"
    ROOT_COUNT=$((ROOT_COUNT + 1))
    TOTAL=$((TOTAL + 1))
  done < <(find "$TMP/root" -type f -name 'base.jpg' -print0 2>/dev/null || true)

  rm -rf "$TMP"
  echo "Pulled $ROOT_COUNT photo(s) from $ROOT"
done

echo "Total: $TOTAL photo(s) → $OUTPUT_DIR"
