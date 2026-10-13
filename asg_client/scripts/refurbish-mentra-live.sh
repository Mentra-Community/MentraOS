#!/bin/bash
#
# Bring one Mentra Live to the latest published glasses set for its track.
# The default track is production. This command does not restore a third-party client.
#
# Usage:
#   ./asg_client/scripts/refurbish-mentra-live.sh
#   ./asg_client/scripts/refurbish-mentra-live.sh --serial <adb-serial>
#   ./asg_client/scripts/refurbish-mentra-live.sh --cid <emmc-cid>
#   ./asg_client/scripts/refurbish-mentra-live.sh --track staging|dev

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/lib/stock-update-common.sh"
# shellcheck disable=SC1091
source "$REPO_DIR/scripts/lib/glasses-device.sh"

TRACK="production"
WANT_SERIAL=""
WANT_CID=""
REPORT_DIR="${MENTRA_REFURB_REPORT_DIR:-$HOME/mentra-live-refurbishment-reports}"
STARTED_AT="$(date +%s)"
RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
REASON=""
PIN_JSON=""
INVOCATION_JSON="$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1:]))' "$0" "$@")"

usage() {
  echo "Usage: $0 [--track production|staging|dev] [--serial <adb-serial>] [--cid <emmc-cid>] [--report-dir <dir>]"
  echo "Default track is production. Pass --serial when it identifies one Mentra Live."
  echo "Pass --cid when the serial is missing, duplicated, or $PLACEHOLDER_ADB_SERIAL."
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --track)
      [ "$#" -ge 2 ] || fail "--track requires production, staging, or dev"
      TRACK="${2:-}"
      shift 2
      ;;
    --serial)
      [ "$#" -ge 2 ] || fail "--serial requires a value"
      WANT_SERIAL="${2:-}"
      shift 2
      ;;
    --cid)
      [ "$#" -ge 2 ] || fail "--cid requires a value"
      WANT_CID="${2:-}"
      shift 2
      ;;
    --report-dir)
      [ "$#" -ge 2 ] || fail "--report-dir requires a directory"
      REPORT_DIR="${2:-}"
      shift 2
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

case "$TRACK" in
  production|staging|dev) ;;
  *) fail "Track must be production, staging, or dev" ;;
esac

mkdir -p "$REPORT_DIR"
TRANSCRIPT="$REPORT_DIR/$RUN_ID.txt"
PHASE_LOG="$REPORT_DIR/$RUN_ID.phases"
: > "$TRANSCRIPT"
: > "$PHASE_LOG"
export STOCK_UPDATE_PHASE_LOG="$PHASE_LOG"
exec > >(tee -a "$TRANSCRIPT") 2>&1

write_report() {
  local status="$1"
  local result="FAIL"
  [ "$status" -eq 0 ] && result="PASS"
  local elapsed=$(( $(date +%s) - STARTED_AT ))
  local report="$REPORT_DIR/$RUN_ID.json"
  local partial="$report.partial"
  RESULT="$result" STATUS="$status" ELAPSED="$elapsed" REPORT_PARTIAL="$partial" \
    ASG_BEFORE_CODE="${ASG_BEFORE_CODE:-}" ASG_BEFORE_NAME="${ASG_BEFORE_NAME:-}" \
    INITIAL_MTK="${INITIAL_MTK:-}" BES_BEFORE="${BES_BEFORE:-}" \
    TARGET_VERSION_CODE="${TARGET_VERSION_CODE:-}" TARGET_VERSION_NAME="${TARGET_VERSION_NAME:-}" \
    MTK_TARGET="${MTK_TARGET:-}" BES_VERSION="${BES_VERSION:-}" \
    FINAL_ASG_CODE="${FINAL_ASG_CODE:-}" FINAL_ASG_NAME="${FINAL_ASG_NAME:-}" \
    FINAL_MTK="${FINAL_MTK:-}" FINAL_BES="${FINAL_BES:-}" \
    SELECTED_SERIAL="${SELECTED_SERIAL:-}" SELECTED_CID="${SELECTED_CID:-}" \
    SELECTED_MAC="${SELECTED_MAC:-}" SELECTED_MODEL="${SELECTED_MODEL:-}" \
    TRACK="$TRACK" RUN_ID="$RUN_ID" REASON="${REASON:-}" \
    PIN_JSON="${PIN_JSON:-}" PHASE_LOG="$PHASE_LOG" WORK_DIR="${WORK_DIR:-}" \
    INVOCATION_JSON="$INVOCATION_JSON" \
    python3 - << 'PY'
import json, os
argv = json.loads(os.environ["INVOCATION_JSON"])
pin = {}
raw = os.environ.get("PIN_JSON", "")
if raw:
    pin = json.loads(raw)
artifacts = []
sizes = os.path.join(os.environ.get("WORK_DIR", ""), "artifact-sizes.tsv")
if os.environ.get("WORK_DIR") and os.path.isfile(sizes):
    for line in open(sizes):
        label, digest, size = line.rstrip("\n").split("\t")
        artifacts.append({"label": label, "sha256": digest, "expectedSize": int(size), "actualSize": int(size)})
phases = []
phase_log = os.environ.get("PHASE_LOG", "")
if phase_log and os.path.isfile(phase_log):
    for line in open(phase_log):
        if "\t" not in line:
            continue
        stamp, name = line.rstrip("\n").split("\t", 1)
        phases.append({"at": stamp, "name": name})
report = {
    "schemaVersion": 1,
    "runId": os.environ["RUN_ID"],
    "invocation": argv,
    "device": {
        "adbSerial": os.environ.get("SELECTED_SERIAL", ""),
        "productSerial": os.environ.get("SELECTED_SERIAL", ""),
        "model": os.environ.get("SELECTED_MODEL", ""),
        "mac": os.environ.get("SELECTED_MAC", ""),
        "cid": os.environ.get("SELECTED_CID", ""),
    },
    "release": {
        "track": os.environ["TRACK"],
        "releaseIdentity": pin.get("releaseIdentity", ""),
        "otaUrl": pin.get("otaUrl", ""),
        "otaSha256": pin.get("otaSha256", ""),
        "manifestSha256": pin.get("otaSha256", ""),
    },
    "versions": {
        "before": {
            "asgVersionName": os.environ.get("ASG_BEFORE_NAME", ""),
            "asgVersionCode": os.environ.get("ASG_BEFORE_CODE", ""),
            "mtk": os.environ.get("INITIAL_MTK", ""),
            "bes": os.environ.get("BES_BEFORE", ""),
        },
        "target": {
            "asgVersionName": os.environ.get("TARGET_VERSION_NAME", ""),
            "asgVersionCode": os.environ.get("TARGET_VERSION_CODE", ""),
            "mtk": os.environ.get("MTK_TARGET", ""),
            "bes": os.environ.get("BES_VERSION", ""),
        },
        "final": {
            "asgVersionName": os.environ.get("FINAL_ASG_NAME", ""),
            "asgVersionCode": os.environ.get("FINAL_ASG_CODE", ""),
            "mtk": os.environ.get("FINAL_MTK", ""),
            "bes": os.environ.get("FINAL_BES", ""),
        },
    },
    "artifacts": artifacts,
    "phases": phases,
    "elapsedSeconds": int(os.environ["ELAPSED"]),
    "result": os.environ["RESULT"],
    "reason": os.environ.get("REASON") or ("completed" if os.environ["RESULT"] == "PASS" else f"exit {os.environ['STATUS']}"),
}
partial = os.environ["REPORT_PARTIAL"]
with open(partial, "w") as handle:
    json.dump(report, handle, indent=2)
    handle.write("\n")
os.replace(partial, partial[: -len(".partial")])
PY
  echo "Result: $result"
  echo "Elapsed: ${elapsed}s"
  echo "Report: $report"
  echo "Transcript: $TRANSCRIPT"
}

finish() {
  local status=$?
  if [ ! -f "$REPORT_DIR/$RUN_ID.json" ]; then
    REASON="${REASON:-command failed before the glasses report was written}"
    write_report "$status" || true
  fi
  exit "$status"
}
trap finish EXIT

echo "Refurbishment run $RUN_ID"
echo "Track: $TRACK"
if [ -n "$WANT_SERIAL" ]; then
  echo "Requested serial: $WANT_SERIAL"
fi
if [ -n "$WANT_CID" ]; then
  echo "Requested eMMC CID: $WANT_CID"
fi

resolve_glasses_release() {
  if [ -n "$PIN_JSON" ]; then
    return 0
  fi
  echo "Resolving the $TRACK glasses release."
  local resolve_err resolve_status
  resolve_err="$(mktemp)"
  set +e
  PIN_JSON="$(node "$REPO_DIR/.github/scripts/resolve-glasses-release.mjs" --track "$TRACK" 2>"$resolve_err")"
  resolve_status=$?
  set -e
  if [ "$resolve_status" -ne 0 ]; then
    REASON="$(tr '\n' ' ' < "$resolve_err" 2>/dev/null || true)"
    cat "$resolve_err" >&2 || true
    rm -f "$resolve_err"
    [ -n "$REASON" ] || REASON="could not resolve the $TRACK glasses release"
    exit "$resolve_status"
  fi
  rm -f "$resolve_err"
  STOCK_UPDATE_TRACK="$TRACK"
  STOCK_UPDATE_RELEASE="$(printf '%s' "$PIN_JSON" | jq -er '.releaseIdentity')"
  MANIFEST_URL="$(printf '%s' "$PIN_JSON" | jq -er '.otaUrl')"
  STOCK_UPDATE_MANIFEST_SHA="$(printf '%s' "$PIN_JSON" | jq -er '.otaSha256')"
  export STOCK_UPDATE_TRACK STOCK_UPDATE_RELEASE MANIFEST_URL STOCK_UPDATE_MANIFEST_SHA
  echo "Pinned release $STOCK_UPDATE_RELEASE"
  echo "OTA manifest: $MANIFEST_URL"
}

if ! select_glasses_transport "$WANT_SERIAL" "$WANT_CID"; then
  if [ "$TRACK" = "production" ]; then
    echo "No single glasses was selected. Production is still resolved before any download."
    resolve_glasses_release
  fi
  REASON="could not select one Mentra Live"
  exit 11
fi
echo "Selected serial $SELECTED_SERIAL, transport $SELECTED_TRANSPORT, MAC $SELECTED_MAC, CID $SELECTED_CID."
case "$SELECTED_MODEL" in
  "Mentra Live"|Mentra_Live) ;;
  *)
    REASON="selected device model is ${SELECTED_MODEL:-unknown}, not Mentra Live"
    exit 11
    ;;
esac
pin_adb_transport "$SELECTED_TRANSPORT"
ADB=(adb)

if "${ADB[@]}" shell pm list packages -e 2>/dev/null | tr -d '\r' | grep -Fqx "package:$DEV_PKG"; then
  REASON="third-party launcher $DEV_PKG is enabled"
  echo "ERROR: $DEV_PKG is the enabled launcher. This command updates stock software only." >&2
  echo "Use $SCRIPT_DIR/update-mentra-live.sh to return to that client, or $SCRIPT_DIR/restore-stock.sh to leave it." >&2
  exit 11
fi

resolve_glasses_release

stock_update_on_exit() {
  local status="$1"
  if [ "$status" -eq 0 ]; then
    REASON="glasses are running the pinned versions"
  elif [ -z "$REASON" ]; then
    REASON="updater exited $status"
  fi
  write_report "$status"
}
STOCK_UPDATE_MODE=refurb
RESUME_THIRDPARTY=false
run_stock_firmware_update
