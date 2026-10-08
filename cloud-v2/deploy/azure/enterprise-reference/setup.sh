#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
command -v python3 >/dev/null || { printf 'Python 3 is required. Azure Cloud Shell Bash includes it.\n' >&2; exit 1; }
python3 -c 'import sys; sys.exit(sys.version_info < (3, 9))' ||
  { printf 'Python 3.9 or newer is required (found %s). Azure Cloud Shell Bash includes it.\n' "$(python3 -V 2>&1)" >&2; exit 1; }
# Unbuffered, so progress appears immediately even when output goes to a log.
exec python3 -u "$SCRIPT_DIR/installer/setup.py" "$@"
