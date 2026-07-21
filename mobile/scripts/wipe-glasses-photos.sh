#!/usr/bin/env bash
# Wipe Mentra Live gallery captures (photos/videos) via adb.
#
# Usage:
#   ./scripts/wipe-glasses-photos.sh
#   ./scripts/wipe-glasses-photos.sh --dry-run
#   ADB_SERIAL=<serial> ./scripts/wipe-glasses-photos.sh
#
# Compatible with macOS /bin/bash 3.2 (no mapfile/readarray).
#
set -euo pipefail

DEFAULT_SERIAL="0123456789ABCDEF"
ADB_SERIAL="${ADB_SERIAL:-$DEFAULT_SERIAL}"
REMOTE_ROOT="/sdcard/Android/data/com.mentra.asg_client/files"
CAMERA_DIR="$REMOTE_ROOT/com.mentra.asg_client.camera"
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
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

adb_sh() {
  adb -s "$ADB_SERIAL" shell "$@"
}

echo "Target: $ADB_SERIAL"
echo "Camera dir: $CAMERA_DIR"

# Build newline-separated lists without bash-4 mapfile (macOS /bin/bash is 3.2).
CAPTURES="$(
  adb_sh "ls -1 '$CAMERA_DIR' 2>/dev/null" | grep -E '^(IMG_|VID_|BUFFER_)' || true
)"
LOOSE="$(
  adb_sh "ls -1 '$CAMERA_DIR' 2>/dev/null" | grep -Ei '\.(jpg|jpeg|png|mp4|avif)$' || true
)"
sdk_pending="$(adb_sh "ls -1d '$CAMERA_DIR/_sdk_pending' 2>/dev/null" || true)"
photos_dir="$(adb_sh "ls -1d '$REMOTE_ROOT/photos' 2>/dev/null" || true)"
queue_dir="$(adb_sh "ls -1d '$REMOTE_ROOT/photo_queue' 2>/dev/null" || true)"
thumbs_dir="$(adb_sh "ls -1d '$REMOTE_ROOT/thumbnails' 2>/dev/null" || true)"
manifest="$(adb_sh "ls -1 '$REMOTE_ROOT/media_queue/queue_manifest.json' 2>/dev/null" || true)"

capture_count=0
loose_count=0
if [[ -n "$CAPTURES" ]]; then
  capture_count="$(printf '%s\n' "$CAPTURES" | grep -c . || true)"
fi
if [[ -n "$LOOSE" ]]; then
  loose_count="$(printf '%s\n' "$LOOSE" | grep -c . || true)"
fi

total=$((capture_count + loose_count))
[[ -n "$sdk_pending" ]] && total=$((total + 1))
[[ -n "$photos_dir" ]] && total=$((total + 1))
[[ -n "$queue_dir" ]] && total=$((total + 1))
[[ -n "$thumbs_dir" ]] && total=$((total + 1))
[[ -n "$manifest" ]] && total=$((total + 1))

echo "Found ${capture_count} capture folder(s), ${loose_count} loose media file(s)"
if [[ "$DRY_RUN" -eq 1 ]]; then
  [[ -n "$CAPTURES" ]] && printf '  %s\n' $CAPTURES
  [[ -n "$LOOSE" ]] && printf '  %s\n' $LOOSE
  [[ -n "$sdk_pending" ]] && echo "  _sdk_pending/"
  [[ -n "$photos_dir" ]] && echo "  photos/"
  [[ -n "$queue_dir" ]] && echo "  photo_queue/"
  [[ -n "$thumbs_dir" ]] && echo "  thumbnails/"
  [[ -n "$manifest" ]] && echo "  media_queue/queue_manifest.json"
  echo "Dry run — nothing deleted ($total item(s) would be removed)."
  exit 0
fi

if [[ "$total" -eq 0 ]]; then
  echo "Storage already empty — nothing to delete."
  exit 0
fi

# Prefer one remote shell wipe for speed/reliability on busy galleries.
# shellcheck disable=SC2016
adb_sh "CAMERA_DIR='$CAMERA_DIR'; REMOTE_ROOT='$REMOTE_ROOT'; \
  cd \"\$CAMERA_DIR\" 2>/dev/null || exit 0; \
  for name in IMG_* VID_* BUFFER_*; do \
    [ -e \"\$name\" ] || continue; \
    rm -rf \"\$name\"; \
  done; \
  rm -f *.jpg *.jpeg *.png *.mp4 *.avif *.JPG *.JPEG *.PNG *.MP4 *.AVIF 2>/dev/null || true; \
  rm -rf _sdk_pending; \
  rm -rf \"\$REMOTE_ROOT/photos\" \"\$REMOTE_ROOT/photo_queue\" \"\$REMOTE_ROOT/thumbnails\"; \
  if [ -f \"\$REMOTE_ROOT/media_queue/queue_manifest.json\" ]; then \
    printf '%s\n' '{\"items\":[]}' > \"\$REMOTE_ROOT/media_queue/queue_manifest.json\"; \
  fi"

echo "Deleted $total item(s) from Mentra Live gallery storage."
