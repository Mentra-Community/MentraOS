#!/usr/bin/env bash
# Unified Mentra Live / glasses adb helper.
# Usage: scripts/glasses.sh <devices|logs|install|restart|pull-photos|wipe-photos> …
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/glasses-device.sh
source "${SCRIPT_DIR}/lib/glasses-device.sh"
MOBILE_SCRIPTS="$(cd "${SCRIPT_DIR}/../mobile/scripts" && pwd)"

usage() {
  cat <<EOF
Usage: $0 <command> [args]

Commands:
  devices                 List adb devices (-l)
  logs [tag] [--clear]    logcat dump (last 500 lines); optional single tag filter
  install <apk>           adb install -r -g
  restart                 force-stop ASG then start MainActivity
  pull-photos [flags]     proxy to mobile/scripts/pull-glasses-photos.sh
  wipe-photos [flags]     proxy to mobile/scripts/wipe-glasses-photos.sh (default dry-run)

Env:
  ADB_SERIAL   device serial (default ${DEFAULT_GLASSES_SERIAL})
EOF
}

cmd="${1:-}"
shift || true

case "$cmd" in
  devices)
    adb devices -l
    ;;
  logs)
    resolve_serial
    CLEAR=0
    TAG=""
    for a in "$@"; do
      case "$a" in
        --clear) CLEAR=1 ;;
        *) TAG="$a" ;;
      esac
    done
    if [[ "$CLEAR" -eq 1 ]]; then
      adb -s "$SERIAL" logcat -c
      echo "logcat cleared"
    fi
    if [[ -n "$TAG" ]]; then
      adb -s "$SERIAL" logcat -d -t 500 -s "$TAG"
    else
      adb -s "$SERIAL" logcat -d -t 500
    fi
    ;;
  install)
    resolve_serial
    apk="${1:-}"
    if [[ -z "$apk" || ! -f "$apk" ]]; then
      echo "Usage: $0 install <apk>" >&2
      exit 1
    fi
    adb -s "$SERIAL" install -r -g "$apk"
    ;;
  restart)
    resolve_serial
    resolve_package
    stop_asg
    adb -s "$SERIAL" shell am start -n "${PACKAGE}/.MainActivity"
    ;;
  pull-photos)
    exec bash "${MOBILE_SCRIPTS}/pull-glasses-photos.sh" "$@"
    ;;
  wipe-photos)
    exec bash "${MOBILE_SCRIPTS}/wipe-glasses-photos.sh" "$@"
    ;;
  ""|-h|--help|help)
    usage
    ;;
  *)
    echo "Unknown command: $cmd" >&2
    usage
    exit 1
    ;;
esac
