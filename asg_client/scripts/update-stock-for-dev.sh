#!/bin/bash
#
# Bring Mentra Live firmware to one pinned glasses manifest, then optionally
# return to the third-party client installed by dev-setup.sh.
#
# Usage:
#   ADB_SERIAL=<serial> ./scripts/update-stock-for-dev.sh
#   ./scripts/update-stock-for-dev.sh --manifest-url <https-url>
#   ./scripts/update-stock-for-dev.sh --resume-thirdparty

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/stock-update-common.sh"

usage() {
  echo "Usage: $0 [--manifest-url <https-url>] [--resume-thirdparty]"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest-url)
      [ "$#" -ge 2 ] || fail "--manifest-url requires a URL"
      MANIFEST_URL="${2:-}"
      shift 2
      ;;
    --resume-thirdparty)
      RESUME_THIRDPARTY=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "Unknown option: $1"
      ;;
  esac
done

STOCK_UPDATE_MODE=developer
run_stock_firmware_update
