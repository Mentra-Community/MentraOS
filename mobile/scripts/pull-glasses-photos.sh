#!/usr/bin/env bash
# Pull Mentra Live gallery captures via adb and flatten each IMG_*/base.jpg
# into OUTPUT_DIR/{capture_id}.jpg.
#
# Usage:
#   ./scripts/pull-glasses-photos.sh
#   ./scripts/pull-glasses-photos.sh --clean
#   ADB_SERIAL=<serial> OUTPUT_DIR=./Camera_comparison/old_focus ./scripts/pull-glasses-photos.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MOBILE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

DEFAULT_SERIAL="0123456789ABCDEF"
ADB_SERIAL="${ADB_SERIAL:-$DEFAULT_SERIAL}"
OUTPUT_DIR="${OUTPUT_DIR:-$MOBILE_DIR/Camera_comparison/new_focus}"
REMOTE_DIR="/sdcard/Android/data/com.mentra.asg_client/files/com.mentra.asg_client.camera"
CLEAN=0

for arg in "$@"; do
  case "$arg" in
    --clean) CLEAN=1 ;;
    --help|-h)
      sed -n '2,12p' "$0"
      exit 0
      ;;
  esac
done

if ! command -v adb >/dev/null 2>&1; then
  echo "adb not found on PATH" >&2
  exit 1
fi

if ! adb -s "$ADB_SERIAL" get-state >/dev/null 2>&1; then
  echo "Device $ADB_SERIAL not connected. Connected devices:" >&2
  adb devices -l >&2
  exit 2
fi

if [[ "$CLEAN" -eq 1 ]]; then
  mkdir -p "$OUTPUT_DIR"
  find "$OUTPUT_DIR" -maxdepth 1 -type f \( -name '*.jpg' -o -name '*.jpeg' -o -name '*.JPG' \) -delete
  echo "Cleaned existing JPGs in $OUTPUT_DIR"
fi

mkdir -p "$OUTPUT_DIR"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mentra-glasses-photos.XXXXXX")"
cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

echo "Pulling captures from $ADB_SERIAL:$REMOTE_DIR ..."
if ! adb -s "$ADB_SERIAL" pull "$REMOTE_DIR" "$TMP_DIR/camera" >/tmp/pull-glasses-photos.log 2>&1; then
  echo "adb pull failed:" >&2
  cat /tmp/pull-glasses-photos.log >&2
  exit 3
fi

copied=0
shopt -s nullglob
for dir in "$TMP_DIR/camera"/IMG_*; do
  [[ -d "$dir" ]] || continue
  base="$dir/base.jpg"
  if [[ ! -f "$base" ]]; then
    # Some captures may use a different primary filename; take the first jpg.
    candidates=("$dir"/*.jpg "$dir"/*.jpeg)
    if [[ ${#candidates[@]} -eq 0 || ! -f "${candidates[0]}" ]]; then
      echo "Skipping $(basename "$dir") — no JPEG found"
      continue
    fi
    base="${candidates[0]}"
  fi
  capture_id="$(basename "$dir")"
  dest="$OUTPUT_DIR/${capture_id}.jpg"
  cp "$base" "$dest"
  copied=$((copied + 1))
done
shopt -u nullglob

echo "Saved $copied photo(s) to $OUTPUT_DIR"
if [[ "$copied" -eq 0 ]]; then
  echo "No IMG_*/base.jpg captures found under $REMOTE_DIR" >&2
  exit 4
fi
