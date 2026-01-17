#!/bin/bash
# Automatically claims an available Android device, runs a command, then releases it.
# Uses flock on Linux (more robust) or mkdir on macOS (POSIX compatible).
#
# Usage:
#   ./scripts/run-with-device.sh <command> [args...]
#   ./scripts/run-with-device.sh bun test:maestro:captions
#   ./scripts/run-with-device.sh maestro test .maestro/flows/01-auth-flow.yaml
#
# How it works:
#   1. Lists all connected ADB devices
#   2. Tries to acquire an exclusive lock on each device
#   3. First available device gets claimed
#   4. Runs your command with ANDROID_SERIAL set
#   5. Lock is released when command finishes (or on script exit/crash)
#
# Environment variables:
#   DEVICE_LOCK_DIR - Override lock directory (default: /tmp/adb-device-locks)
#   DEVICE_TIMEOUT  - Seconds to wait for a device (default: 300 = 5 min)

set -e

LOCK_DIR="${DEVICE_LOCK_DIR:-/tmp/adb-device-locks}"
TIMEOUT="${DEVICE_TIMEOUT:-300}"
mkdir -p "$LOCK_DIR"

# Detect if flock is available (Linux has it, macOS doesn't by default)
USE_FLOCK=false
if command -v flock &>/dev/null; then
  USE_FLOCK=true
fi

if [ $# -eq 0 ]; then
  echo "Usage: $0 <command> [args...]"
  echo "Example: $0 bun test:maestro:captions"
  exit 1
fi

# Cleanup function to release lock on exit (for mkdir-based locking)
CLAIMED_LOCK=""
cleanup() {
  if [ -n "$CLAIMED_LOCK" ]; then
    if [ "$USE_FLOCK" = true ]; then
      # flock releases automatically when fd closes
      :
    else
      # mkdir-based: remove the directory
      rmdir "$CLAIMED_LOCK" 2>/dev/null || true
    fi
    echo ""
    echo "=========================================="
    echo "Released device: $(basename "${CLAIMED_LOCK%.lock}")"
    echo "=========================================="
  fi
}
trap cleanup EXIT INT TERM

# Get list of connected devices
get_devices() {
  adb devices 2>/dev/null | grep -E '\s+device$' | cut -f1
}

# Try to claim and run with flock (Linux)
try_flock_and_run() {
  local device="$1"
  shift
  local lock_file="$LOCK_DIR/$device.lock"

  (
    if ! flock -n 200; then
      exit 1
    fi

    export ANDROID_SERIAL="$device"
    echo "=========================================="
    echo "Claimed device: $device (flock)"
    echo "Running: $*"
    echo "=========================================="
    echo ""

    "$@"
  ) 200>"$lock_file"
}

# Try to claim with mkdir (macOS/POSIX)
try_mkdir_claim() {
  local device="$1"
  local lock_dir="$LOCK_DIR/$device.lock"

  # Clean up stale file locks (from failed flock attempts)
  if [ -f "$lock_dir" ]; then
    rm -f "$lock_dir"
  fi

  if mkdir "$lock_dir" 2>/dev/null; then
    CLAIMED_LOCK="$lock_dir"
    return 0
  fi
  return 1
}

# Main loop - keep trying until we get a device or timeout
start_time=$(date +%s)

while true; do
  devices=$(get_devices)

  if [ -z "$devices" ]; then
    echo "No Android devices connected. Waiting..."
    sleep 5
  else
    # Try each device
    for device in $devices; do
      if [ "$USE_FLOCK" = true ]; then
        # Linux: use flock (runs command inside subshell)
        if try_flock_and_run "$device" "$@"; then
          exit 0
        fi
      else
        # macOS: use mkdir
        if try_mkdir_claim "$device"; then
          export ANDROID_SERIAL="$device"
          echo "=========================================="
          echo "Claimed device: $device (mkdir)"
          echo "Running: $*"
          echo "=========================================="
          echo ""

          "$@"
          exit $?
        fi
      fi
    done

    # All devices busy
    echo "All devices busy. Waiting for one to become available..."
    sleep 2
  fi

  # Check timeout
  elapsed=$(($(date +%s) - start_time))
  if [ $elapsed -ge $TIMEOUT ]; then
    echo "ERROR: Timed out after ${TIMEOUT}s waiting for a device"
    exit 1
  fi
done
