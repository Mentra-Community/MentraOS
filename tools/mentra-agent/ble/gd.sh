#!/usr/bin/env bash
# Start/stop the glasses daemon. The daemon must run inside MentraBLE.app (for
# the Bluetooth grant) and stay alive, so we launch it DETACHED via LaunchServices
# (`open` without -W). Control it afterwards with glasses.mjs / curl on :PORT.
#
#   ./gd.sh start [port]   # launch the daemon (default port 8799)
#   ./gd.sh stop           # kill it
#   ./gd.sh status         # is it running?
set -euo pipefail
cd "$(dirname "$0")"
PORT="${2:-8799}"
PIDF="daemon.pid"

case "${1:-start}" in
  start)
    [ -d MentraBLE.app/Contents/MacOS ] || ./make-app.sh >/dev/null
    if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then
      echo "already running (pid $(cat "$PIDF"))"; exit 0
    fi
    open -n MentraBLE.app --args "$(pwd)/daemon.mjs" --port "$PORT"
    echo "launching daemon on :$PORT (detached, inside MentraBLE.app)..."
    for i in $(seq 1 20); do
      sleep 0.4
      if curl -s "http://127.0.0.1:$PORT/status" >/dev/null 2>&1; then echo "daemon up on :$PORT"; exit 0; fi
    done
    echo "daemon did not answer on :$PORT (check daemon.log)"; exit 1
    ;;
  stop)
    if [ -f "$PIDF" ]; then kill "$(cat "$PIDF")" 2>/dev/null || true; rm -f "$PIDF"; echo "stopped"; else echo "not running"; fi
    ;;
  status)
    if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF")" 2>/dev/null; then echo "running (pid $(cat "$PIDF"))"; else echo "not running"; fi
    ;;
  *) echo "usage: gd.sh {start [port]|stop|status}"; exit 1 ;;
esac
