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
  # Match the same extensions/case variants the pull search can write.
  find "$OUTPUT_DIR" -maxdepth 1 -type f \( -iname '*.jpg' -o -iname '*.jpeg' \) -delete 2>/dev/null || true
  echo "Cleaned existing JPG/JPEG files in $OUTPUT_DIR"
fi

# Prefer earlier roots (asg_media) over later legacy roots on name collision.
# Also avoids clobbering when two trees share the same parent basename.
copy_photo() {
  local src="$1"
  local dest="$2"
  if [[ -e "$dest" ]]; then
    echo "Skip (already present): $(basename "$dest")"
    return 1
  fi
  # Propagate cp status — callers use `if copy_photo`, so set -e won't abort here.
  cp "$src" "$dest"
}

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
    capture_id="$(basename "$(dirname "$base")")"
    dest="${OUTPUT_DIR}/${capture_id}.jpg"
    if copy_photo "$base" "$dest"; then
      ROOT_COUNT=$((ROOT_COUNT + 1))
      TOTAL=$((TOTAL + 1))
    fi
  done < <(find "$TMP/root" -type f -name 'base.jpg' -print0 2>/dev/null || true)

  # Loose flat captures (IMG_*.jpg) that are not package base.jpg files.
  while IFS= read -r -d '' jpg; do
    dest="${OUTPUT_DIR}/$(basename "$jpg")"
    if copy_photo "$jpg" "$dest"; then
      ROOT_COUNT=$((ROOT_COUNT + 1))
      TOTAL=$((TOTAL + 1))
    fi
  done < <(
    find "$TMP/root" -type f \( -iname 'IMG_*.jpg' -o -iname 'IMG_*.jpeg' \) -print0 2>/dev/null || true
  )

  rm -rf "$TMP"
  echo "Pulled $ROOT_COUNT photo(s) from $ROOT"
done

echo "Total: $TOTAL photo(s) → $OUTPUT_DIR"
