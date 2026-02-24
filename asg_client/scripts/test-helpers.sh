#!/bin/bash
#
# Shared helpers for ASG test scripts
#

PKG="com.mentra.asg_client"
RECEIVER="$PKG/.receiver.DebugTestReceiver"
ACTION="com.mentra.DEBUG_TEST"
CAMERA_DIR="/sdcard/Android/data/$PKG/files/$PKG.camera"
LOG_TAG="DebugTestReceiver"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

PASS_COUNT=0
FAIL_COUNT=0

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  echo -e "${GREEN}PASS${NC}: $1"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  echo -e "${RED}FAIL${NC}: $1"
}

warn() {
  echo -e "${YELLOW}WARN${NC}: $1"
}

info() {
  echo "  $1"
}

# Send a JSON command to the glasses via ADB broadcast
send_command() {
  local json="$1"
  adb shell am broadcast -a "$ACTION" -n "$RECEIVER" --es json "'$json'" > /dev/null 2>&1
}

# Get battery level
get_battery() {
  adb shell dumpsys battery | grep "level:" | awk '{print $2}'
}

# Count files in camera directory
count_camera_files() {
  local count
  count=$(adb shell "ls '$CAMERA_DIR' 2>/dev/null | wc -l" | tr -d '[:space:]')
  echo "${count:-0}"
}

# Count only JPEGs
count_photos() {
  local count
  count=$(adb shell "ls '$CAMERA_DIR'/*.jpg 2>/dev/null | wc -l" | tr -d '[:space:]')
  echo "${count:-0}"
}

# Count only videos
count_videos() {
  local count
  count=$(adb shell "ls '$CAMERA_DIR'/*.mp4 2>/dev/null | wc -l" | tr -d '[:space:]')
  echo "${count:-0}"
}

# Get most recent file in camera dir
latest_file() {
  adb shell "ls -t '$CAMERA_DIR' 2>/dev/null | head -1" | tr -d '[:space:]'
}

# Get file size in bytes
file_size() {
  adb shell "stat -c %s '$1' 2>/dev/null" | tr -d '[:space:]'
}

# Check JPEG header (first 2 bytes should be FF D8)
is_valid_jpeg() {
  local header
  header=$(adb shell "xxd -l 2 -p '$1' 2>/dev/null" | tr -d '[:space:]')
  [ "$header" = "ffd8" ]
}

# Check MP4 has ftyp box (valid MP4 header)
is_valid_mp4() {
  local header
  header=$(adb shell "xxd -l 8 '$1' 2>/dev/null" | grep -c "ftyp")
  [ "$header" -gt 0 ]
}

# Check MP4 has moov atom (not corrupted / properly finalized)
has_moov_atom() {
  local found
  found=$(adb shell "grep -c 'moov' '$1' 2>/dev/null" | tr -d '[:space:]')
  [ "${found:-0}" -gt 0 ]
}

# Get free storage in MB
free_storage_mb() {
  adb shell "df /sdcard" | tail -1 | awk '{print int($4/1024)}'
}

# Check ADB connection
check_adb() {
  if ! adb devices 2>/dev/null | grep -q "device$"; then
    echo -e "${RED}ERROR${NC}: No ADB device connected."
    exit 1
  fi
}

# Check service is running
check_service() {
  if ! adb shell "dumpsys activity services $PKG" 2>/dev/null | grep -q "AsgClientService"; then
    echo -e "${RED}ERROR${NC}: AsgClientService is not running."
    exit 1
  fi
}

# Print test summary
summary() {
  echo ""
  echo "=========================================="
  local total=$((PASS_COUNT + FAIL_COUNT))
  echo "Results: $PASS_COUNT/$total passed"
  if [ "$FAIL_COUNT" -gt 0 ]; then
    echo -e "${RED}$FAIL_COUNT test(s) failed${NC}"
  else
    echo -e "${GREEN}All tests passed${NC}"
  fi
  echo "=========================================="
}
