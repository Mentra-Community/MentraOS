set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

HOST="mentra-mini"
REMOTE_REPO='~/Documents/MentraOS'
PYTHON_BIN="/opt/homebrew/bin/python3.14"
PORT="8765"
OUTPUT_DIR="results"
AUDIO_DEVICE="External Headphones"
APP_PACKAGE="com.mentra.mentra"
BUILD_UI="1"
RESTART_APPS="1"
TAIL_LOG="0"
DEVICE_IDS=()

LOCAL_BRANCH="$(git -C "$REPO_ROOT" branch --show-current)"

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Redeploy the captions monitor to the Mentra Mac mini.

Options:
  --host HOST              SSH host alias to use (default: $HOST)
  --branch BRANCH          Git branch to deploy (default: current local branch: $LOCAL_BRANCH)
  --remote-repo PATH       Remote repo path (default: $REMOTE_REPO)
  --python-bin PATH        Remote Python binary (default: $PYTHON_BIN)
  --port PORT              Monitor port (default: $PORT)
  --output-dir DIR         Monitor output dir relative to mobile/e2e-tests (default: $OUTPUT_DIR)
  --audio-device NAME      macOS output device to require (default: $AUDIO_DEVICE)
  --app-package PACKAGE    Android package to restart after monitor launch (default: $APP_PACKAGE)
  --device SERIAL          Target a specific Android device serial (repeatable)
  --skip-ui-build          Skip rebuilding mobile/e2e-tests/ui before restart
  --skip-app-restart       Do not restart the Android app after monitor launch
  --tail                   Tail the remote monitor log after restart
  -h, --help               Show this help message
EOF
}

BRANCH="$LOCAL_BRANCH"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)
      HOST="$2"
      shift 2
      ;;
    --branch)
      BRANCH="$2"
      shift 2
      ;;
    --remote-repo)
      REMOTE_REPO="$2"
      shift 2
      ;;
    --python-bin)
      PYTHON_BIN="$2"
      shift 2
      ;;
    --port)
      PORT="$2"
      shift 2
      ;;
    --output-dir)
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --audio-device)
      AUDIO_DEVICE="$2"
      shift 2
      ;;
    --app-package)
      APP_PACKAGE="$2"
      shift 2
      ;;
    --device)
      DEVICE_IDS+=("$2")
      shift 2
      ;;
    --skip-ui-build)
      BUILD_UI="0"
      shift
      ;;
    --skip-app-restart)
      RESTART_APPS="0"
      shift
      ;;
    --tail)
      TAIL_LOG="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

echo "Deploying branch '$BRANCH' to '$HOST'..."

DEVICE_IDS_CSV=""
if [[ ${#DEVICE_IDS[@]} -gt 0 ]]; then
  DEVICE_IDS_CSV="$(IFS=,; printf '%s' "${DEVICE_IDS[*]}")"
fi

REMOTE_ENV="$(printf 'BRANCH=%q REMOTE_REPO=%q PYTHON_BIN=%q PORT=%q OUTPUT_DIR=%q AUDIO_DEVICE=%q APP_PACKAGE=%q BUILD_UI=%q RESTART_APPS=%q TAIL_LOG=%q DEVICE_IDS_CSV=%q' \
  "$BRANCH" "$REMOTE_REPO" "$PYTHON_BIN" "$PORT" "$OUTPUT_DIR" "$AUDIO_DEVICE" "$APP_PACKAGE" "$BUILD_UI" "$RESTART_APPS" "$TAIL_LOG" "$DEVICE_IDS_CSV")"

ssh "$HOST" "$REMOTE_ENV /bin/bash -s" <<'REMOTE'
set -euo pipefail

export PATH="/opt/homebrew/bin:$PATH"

cd "$REMOTE_REPO"

git fetch origin
if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git checkout "$BRANCH"
else
  git checkout -B "$BRANCH" "origin/$BRANCH"
fi
git pull --ff-only origin "$BRANCH"

cd mobile/e2e-tests

if [[ "$BUILD_UI" == "1" ]]; then
  echo "Building UI..."
  BUN_BIN="$(command -v bun || true)"
  if [[ -z "$BUN_BIN" ]]; then
    echo "bun is required to build the UI but was not found on PATH: $PATH" >&2
    exit 1
  fi
  (cd ui && "$BUN_BIN" run build)
fi

mkdir -p "$OUTPUT_DIR"

declare -a REMOTE_DEVICE_IDS=()
if [[ -n "${DEVICE_IDS_CSV:-}" ]]; then
  IFS=',' read -r -a REMOTE_DEVICE_IDS <<< "$DEVICE_IDS_CSV"
else
  while IFS= read -r device_id; do
    [[ -n "$device_id" ]] && REMOTE_DEVICE_IDS+=("$device_id")
  done < <(adb devices | awk '$2 == "device" {print $1}')
fi

declare -a MONITOR_ARGS=(
  --output-dir "$OUTPUT_DIR"
  --port "$PORT"
  --audio-output-device "$AUDIO_DEVICE"
)

if [[ ${#REMOTE_DEVICE_IDS[@]} -gt 0 ]]; then
  echo "Using Android device(s): ${REMOTE_DEVICE_IDS[*]}"
  for device_id in "${REMOTE_DEVICE_IDS[@]}"; do
    MONITOR_ARGS+=(--device "$device_id")
  done
else
  echo "No attached Android devices detected; starting monitor without explicit --device targeting."
fi

MONITOR_PATTERN="scripts/live_word_monitor.py --output-dir $OUTPUT_DIR --port $PORT"
old_pids="$(pgrep -f "$MONITOR_PATTERN" || true)"
if [[ -n "$old_pids" ]]; then
  echo "Stopping existing monitor PID(s): $old_pids"
  kill $old_pids
  sleep 2
fi

nohup "$PYTHON_BIN" scripts/live_word_monitor.py "${MONITOR_ARGS[@]}" > "$OUTPUT_DIR/live_word_monitor.log" 2>&1 < /dev/null &
new_pid="$!"

sleep 4

if [[ "$RESTART_APPS" == "1" && ${#REMOTE_DEVICE_IDS[@]} -gt 0 ]]; then
  echo "Restarting $APP_PACKAGE on Android device(s) so startup metrics are captured..."
  for device_id in "${REMOTE_DEVICE_IDS[@]}"; do
    adb -s "$device_id" shell am force-stop "$APP_PACKAGE" || echo "Warning: failed to force-stop $APP_PACKAGE on $device_id" >&2
  done
  sleep 1
  for device_id in "${REMOTE_DEVICE_IDS[@]}"; do
    adb -s "$device_id" shell monkey -p "$APP_PACKAGE" -c android.intent.category.LAUNCHER 1 >/dev/null \
      || echo "Warning: failed to launch $APP_PACKAGE on $device_id" >&2
  done

  echo "Waiting for backend config metrics..."
  expected_backend_count="${#REMOTE_DEVICE_IDS[@]}"
  for _ in {1..20}; do
    backend_count="$(
      curl -fsS "http://127.0.0.1:$PORT/state" 2>/dev/null \
        | jq -r '[.devices[] | select(.backend_url != null)] | length' 2>/dev/null \
        || true
    )"
    backend_count="${backend_count:-0}"
    if [[ "$backend_count" =~ ^[0-9]+$ && "$backend_count" -ge "$expected_backend_count" ]]; then
      break
    fi
    sleep 1
  done
  echo "  backend configs captured: $backend_count/$expected_backend_count"
fi

echo "Redeployed monitor"
echo "  branch: $(git branch --show-current)"
echo "  head:   $(git rev-parse HEAD)"
echo "  pid:    $new_pid"
ps -ww -p "$new_pid" -o pid=,etime=,command=
lsof -nP -iTCP:"$PORT" -sTCP:LISTEN

echo
echo "Log tail:"
tail -n 20 "$OUTPUT_DIR/live_word_monitor.log" || true

echo
echo "State:"
curl -fsS "http://127.0.0.1:$PORT/state" \
  | jq '{status, status_detail, last_error, devices: [.devices[] | {device_id, backend_url}]}'

if [[ "$TAIL_LOG" == "1" ]]; then
  echo
  echo "Tailing log. Press Ctrl+C to stop."
  exec tail -f "$OUTPUT_DIR/live_word_monitor.log"
fi
REMOTE
