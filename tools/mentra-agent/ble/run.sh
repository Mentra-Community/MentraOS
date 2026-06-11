#!/usr/bin/env bash
# Launch a BLE script through MentraBLE.app so it inherits Bluetooth permission.
#
# Why: macOS only grants Bluetooth to a process that is its OWN "responsible
# process", which means launched via LaunchServices (`open`) from a bundle whose
# Info.plist declares NSBluetoothAlwaysUsageDescription. A script run straight
# from the shell inherits the terminal's (missing) permission and gets SIGABRT.
#
# So every BLE script writes its JSON result to a --out file; this wrapper does
# the `open -W` dance and prints that file back, making BLE scripts feel normal:
#
#   ./run.sh scan.mjs 12
#   ./run.sh connect.mjs "G1_34_L_484B26"
#
set -euo pipefail
cd "$(dirname "$0")"
SCRIPT="$1"; shift || true
[ -d MentraBLE.app/Contents/MacOS ] || ./make-app.sh >/dev/null

# BSD mktemp needs the X's at the end, so make a base then append suffixes.
BASE="$(mktemp -t mentra-ble)"
rm -f "$BASE"
OUT="$BASE.json"; LOG="$BASE.log"

# -W wait for exit, -n new instance. --args become the bundled node's argv.
open -W -n MentraBLE.app --args "$(pwd)/$SCRIPT" "$@" --out "$OUT" || true

if [ -s "$LOG" ]; then echo "--- log ---" >&2; cat "$LOG" >&2; fi
if [ -s "$OUT" ]; then cat "$OUT"; else
  echo '{"error":"no result — Bluetooth permission denied, or glasses not advertising"}' ; exit 1
fi
