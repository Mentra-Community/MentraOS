#!/usr/bin/env bash
# Application settings are synced by Porter's native Doppler integration.
# Manual mirroring recreated stale, competing groups; refuse to write them.
set -euo pipefail
printf '%s\n' 'Manual Porter secret mirroring has been removed. Update Doppler, repair the native integration if needed, then run node .github/scripts/porter-doppler-health.mjs from the repository root.' >&2
exit 1
