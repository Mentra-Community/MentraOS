#!/bin/bash
#
# test-video.sh - Test video recording on Mentra Live glasses
#
# Tests normal video recording and video integrity.
# Glasses must be connected via ADB with AsgClientService running.
#
# Usage: ./scripts/test-video.sh [count] [--no-wipe] [--no-pull] [--no-prompt]
#   count:      number of videos in multi-record test (default: 5)
#   --no-wipe:  skip wiping camera directory before tests
#   --no-pull:  skip pulling videos to local machine for viewing
#   --no-prompt: skip interactive cleanup prompts (for CI/automation)
#

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"

COUNT=5
WIPE=true
PULL=true
LOCAL_DIR="$SCRIPT_DIR/../test-output/videos"

for arg in "$@"; do
  case $arg in
    --no-wipe) WIPE=false ;;
    --no-pull) PULL=false ;;
    --no-prompt) SKIP_CLEANUP_PROMPTS=1 ;;
    [0-9]*) COUNT=$arg ;;
  esac
done

echo "=========================================="
echo "Video Recording Test"
echo "=========================================="

check_adb
check_service

BATTERY=$(get_battery)
info "Battery: ${BATTERY}%"
info "Multi-record count: $COUNT"
info "Camera dir: $CAMERA_DIR"
info "Wipe before test: $WIPE"
info "Pull videos after: $PULL"
echo ""

# --- Wipe camera directory (videos only: VID_* dirs) ---
if [ "$WIPE" = true ]; then
  echo "--- Wiping camera directory (videos) ---"
  EXISTING=$(count_videos)
  adb shell "rm -rf '$CAMERA_DIR'/VID_*" 2>/dev/null || true
  AFTER_WIPE=$(count_videos)
  info "Wiped $EXISTING videos (now: $AFTER_WIPE)"
  echo ""
fi

# Prepare local output directory
if [ "$PULL" = true ]; then
  mkdir -p "$LOCAL_DIR"
fi

# --- Test 1: Normal video recording (5 seconds) ---
echo "--- Test: Normal video recording (5s) ---"
BEFORE=$(count_videos)
info "Videos before: $BEFORE"

send_command '{"type":"start_video_recording","requestId":"test_vid_001","save":true}'
info "Recording started..."
sleep 6

send_command '{"type":"stop_video_recording","requestId":"test_vid_001"}'
info "Recording stopped, waiting for finalization..."
sleep 3

AFTER=$(count_videos)
info "Videos after: $AFTER"

if [ "$AFTER" -gt "$BEFORE" ]; then
  pass "Video file created"

  LATEST=$(latest_video_file)
  if [ -n "$LATEST" ]; then
    SIZE=$(file_size "$LATEST")
    info "Video file: $(basename "$(dirname "$LATEST")") (${SIZE} bytes)"

    if [ "${SIZE:-0}" -gt 10000 ]; then
      pass "Video has reasonable size (${SIZE} bytes)"
    else
      fail "Video file suspiciously small (${SIZE} bytes)"
    fi

    if is_valid_mp4 "$LATEST"; then
      pass "Video has valid MP4 header (ftyp box)"
    else
      fail "Video missing MP4 header"
    fi

    if has_moov_atom "$LATEST"; then
      pass "Video has moov atom (properly finalized)"
    else
      fail "Video missing moov atom (CORRUPTED - not properly finalized)"
    fi

    if [ "$PULL" = true ]; then
      LOCAL_NAME=$(basename "$(dirname "$LATEST")")_base.mp4
      adb pull "$LATEST" "$LOCAL_DIR/$LOCAL_NAME" 2>/dev/null && \
        info "Pulled to: $LOCAL_DIR/$LOCAL_NAME" && \
        open "$LOCAL_DIR/$LOCAL_NAME" 2>/dev/null || true
    fi
  fi
else
  fail "No video file created"
fi

# --- Test 2: Multiple recordings (corruption check) ---
echo ""
echo "--- Test: Multiple recordings (${COUNT}x, corruption check) ---"
CORRUPT_COUNT=0

for i in $(seq 1 $COUNT); do
  send_command "{\"type\":\"start_video_recording\",\"requestId\":\"test_multi_$i\",\"save\":true}"
  sleep 4
  send_command "{\"type\":\"stop_video_recording\",\"requestId\":\"test_multi_$i\"}"
  sleep 3

  LATEST=$(latest_video_file)
  if [ -n "$LATEST" ]; then
    if has_moov_atom "$LATEST"; then
      info "Video $i: OK (has moov atom)"
    else
      CORRUPT_COUNT=$((CORRUPT_COUNT + 1))
      info "Video $i: CORRUPTED (missing moov atom)"
    fi
  else
    CORRUPT_COUNT=$((CORRUPT_COUNT + 1))
    info "Video $i: MISSING"
  fi
done

if [ "$CORRUPT_COUNT" -eq 0 ]; then
  pass "All $COUNT videos have valid moov atoms"
else
  fail "$CORRUPT_COUNT/$COUNT videos corrupted or missing"
fi

# Pull and show multi-record videos
if [ "$PULL" = true ]; then
  echo ""
  info "Pulling $COUNT multi-record videos..."
  adb shell "ls -td '$CAMERA_DIR'/VID_* 2>/dev/null" | head -$COUNT | while read -r VD; do
    [ -n "$VD" ] && adb pull "${VD}/base.mp4" "$LOCAL_DIR/$(basename "$VD").mp4" 2>/dev/null || true
  done
  info "Videos saved to: $LOCAL_DIR/"
  open "$LOCAL_DIR" 2>/dev/null || true
fi

# --- Test 3: Photo during video (should be rejected) ---
echo ""
echo "--- Test: Photo during video recording (should be rejected) ---"
send_command '{"type":"start_video_recording","requestId":"test_reject_vid","save":true}'
sleep 2

BEFORE_PHOTOS=$(count_photos)
send_command '{"type":"take_photo","requestId":"test_reject_photo","transferMethod":"ble"}'
sleep 3
AFTER_PHOTOS=$(count_photos)

send_command '{"type":"stop_video_recording","requestId":"test_reject_vid"}'
sleep 2

if [ "$AFTER_PHOTOS" -eq "$BEFORE_PHOTOS" ]; then
  pass "Photo correctly rejected during video recording"
else
  fail "Photo was NOT rejected during video recording"
fi

summary

# --- Cleanup prompt (device) ---
echo ""
TOTAL_VIDEOS=$(count_videos)
if [ "$TOTAL_VIDEOS" -gt 0 ]; then
  if [ "${SKIP_CLEANUP_PROMPTS:-0}" = "1" ]; then
    adb shell "rm -rf '$CAMERA_DIR'/VID_*" 2>/dev/null || true
    info "Wiped $TOTAL_VIDEOS videos from glasses"
  else
    echo -n "Delete $TOTAL_VIDEOS test videos from glasses? [y/N] "
    read -r REPLY
    if [[ "$REPLY" =~ ^[Yy]$ ]]; then
      adb shell "rm -rf '$CAMERA_DIR'/VID_*" 2>/dev/null || true
      info "Deleted videos from glasses"
    else
      info "Videos kept on glasses"
    fi
  fi
fi

# --- Cleanup prompt (local) ---
if [ "$PULL" = true ] && [ -d "$LOCAL_DIR" ]; then
  LOCAL_COUNT=$(ls "$LOCAL_DIR"/*.mp4 2>/dev/null | wc -l | tr -d ' ')
  if [ "${LOCAL_COUNT:-0}" -gt 0 ]; then
    if [ "${SKIP_CLEANUP_PROMPTS:-0}" = "1" ]; then
      rm -f "$LOCAL_DIR"/*.mp4 2>/dev/null || true
      info "Wiped $LOCAL_COUNT local videos from $LOCAL_DIR"
    else
      echo -n "Delete $LOCAL_COUNT pulled videos from $LOCAL_DIR? [y/N] "
      read -r REPLY
      if [[ "$REPLY" =~ ^[Yy]$ ]]; then
        rm -f "$LOCAL_DIR"/*.mp4 2>/dev/null || true
        info "Deleted local videos"
      else
        info "Local videos kept at: $LOCAL_DIR/"
      fi
    fi
  fi
fi
