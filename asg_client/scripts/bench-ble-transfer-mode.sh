#!/bin/bash
# Benchmark OPTIMIZED vs LEGACY BleTransferMode pre-delay (debug builds).
# Reports UART dur (sendFile→complete) and end-to-end (pre-delay + UART dur).
set -euo pipefail

RUNS="${1:-5}"
MODES=("OPTIMIZED" "LEGACY")
RESULTS_FILE=$(mktemp)

trigger_photo() {
  local req=$1
  adb logcat -c >/dev/null
  adb shell 'am broadcast -n com.mentra.asg_client/com.mentra.asg_client.receiver.IntentCommandReceiver \
    -a com.mentra.asg_client.ACTION_SEND_COMMAND \
    --es json "{\"type\":\"take_photo\",\"requestId\":\"'"$req"'\",\"packageName\":\"com.mentra.test\",\"transferMethod\":\"ble\",\"bleImgId\":\"'"$req"'\",\"save\":false,\"size\":\"small\",\"flash\":false,\"sound\":false}"' \
    >/dev/null
}

expected_pre_delay() {
  local mode=$1
  if [ "$mode" = "OPTIMIZED" ]; then echo 75; else echo 200; fi
}

wait_and_parse() {
  local mode=$1
  local i=0
  while [ "$i" -lt 45 ]; do
    sleep 1
    local logs telemetry pre uart status rate
    logs=$(adb logcat -d 2>/dev/null || true)
    telemetry=$(echo "$logs" | rg "📊 \[$mode\] transfer=" | tail -1 || true)
    if [ -n "$telemetry" ]; then
      # Prefer measured values from logcat when visible (INFO/DEBUG).
      pre=$(echo "$logs" | rg "preDelay=([0-9]+)ms" | tail -1 | sed -n 's/.*preDelay=\([0-9]*\)ms.*/\1/p')
      if [ -z "$pre" ]; then
        pre=$(echo "$logs" | rg "Waited [0-9]+ms for JSON packet" | tail -1 | sed -n 's/.*Waited \([0-9]*\)ms.*/\1/p')
      fi
      if [ -z "$pre" ]; then
        pre=$(expected_pre_delay "$mode")
      fi
      uart=$(echo "$telemetry" | sed -n 's/.*dur=\([0-9]*\)ms.*/\1/p')
      rate=$(echo "$telemetry" | sed -n 's/.*rate=\([0-9]*\)B\/s.*/\1/p')
      status=$(echo "$telemetry" | sed -n 's/.*transfer=\([A-Z]*\).*/\1/p')
      if [ -n "$uart" ]; then
        echo "$status $pre $uart $rate"
        return 0
      fi
    fi
    i=$((i + 1))
  done
  return 1
}

for MODE in "${MODES[@]}"; do
  echo "=== Mode: $MODE ($RUNS runs) ==="
  adb shell am broadcast \
    -n com.mentra.asg_client/com.mentra.asg_client.io.bluetooth.managers.BleTransferModeReceiver \
    -a com.mentra.BLE_TRANSFER_MODE --es mode "$MODE" >/dev/null
  sleep 1

  for i in $(seq 1 "$RUNS"); do
    REQ="bench${MODE}${i}"
    trigger_photo "$REQ"
    if ! PARSED=$(wait_and_parse "$MODE"); then
      echo "  run $i: NO_RESULT"
      echo "$MODE,$i,FAIL,0,0,0,0" >> "$RESULTS_FILE"
    else
      read -r STATUS PRE UART RATE <<< "$PARSED"
      TOTAL=$((PRE + UART))
      echo "  run $i: $STATUS pre=${PRE}ms uart=${UART}ms total=${TOTAL}ms rate=${RATE}B/s"
      echo "$MODE,$i,$STATUS,$PRE,$UART,$TOTAL,$RATE" >> "$RESULTS_FILE"
    fi
    sleep 2
  done
done

echo ""
echo "=== AVERAGES (OK runs only) ==="
python3 - "$RESULTS_FILE" <<'PY'
import csv, sys
from collections import defaultdict

stats = defaultdict(lambda: {"pre": [], "uart": [], "total": [], "rate": []})
with open(sys.argv[1]) as f:
    for row in csv.reader(f):
        mode, run, status, pre, uart, total, rate = row
        if status == "OK":
            stats[mode]["pre"].append(int(pre))
            stats[mode]["uart"].append(int(uart))
            stats[mode]["total"].append(int(total))
            stats[mode]["rate"].append(int(rate))

for mode in ["OPTIMIZED", "LEGACY"]:
    s = stats[mode]
    if s["total"]:
        n = len(s["total"])
        print(
            f"{mode}: n={n}\n"
            f"  avg_pre_delay={sum(s['pre'])/n:.1f}ms\n"
            f"  avg_uart_dur={sum(s['uart'])/n:.1f}ms  (telemetry dur=)\n"
            f"  avg_total={sum(s['total'])/n:.1f}ms  (pre + uart)\n"
            f"  avg_rate={sum(s['rate'])/n:.0f}B/s"
        )
    else:
        print(f"{mode}: no successful runs")

if stats["OPTIMIZED"]["total"] and stats["LEGACY"]["total"]:
    def avg(xs):
        return sum(xs) / len(xs)
    op, lp = avg(stats["OPTIMIZED"]["pre"]), avg(stats["LEGACY"]["pre"])
    ou, lu = avg(stats["OPTIMIZED"]["uart"]), avg(stats["LEGACY"]["uart"])
    ot, lt = avg(stats["OPTIMIZED"]["total"]), avg(stats["LEGACY"]["total"])
    print("\nDelta (LEGACY - OPTIMIZED):")
    print(f"  pre_delay: {lp - op:+.1f}ms")
    print(f"  uart_dur:  {lu - ou:+.1f}ms")
    print(f"  total:     {lt - ot:+.1f}ms")
PY

rm -f "$RESULTS_FILE"
