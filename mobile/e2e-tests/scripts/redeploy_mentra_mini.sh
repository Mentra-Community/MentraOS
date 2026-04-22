set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

HOST="mentra-mini"
REMOTE_REPO='~/Documents/MentraOS'
PYTHON_BIN="/opt/homebrew/bin/python3.14"
PORT="8765"
OUTPUT_DIR="results"
AUDIO_DEVICE="External Headphones"
BUILD_UI="1"
TAIL_LOG="0"

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
  --skip-ui-build          Skip rebuilding mobile/e2e-tests/ui before restart
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
    --skip-ui-build)
      BUILD_UI="0"
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

REMOTE_ENV="$(printf 'BRANCH=%q REMOTE_REPO=%q PYTHON_BIN=%q PORT=%q OUTPUT_DIR=%q AUDIO_DEVICE=%q BUILD_UI=%q TAIL_LOG=%q' \
  "$BRANCH" "$REMOTE_REPO" "$PYTHON_BIN" "$PORT" "$OUTPUT_DIR" "$AUDIO_DEVICE" "$BUILD_UI" "$TAIL_LOG")"

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

MONITOR_PATTERN="scripts/live_word_monitor.py --output-dir $OUTPUT_DIR --port $PORT"
old_pids="$(pgrep -f "$MONITOR_PATTERN" || true)"
if [[ -n "$old_pids" ]]; then
  echo "Stopping existing monitor PID(s): $old_pids"
  kill $old_pids
  sleep 2
fi

nohup "$PYTHON_BIN" scripts/live_word_monitor.py \
  --output-dir "$OUTPUT_DIR" \
  --port "$PORT" \
  --audio-output-device "$AUDIO_DEVICE" \
  > "$OUTPUT_DIR/live_word_monitor.log" 2>&1 < /dev/null &
new_pid="$!"

sleep 4

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
curl -fsS "http://127.0.0.1:$PORT/state" | jq '{status, status_detail, last_error}'

if [[ "$TAIL_LOG" == "1" ]]; then
  echo
  echo "Tailing log. Press Ctrl+C to stop."
  exec tail -f "$OUTPUT_DIR/live_word_monitor.log"
fi
REMOTE
