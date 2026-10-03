#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v python3 >/dev/null || { printf 'Python 3 is required. Azure Cloud Shell Bash includes it.\n' >&2; exit 1; }
exec python3 "$SCRIPT_DIR/installer/setup.py" "$@"
