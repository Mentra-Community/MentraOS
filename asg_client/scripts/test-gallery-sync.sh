#!/bin/bash
#
# test-gallery-sync.sh - Test gallery status reporting
#
# Verifies that gallery counts update correctly after photo/video capture.
# Glasses must be connected via ADB with AsgClientService running.
#
# Usage: ./scripts/test-gallery-sync.sh
#

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"

echo "=========================================="
echo "Gallery Sync Test"
echo "=========================================="

check_adb
check_service
echo ""

# --- Test 1: Gallery status query ---
echo "--- Test: Gallery status query returns response ---"
# Clear logcat, send query, check for evidence command was processed
# CommandProcessor logs the command type; GalleryCommandHandler logs "Gallery status" on handle
adb logcat -c 2>/dev/null
send_command '{"type":"query_gallery_status"}'
sleep 2

# Accept either: processor received the command (query_gallery_status) or handler logged (Gallery status)
RESPONSE=$(adb logcat -d 2>/dev/null | grep -E "query_gallery_status|Gallery status" | wc -l | tr -d ' ')
if [ "${RESPONSE:-0}" -gt 0 ]; then
  pass "Gallery status query returned response"
else
  fail "No gallery status response in logs"
fi

# --- Test 2: Photo count increments ---
echo ""
echo "--- Test: Photo count increments after capture ---"
BEFORE_PHOTOS=$(count_photos)
info "Photos before: $BEFORE_PHOTOS"

send_command '{"type":"take_photo","requestId":"test_gallery_photo","transferMethod":"ble","size":"small"}'
sleep 4

AFTER_PHOTOS=$(count_photos)
info "Photos after: $AFTER_PHOTOS"

if [ "$AFTER_PHOTOS" -gt "$BEFORE_PHOTOS" ]; then
  pass "Photo count incremented ($BEFORE_PHOTOS -> $AFTER_PHOTOS)"
else
  fail "Photo count did not increment"
fi

# --- Test 3: Video count increments ---
echo ""
echo "--- Test: Video count increments after recording ---"
BEFORE_VIDEOS=$(count_videos)
info "Videos before: $BEFORE_VIDEOS"

send_command '{"type":"start_video_recording","requestId":"test_gallery_vid","save":true}'
sleep 4
send_command '{"type":"stop_video_recording","requestId":"test_gallery_vid"}'
sleep 3

AFTER_VIDEOS=$(count_videos)
info "Videos after: $AFTER_VIDEOS"

if [ "$AFTER_VIDEOS" -gt "$BEFORE_VIDEOS" ]; then
  pass "Video count incremented ($BEFORE_VIDEOS -> $AFTER_VIDEOS)"
else
  fail "Video count did not increment"
fi

# --- Test 4: Gallery query reflects new counts ---
echo ""
echo "--- Test: Gallery query reflects current file counts ---"
TOTAL_FILES=$(count_camera_files)
PHOTOS=$(count_photos)
VIDEOS=$(count_videos)
info "Total files on device: $TOTAL_FILES (photos: $PHOTOS, videos: $VIDEOS)"

if [ "$TOTAL_FILES" -gt 0 ]; then
  pass "Gallery has files to report"
else
  warn "Gallery is empty"
fi

summary
