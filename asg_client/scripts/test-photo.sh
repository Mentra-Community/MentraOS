#!/bin/bash
#
# test-photo.sh - Test photo capture on Mentra Live glasses
#
# Triggers photo capture via ADB, verifies files are created and valid.
# Glasses must be connected via ADB with AsgClientService running.
#
# Usage: ./scripts/test-photo.sh [count] [--no-wipe] [--no-pull] [--no-prompt]
#   count:      number of photos to take in burst test (default: 5)
#   --no-wipe:  skip wiping camera directory before tests
#   --no-pull:  skip pulling photos to local machine for viewing
#   --no-prompt: skip interactive cleanup prompts (for CI/automation)
#

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/test-helpers.sh"

COUNT=5
WIPE=true
PULL=true
LOCAL_DIR="$SCRIPT_DIR/../test-output/photos"

for arg in "$@"; do
  case $arg in
    --no-wipe) WIPE=false ;;
    --no-pull) PULL=false ;;
    --no-prompt) SKIP_CLEANUP_PROMPTS=1 ;;
    [0-9]*) COUNT=$arg ;;
  esac
done

DELAY_BETWEEN=3  # seconds between photos

echo "=========================================="
echo "Photo Capture Test"
echo "=========================================="

check_adb
check_service

BATTERY=$(get_battery)
info "Battery: ${BATTERY}%"
info "Photos to take: $COUNT"
info "Camera dir: $CAMERA_DIR"
info "Wipe before test: $WIPE"
info "Pull photos after: $PULL"
echo ""

# --- Wipe camera directory (photos only: IMG_* dirs) ---
if [ "$WIPE" = true ]; then
  echo "--- Wiping camera directory ---"
  EXISTING=$(count_photos)
  adb shell "rm -rf '$CAMERA_DIR'/IMG_*" 2>/dev/null || true
  AFTER_WIPE=$(count_photos)
  info "Wiped $EXISTING photos (now: $AFTER_WIPE)"
  echo ""
fi

# Prepare local output directory
if [ "$PULL" = true ]; then
  mkdir -p "$LOCAL_DIR"
fi

# --- Test 1: Single photo capture ---
echo "--- Test: Single photo capture ---"
BEFORE=$(count_photos)
info "Photos before: $BEFORE"

send_command '{"type":"take_photo","requestId":"test_single_001","transferMethod":"ble","size":"medium"}'
sleep 3

AFTER=$(count_photos)
info "Photos after: $AFTER"

if [ "$AFTER" -gt "$BEFORE" ]; then
  pass "Photo file created"
else
  fail "No new photo file after capture command"
fi

# Check the file is valid
FPATH=$(latest_photo_file)
if [ -n "$FPATH" ] && [ "$FPATH" != "" ]; then
  SIZE=$(file_size "$FPATH")
  info "Latest photo: $(basename "$(dirname "$FPATH")") (${SIZE} bytes)"

  if [ "${SIZE:-0}" -gt 0 ]; then
    pass "Photo file has content (${SIZE} bytes)"
  else
    fail "Photo file is empty"
  fi

  if is_valid_jpeg "$FPATH"; then
    pass "Photo has valid JPEG header"
  else
    warn "Photo may not be JPEG (could be AVIF for BLE transfer)"
  fi

  # Pull and show
  if [ "$PULL" = true ]; then
    LOCAL_NAME=$(basename "$(dirname "$FPATH")")_$(basename "$FPATH")
    adb pull "$FPATH" "$LOCAL_DIR/$LOCAL_NAME" 2>/dev/null && \
      info "Pulled to: $LOCAL_DIR/$LOCAL_NAME" && \
      open "$LOCAL_DIR/$LOCAL_NAME" 2>/dev/null || true
  fi
else
  fail "Could not find latest photo"
fi

# --- Test 2: Sequential photo burst ---
echo ""
echo "--- Test: Sequential photo burst ($COUNT photos) ---"
BEFORE=$(count_photos)
SUCCESSES=0
BURST_FILES=()

for i in $(seq 1 $COUNT); do
  send_command "{\"type\":\"take_photo\",\"requestId\":\"test_burst_$(printf '%03d' $i)\",\"transferMethod\":\"ble\",\"size\":\"small\"}"
  sleep $DELAY_BETWEEN

  CURRENT=$(count_photos)
  if [ "$CURRENT" -gt "$BEFORE" ]; then
    SUCCESSES=$((SUCCESSES + 1))
    NEW_FILE=$(latest_photo_file)
    BURST_FILES+=("$NEW_FILE")
    BEFORE=$CURRENT
  fi
  info "Photo $i/$COUNT - total files: $CURRENT"
done

if [ "$SUCCESSES" -eq "$COUNT" ]; then
  pass "All $COUNT sequential photos captured"
elif [ "$SUCCESSES" -gt 0 ]; then
  warn "$SUCCESSES/$COUNT photos captured (some may have been rejected due to BLE cooldown)"
  pass "At least some photos captured during burst"
else
  fail "No photos captured during burst"
fi

# Pull and show burst photos
if [ "$PULL" = true ] && [ ${#BURST_FILES[@]} -gt 0 ]; then
  echo ""
  info "Pulling ${#BURST_FILES[@]} burst photos..."
  for f in "${BURST_FILES[@]}"; do
    [ -n "$f" ] && adb pull "$f" "$LOCAL_DIR/$(basename "$(dirname "$f")")_$(basename "$f")" 2>/dev/null || true
  done
  info "Photos saved to: $LOCAL_DIR/"
  open "$LOCAL_DIR" 2>/dev/null || true
fi

# --- Test 3: Battery level check ---
echo ""
echo "--- Test: Battery level validation ---"
BATTERY=$(get_battery)
if [ "$BATTERY" -lt 10 ]; then
  info "Battery is ${BATTERY}% (below threshold) - testing rejection"
  BEFORE=$(count_photos)
  send_command '{"type":"take_photo","requestId":"test_lowbat","transferMethod":"ble"}'
  sleep 3
  AFTER=$(count_photos)
  if [ "$AFTER" -eq "$BEFORE" ]; then
    pass "Photo correctly rejected at low battery (${BATTERY}%)"
  else
    fail "Photo was NOT rejected at low battery (${BATTERY}%)"
  fi
else
  info "Battery is ${BATTERY}% (above threshold) - skipping low battery test"
  pass "Battery level adequate for photo capture"
fi

summary

# --- Cleanup prompt ---
echo ""
TOTAL_ON_DEVICE=$(count_photos)
  if [ "$TOTAL_ON_DEVICE" -gt 0 ]; then
  if [ "${SKIP_CLEANUP_PROMPTS:-0}" = "1" ]; then
    adb shell "rm -rf '$CAMERA_DIR'/IMG_*" 2>/dev/null || true
    info "Wiped $TOTAL_ON_DEVICE photos from glasses"
  else
    echo -n "Delete $TOTAL_ON_DEVICE test photos from glasses? [y/N] "
    read -r REPLY
    if [[ "$REPLY" =~ ^[Yy]$ ]]; then
      adb shell "rm -rf '$CAMERA_DIR'/IMG_*" 2>/dev/null || true
      info "Deleted photos from glasses"
    else
      info "Photos kept on glasses"
    fi
  fi
fi

if [ "$PULL" = true ] && [ -d "$LOCAL_DIR" ]; then
  LOCAL_COUNT=$(find "$LOCAL_DIR" -maxdepth 1 \( -name "*.jpg" -o -name "*.avif" \) -type f 2>/dev/null | wc -l | tr -d ' ')
  if [ "${LOCAL_COUNT:-0}" -gt 0 ]; then
    if [ "${SKIP_CLEANUP_PROMPTS:-0}" = "1" ]; then
      rm -f "$LOCAL_DIR"/*.jpg "$LOCAL_DIR"/*.avif 2>/dev/null || true
      info "Wiped $LOCAL_COUNT local photos from $LOCAL_DIR"
    else
      echo -n "Delete $LOCAL_COUNT pulled photos from $LOCAL_DIR? [y/N] "
      read -r REPLY
      if [[ "$REPLY" =~ ^[Yy]$ ]]; then
        rm -f "$LOCAL_DIR"/*.jpg "$LOCAL_DIR"/*.avif 2>/dev/null || true
        info "Deleted local photos"
      else
        info "Local photos kept at: $LOCAL_DIR/"
      fi
    fi
  fi
fi
