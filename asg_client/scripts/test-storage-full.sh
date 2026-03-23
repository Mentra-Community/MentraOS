#!/bin/bash
#
# test-storage-full.sh - Test behavior when storage is nearly full
#
# Fills storage with temp files, tests that photo/video fail gracefully,
# then cleans up and verifies recovery.
#
# WARNING: This creates large temp files on the glasses. Cleanup runs
# automatically, but if interrupted, run:
#   adb shell "rm /sdcard/test_fill_*"
#
# Usage: ./scripts/test-storage-full.sh
#

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"

echo "=========================================="
echo "Storage Full Test"
echo "=========================================="

check_adb
check_service

cleanup() {
  echo ""
  info "Cleaning up temp files..."
  adb shell "rm -f /sdcard/test_fill_*" 2>/dev/null
  AFTER_FREE=$(free_storage_mb)
  info "Free storage after cleanup: ${AFTER_FREE} MB"
}

# Always clean up, even on error
trap cleanup EXIT

FREE_MB=$(free_storage_mb)
info "Free storage: ${FREE_MB} MB"
echo ""

if [ "$FREE_MB" -lt 100 ]; then
  warn "Storage already low (${FREE_MB} MB). Skipping fill test."
  echo "Clean up files on the device first."
  exit 0
fi

# --- Phase 1: Fill storage ---
echo "--- Phase 1: Filling storage (leaving ~30MB free) ---"
FILL_MB=$((FREE_MB - 30))
info "Creating ${FILL_MB} MB of temp files..."

# Create in 50MB chunks to avoid timeout
REMAINING=$FILL_MB
CHUNK_NUM=0
while [ "$REMAINING" -gt 0 ]; do
  CHUNK_SIZE=$((REMAINING > 50 ? 50 : REMAINING))
  adb shell "dd if=/dev/zero of=/sdcard/test_fill_${CHUNK_NUM} bs=1M count=${CHUNK_SIZE}" 2>/dev/null
  REMAINING=$((REMAINING - CHUNK_SIZE))
  CHUNK_NUM=$((CHUNK_NUM + 1))
  info "  Filled: $((FILL_MB - REMAINING))/${FILL_MB} MB"
done

FREE_AFTER_FILL=$(free_storage_mb)
info "Free storage after fill: ${FREE_AFTER_FILL} MB"

# --- Phase 2: Test photo with low storage ---
echo ""
echo "--- Test: Photo capture with low storage ---"
BEFORE=$(count_photos)
send_command '{"type":"take_photo","requestId":"test_storage_photo","transferMethod":"ble","size":"small"}'
sleep 4
AFTER=$(count_photos)

if [ "$AFTER" -eq "$BEFORE" ]; then
  pass "Photo correctly rejected/failed with low storage"
else
  # Photo might still succeed with ~30MB free (a photo is small)
  warn "Photo captured with ${FREE_AFTER_FILL} MB free (may be expected for small photos)"
fi

# --- Phase 3: Test video with low storage ---
echo ""
echo "--- Test: Video recording with low storage ---"
BEFORE=$(count_videos)
send_command '{"type":"start_video_recording","requestId":"test_storage_vid","save":true}'
sleep 4
send_command '{"type":"stop_video_recording","requestId":"test_storage_vid"}'
sleep 3
AFTER=$(count_videos)

# Video needs more space, more likely to fail
if [ "$AFTER" -eq "$BEFORE" ]; then
  pass "Video correctly rejected/failed with low storage"
else
  warn "Video recorded with ${FREE_AFTER_FILL} MB free"
fi

# --- Phase 4: Cleanup and verify recovery ---
# cleanup runs via trap, but let's test recovery explicitly
echo ""
echo "--- Test: Recovery after storage freed ---"
cleanup
trap - EXIT  # remove trap since we already cleaned up
sleep 2

BEFORE=$(count_photos)
send_command '{"type":"take_photo","requestId":"test_recovery_photo","transferMethod":"ble","size":"small"}'
sleep 4
AFTER=$(count_photos)

if [ "$AFTER" -gt "$BEFORE" ]; then
  pass "Photo capture recovered after storage freed"
else
  fail "Photo capture did not recover after storage freed"
fi

summary
