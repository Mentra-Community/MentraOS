#!/usr/bin/env bash
# Run a stream preview Maestro flow against a device, then pull the frame-preview NDJSON run logs
# it produced. Used for the preview lifecycle check and the release memory gate.
#
#   stream-preview-run.sh android|ios "<teams meeting url>" [out-dir] [flow]
#
# flow defaults to flows/99-call-stream-preview-lifecycle.yaml. Extra Maestro env can be passed
# through TOGGLES, REOPENS, RELOADS, BACKGROUND_MS and FRAMES_TIMEOUT_MS.
#
# Android: needs adb and a debug build (the reload hook uses the WebView DevTools socket). Logs come
# from /sdcard/Android/data/<app-id>/files/frame-preview/.
# iOS: needs IOS_DEVICE (xcrun devicectl list devices) and a development-signed build. Reloads are
# not automated on iOS, so the flow skips them there.
#
# Summarise the pulled files with the gate tooling, e.g.
#   cd mobile/modules/frame-preview/tools && bun preview-run.ts retained <first>.ndjson <last>.ndjson
set -euo pipefail

PLATFORM="${1:?usage: stream-preview-run.sh android|ios <meeting-url> [out-dir] [flow]}"
MEETING_URL="${2:?usage: stream-preview-run.sh android|ios <meeting-url> [out-dir] [flow]}"
OUT="${3:-runs/stream-preview-$(date +%Y%m%d-%H%M%S)}"
HERE="$(cd "$(dirname "$0")" && pwd)"
MAESTRO_DIR="$(dirname "$HERE")"
FLOW="${4:-$MAESTRO_DIR/flows/99-call-stream-preview-lifecycle.yaml}"
APP_ID="${MAESTRO_APP_ID:-com.mentra.mentra}"
HOOK_PORT="${RELOAD_HOOK_PORT:-8791}"
ANDROID_LOG_DIR="/sdcard/Android/data/$APP_ID/files/frame-preview"

mkdir -p "$OUT"
flow_env=(-e "MAESTRO_APP_ID=$APP_ID" -e "MEETING_URL=$MEETING_URL")
for name in TOGGLES REOPENS RELOADS BACKGROUND_MS FRAMES_TIMEOUT_MS; do
  if [ -n "${!name:-}" ]; then flow_env+=(-e "$name=${!name}"); fi
done

run_flow() {
  set +e
  maestro test "${flow_env[@]}" "$FLOW" 2>&1 | tee "$OUT/maestro.log"
  local status=${PIPESTATUS[0]}
  set -e
  return "$status"
}

status=0
case "$PLATFORM" in
  android)
    adb shell ls "$ANDROID_LOG_DIR" 2>/dev/null | tr -d '\r' | sort >"$OUT/.before" || true
    bun "$HERE/stream-preview-reload-hook.ts" >"$OUT/reload-hook.log" 2>&1 &
    hook_pid=$!
    trap 'kill "$hook_pid" 2>/dev/null || true' EXIT
    for _ in $(seq 1 50); do
      curl -fs "http://127.0.0.1:$HOOK_PORT/health" >/dev/null 2>&1 && break
      sleep 0.2
    done
    flow_env+=(-e "RELOAD_HOOK_URL=http://127.0.0.1:$HOOK_PORT")
    run_flow || status=$?
    adb shell ls "$ANDROID_LOG_DIR" 2>/dev/null | tr -d '\r' | sort >"$OUT/.after" || true
    comm -13 "$OUT/.before" "$OUT/.after" | while read -r file; do
      [ -n "$file" ] && adb pull "$ANDROID_LOG_DIR/$file" "$OUT/" >/dev/null
    done
    rm -f "$OUT/.before" "$OUT/.after"
    ;;
  ios)
    : "${IOS_DEVICE:?set IOS_DEVICE to the devicectl device id}"
    echo "iOS: the flow skips the page reloads (no reload hook). Record the gate run as"
    echo "toggles + dismiss/reopen + background only, or reload by hand from Safari > Develop."
    run_flow || status=$?
    xcrun devicectl device copy from --device "$IOS_DEVICE" \
      --domain-type appDataContainer --domain-identifier "$APP_ID" \
      --source "Library/Application Support/frame-preview" --destination "$OUT/"
    ;;
  *)
    echo "unknown platform: $PLATFORM (android|ios)" >&2
    exit 64
    ;;
esac

echo "Run logs in $OUT:"
find "$OUT" -name '*.ndjson' | sort
exit "$status"
