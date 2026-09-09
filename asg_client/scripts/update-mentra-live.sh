#!/bin/bash
#
# Update ASG/BES/MTK firmware on a Mentra Live that already runs the custom
# client installed by dev-setup.sh, then return to that same client and data.
#
# Usage:
#   ADB_SERIAL=<serial> ./scripts/update-mentra-live.sh
#   ./scripts/update-mentra-live.sh --manifest-url <https-url>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "$SCRIPT_DIR/update-stock-for-dev.sh" --resume-thirdparty "$@"
