#!/usr/bin/env bash
# Drive an end-to-end iOS jetsam stress test on a connected device.
#
# What this does:
#   1. Streams the unified log to a file, filtering for STRESS:, jetsam,
#      our app crashes, and BLE state.
#   2. Replays a Maestro flow that opens the stress-test screen, mounts a
#      configurable number of dummy WebViews, and starts logging.
#   3. Optionally backgrounds the app, waits, then foregrounds and re-checks.
#   4. Pulls jetsam history out of the device after the run completes and
#      writes a parsed CSV next to the raw log.
#
# Usage:
#   ./run-jetsam-test.sh [scenario] [device]
#
# Scenarios (each maps to a Maestro flow + duration):
#   foreground   mount until jetsam, app stays foreground (default)
#   background   mount, then put app in background for 10 minutes
#   long         mount, then 60 minutes background
#   leak         mount 5 dummies, foreground, idle 60 minutes
#
# Device defaults to "Israelov" (iPhone 15) — change DEVICE_NAME below
# or pass as 2nd arg. Use `xcrun devicectl list devices` to see options.

set -euo pipefail

SCENARIO="${1:-foreground}"
DEVICE_NAME="${2:-Israelov}"
APP_BUNDLE_ID="${APP_BUNDLE_ID:-com.mentra.mentra}"
MB_PER_APP="${MB_PER_APP:-25}"
MAX_MOUNTS="${MAX_MOUNTS:-25}"
# Apple Team ID — required by maestro to build/sign its WebDriverAgent
# driver onto a real iOS device. One-time setup: `maestro driver-setup
# --apple-team-id <ID>`. Default is Mentra Labs.
APPLE_TEAM_ID="${APPLE_TEAM_ID:-T5XXXL6N36}"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RUN_ID="$(date +%Y%m%d-%H%M%S)-${SCENARIO}"
OUT_DIR="${ROOT}/scripts/stress-test/runs/${RUN_ID}"
mkdir -p "${OUT_DIR}"
LOG_FILE="${OUT_DIR}/raw.log"
META_FILE="${OUT_DIR}/meta.json"
CSV_FILE="${OUT_DIR}/events.csv"

echo "==> Run ID: ${RUN_ID}"
echo "==> Device: ${DEVICE_NAME}"
echo "==> Output: ${OUT_DIR}"

# -- 1. Sanity ---------------------------------------------------------------

# Resolve device identifier
DEVICE_ID="$(xcrun devicectl list devices 2>/dev/null \
  | awk -v name="${DEVICE_NAME}" '$1 == name { print $3 }')"
if [[ -z "${DEVICE_ID}" ]]; then
  echo "!! Device '${DEVICE_NAME}' not found. Connected devices:"
  xcrun devicectl list devices
  exit 1
fi
echo "==> Device ID: ${DEVICE_ID}"

# -- 2. Start log streaming in background ------------------------------------
# macOS `log stream` does NOT support real-device streaming via --device
# (only Mac and Simulator). For real devices we use `idevicesyslog` from
# libimobiledevice (`brew install libimobiledevice`). We filter to our app's
# process name (Mentra) and to jetsam-related kernel messages.
#
# Pre-flight: idevicesyslog needs the device to have been "Trusted" via the
# lockdown protocol. If you see "ERROR: No device found!" but devicectl can
# see the device, unplug + replug the phone, tap Trust on the dialog, enter
# passcode, and re-run.
if ! command -v idevicesyslog >/dev/null 2>&1; then
  echo "!! idevicesyslog not installed. Run: brew install libimobiledevice"
  exit 1
fi
if ! idevice_id -l 2>/dev/null | grep -q .; then
  echo "!! Device not visible via libimobiledevice (lockdown trust)."
  echo "   Unplug + replug your iPhone, tap 'Trust this Computer', enter"
  echo "   passcode, then re-run this script."
  exit 1
fi

echo "==> Starting idevicesyslog → ${LOG_FILE}"
# Capture jetsam/memorystatus kernel events (any process) plus everything
# from our process (which the device tags as "Mentra(<pid>)") and our
# STRESS: tag in console output. idevicesyslog has no process-name filter,
# so we use --match on the bracketed process tag form, which is reliable
# (avoids false matches against the WiFi SSID also being called "Mentra").
#
# Wrap in a relauncher so transient device disconnects (USB hiccups, sleep)
# don't silently kill the whole run.
(
  while true; do
    idevicesyslog \
      --match "Mentra(" \
      --match "jetsam" \
      --match "memorystatus" \
      --match "STRESS:" \
      --no-colors
    EC=$?
    echo "[harness] idevicesyslog exited code=${EC}, restarting in 1s" >&2
    sleep 1
  done
) >> "${LOG_FILE}" 2>&1 &
LOG_PID=$!
echo "==> idevicesyslog wrapper PID: ${LOG_PID}"
trap 'kill -- -${LOG_PID} 2>/dev/null || kill ${LOG_PID} 2>/dev/null || true' EXIT

# Give the log relay a beat to attach
sleep 3
# Verify the log relay actually attached. If not, fail fast — no point
# running the whole test with no observability.
if ! grep -q "connected:" "${LOG_FILE}" 2>/dev/null; then
  echo "!! idevicesyslog did not attach (LOG_FILE empty after 3s)."
  echo "   Make sure: phone is unlocked, USB is plugged in, and"
  echo "   'idevice_id -l' returns a UDID."
  exit 1
fi
echo "==> idevicesyslog attached"

# -- 3. Launch the app via deeplink that auto-runs the test ----------------
# The stress-test screen accepts query params:
#   autorun=1   → start logging + auto-mount on screen open
#   mb=N        → per-WebView heap size (5/25/50/100)
#   n=N         → number of dummies to mount
# DeeplinkContext.tsx maps /miniapps/settings/stress-test through and
# passes mb/n/autorun query params straight into the screen.
DEEPLINK="com.mentra:///miniapps/settings/stress-test?autorun=1&mb=${MB_PER_APP}&n=${MAX_MOUNTS}"
echo "==> Launching app with deeplink: ${DEEPLINK}"
xcrun devicectl device process launch \
  --device "${DEVICE_ID}" \
  --terminate-existing \
  --activate \
  --payload-url "${DEEPLINK}" \
  "${APP_BUNDLE_ID}" \
  > "${OUT_DIR}/launch.log" 2>&1 || {
    echo "!! Launch failed. Last few lines:"
    tail -10 "${OUT_DIR}/launch.log"
    exit 1
  }
# The screen needs a few seconds to mount, then it staggers its dummy mounts
# at 200ms intervals — give it MAX_MOUNTS * 200ms + 5s slack to be ready.
SETUP_S=$(( 5 + (MAX_MOUNTS * 200 + 999) / 1000 ))
echo "==> Waiting ${SETUP_S}s for deeplink + auto-mount to complete..."
sleep "${SETUP_S}"

# -- 5. Scenario-specific dwell time ----------------------------------------
case "${SCENARIO}" in
  foreground) DWELL=120 ;;        # 2 min watching events
  background) DWELL=600 ;;        # 10 min in BG
  long)       DWELL=3600 ;;       # 60 min in BG
  leak)       DWELL=3600 ;;       # 60 min idle FG
  *) echo "Unknown scenario: ${SCENARIO}"; exit 1 ;;
esac

if [[ "${SCENARIO}" == "background" || "${SCENARIO}" == "long" ]]; then
  echo "==> Sending app to background by activating Mobile Safari..."
  # Launching a different app forces Mentra into the background. We pick
  # Mobile Safari because every iOS device has it. iOS handles the
  # transition the same as if the user pressed Home / swiped up.
  xcrun devicectl device process launch \
    --device "${DEVICE_ID}" \
    --activate \
    com.apple.mobilesafari \
    > "${OUT_DIR}/background.log" 2>&1 || true
  echo "    To test 'screen off' precisely, lock your device's screen now"
  echo "    by pressing the side button (iOS doesn't expose lock to apps)."
fi

echo "==> Dwelling ${DWELL}s while events accumulate..."
# We confirm app death two ways and require BOTH before declaring it dead:
#   1. devicectl process listing has no Mentra entry
#   2. idevicesyslog has stopped emitting Mentra(*) lines for >15s
# This avoids false positives during scene transitions or process probe lag.
START_AT="$(date +%s)"
END_AT=$(( START_AT + DWELL ))
LAST_MENTRA_LINE_AT="${START_AT}"
DEATH_CONFIRMED=0
# Sleep up front so we don't probe during the launch-to-running window.
sleep 15
while (( $(date +%s) < END_AT )); do
  # devicectl process info is slow + flaky; use it loosely.
  PROC_COUNT="$(xcrun devicectl device info processes \
    --device "${DEVICE_ID}" 2>/dev/null \
    | grep -c "Mentra.app" || true)"
  # Fresh Mentra log lines indicate liveness — but only count log lines
  # FROM our app process, not wifid noise where SSID happens to be 'Mentra'.
  # Our app emits as `Mentra(<channel>)` like `Mentra(React)`, while wifid
  # emits the SSID inline like `wifid(WiFiPolicy)... for Mentra(ba:28:...)`.
  # Tracking the per-iteration LINE COUNT and only resetting LAST when it
  # grows is what we actually want.
  CURR_LINES="$(grep -E 'Mentra\((React|UIKitCore|Swift|libsystem|CoreFoundation|Foundation)' "${LOG_FILE}" 2>/dev/null | wc -l | tr -d ' ')"
  if [[ -z "${PREV_LINES:-}" ]]; then PREV_LINES=0; fi
  if (( CURR_LINES > PREV_LINES )); then
    LAST_MENTRA_LINE_AT="$(date +%s)"
    PREV_LINES="${CURR_LINES}"
  fi
  STALE_S=$(( $(date +%s) - LAST_MENTRA_LINE_AT ))
  ELAPSED=$(( $(date +%s) - START_AT ))
  echo "    [$(date +%H:%M:%S)] elapsed=${ELAPSED}s procs=${PROC_COUNT} log_stale=${STALE_S}s"
  if (( PROC_COUNT == 0 && STALE_S > 15 )); then
    echo "==> APP CONFIRMED DEAD at $(date +%H:%M:%S) (procs=0, no log lines for ${STALE_S}s)"
    DEATH_CONFIRMED=1
    break
  fi
  sleep 30
done
if (( DEATH_CONFIRMED == 0 )); then
  echo "==> App survived the dwell window (${DWELL}s) ✓"
fi

# -- 6. Stop log stream and parse -------------------------------------------
echo "==> Stopping log stream..."
kill ${LOG_PID} 2>/dev/null || true
wait ${LOG_PID} 2>/dev/null || true

# -- 7. Save metadata --------------------------------------------------------
cat > "${META_FILE}" <<EOF
{
  "runId": "${RUN_ID}",
  "scenario": "${SCENARIO}",
  "device": "${DEVICE_NAME}",
  "deviceId": "${DEVICE_ID}",
  "appBundleId": "${APP_BUNDLE_ID}",
  "mbPerApp": ${MB_PER_APP},
  "maxMounts": ${MAX_MOUNTS},
  "dwellSeconds": ${DWELL},
  "startedAt": "$(date -Iseconds)"
}
EOF

# -- 8. Parse STRESS: lines into CSV ----------------------------------------
echo "==> Parsing events..."
{
  echo "ts,kind,packageName,residentMB,mounted,terminated,memwarn,raw"
  grep -E 'STRESS: (sample|event|mount|unmount-all)' "${LOG_FILE}" \
    | sed -E 's/.*STRESS: //' \
    | python3 -c "
import sys, json
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    parts = line.split(' ', 1)
    kind = parts[0]
    payload = parts[1] if len(parts) > 1 else ''
    try:
        d = json.loads(payload) if payload.startswith('{') else {'msg': payload}
    except Exception:
        d = {'msg': payload}
    print('{},{},{},{},{},{},{},{}'.format(
        d.get('at', ''),
        d.get('kind', kind),
        d.get('packageName', ''),
        d.get('residentMB', ''),
        d.get('mounted', ''),
        d.get('terminated', ''),
        d.get('memwarn', ''),
        json.dumps(d).replace(',', ';'),
    ))
" || true
} > "${CSV_FILE}"

# -- 9. Summarize ------------------------------------------------------------
echo ""
echo "===================================================================="
echo "Run complete: ${RUN_ID}"
echo "===================================================================="
echo "Raw log:  ${LOG_FILE}"
echo "Events:   ${CSV_FILE}"
echo "Meta:     ${META_FILE}"
echo ""
echo "Quick summary:"
echo "  STRESS lines:        $(grep -c 'STRESS:' "${LOG_FILE}" || echo 0)"
echo "  Jetsam mentions:     $(grep -ci jetsam "${LOG_FILE}" || echo 0)"
echo "  Memorystatus:        $(grep -ci memorystatus "${LOG_FILE}" || echo 0)"
echo "  Memwarn JS events:   $(grep -c '\"kind\": *\"memwarn\"' "${LOG_FILE}" || echo 0)"
echo "  Terminate JS events: $(grep -c '\"kind\": *\"terminate\"' "${LOG_FILE}" || echo 0)"
echo ""
echo "Last 5 STRESS samples:"
grep 'STRESS: sample' "${LOG_FILE}" | tail -5 || echo "  (none)"
