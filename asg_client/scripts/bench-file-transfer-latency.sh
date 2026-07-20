#!/usr/bin/env bash
# Benchmark Mentra asg_client UART file-transfer latency from logcat.
#
# Mentra emits Mentra-vs-K900Server packet clocks in two places after a BLE photo:
#   1) Standalone SUMMARY:
#        I FileTransferLatency: SUMMARY ... ack_to_send_p50_ms=... packet_rtt_p50_ms=...
#   2) Inside BlePhotoTiming PHASE BREAKDOWN → PAYLOAD / TRANSFER:
#        ack→send p50 / packet RTT p50 / packets/sec
#
# Compare against 刘新云 / K900Server (com.lhs.btserver) using the same wall clocks:
#   ack_to_send  ≈ time from ACK observed → next sendFile  (their <<< → sendFile ≈ 1ms)
#   packet_rtt   ≈ send → matching ACK                     (their full round trip ≈ 11ms)
#   packets/s    ≈ completed ACKed packets / elapsed
#
# Usage:
#   ./asg_client/scripts/bench-file-transfer-latency.sh           # wait for next Mentra SUMMARY
#   ./asg_client/scripts/bench-file-transfer-latency.sh --dump    # parse existing logcat buffer
#   ./asg_client/scripts/bench-file-transfer-latency.sh --k900    # show K900Server filter hints
#
set -euo pipefail

MODE="wait"
TIMEOUT_SEC="${TIMEOUT_SEC:-120}"

for arg in "$@"; do
  case "$arg" in
    --dump) MODE="dump" ;;
    --k900) MODE="k900" ;;
    --help|-h)
      sed -n '2,20p' "$0"
      exit 0
      ;;
  esac
done

if ! command -v adb >/dev/null 2>&1; then
  echo "adb not found on PATH" >&2
  exit 1
fi

print_k900_hints() {
  cat <<'EOF'
K900Server (com.lhs.btserver) comparison filters
===============================================
On the same glasses hardware, capture:

  adb logcat -v time -s _test_:E | tee /tmp/k900server-transfer.log

Look for pairs like:
  E <<< {"C":"cs_flts","B":{"type":52,"state":1,"index":N}}
  E sendFile num=...,index=N

Mentra clocks to compare:
  ack_to_send_ms  = timestamp(sendFile) - timestamp(<<<)     # target ~1ms
  packet_rtt_ms   = timestamp(<<< for index N) - prior send  # target ~11ms
  packets_per_sec = completed indices / wall seconds         # target ~90

Mentra (this APK) — same clocks appear in:
  adb logcat -v time -s FileTransferLatency:I BlePhotoTiming:I
Look for either the FileTransferLatency SUMMARY line or the PHASE BREAKDOWN
PAYLOAD / TRANSFER rows: ack→send p50, packet RTT p50, packets/sec.
EOF
}

parse_summary_line() {
  local line="$1"
  # Keep the SUMMARY payload only.
  if [[ "$line" != *"SUMMARY "* ]]; then
    return 1
  fi
  echo "$line" | sed -E 's/.*SUMMARY /SUMMARY /'
}

print_table_from_summary() {
  local summary="$1"
  echo
  echo "Mentra file-transfer latency"
  echo "============================"
  echo "$summary"
  echo
  # Pull key fields into a short table when present.
  python3 - "$summary" <<'PY' 2>/dev/null || true
import re, sys
s = sys.argv[1]
def grab(key):
    m = re.search(rf'{key}=([^\s]+)', s)
    return m.group(1) if m else "na"
rows = [
    ("file", grab("file")),
    ("ack_to_send_p50_ms", grab("ack_to_send_p50_ms")),
    ("ack_to_send_p95_ms", grab("ack_to_send_p95_ms")),
    ("packet_rtt_p50_ms", grab("packet_rtt_p50_ms")),
    ("packet_rtt_p95_ms", grab("packet_rtt_p95_ms")),
    ("packets_per_sec", grab("packets_per_sec")),
    ("kb_per_sec", grab("kb_per_sec")),
    ("elapsed_ms", grab("elapsed_ms")),
]
width = max(len(k) for k, _ in rows)
for k, v in rows:
    print(f"  {k.ljust(width)}  {v}")
print()
print("Notes:")
print("  ack_to_send_*  = Mentra-owned turnaround (ACK seen → next packet write)")
print("  packet_rtt_*   = Mentra + BES/BLE wait (send → matching ACK)")
print("  Compare ack_to_send_p50_ms to K900Server's ~1ms <<<→sendFile gap.")
PY
}

if [[ "$MODE" == "k900" ]]; then
  print_k900_hints
  exit 0
fi

if [[ "$MODE" == "dump" ]]; then
  echo "Scanning current logcat buffer for FileTransferLatency SUMMARY..."
  mapfile -t lines < <(adb logcat -d -v time -s FileTransferLatency:I 2>/dev/null | grep 'SUMMARY ' || true)
  if [[ ${#lines[@]} -eq 0 ]]; then
    echo "No Mentra SUMMARY lines found. Trigger a BLE photo/file transfer, then re-run."
    exit 2
  fi
  print_table_from_summary "$(parse_summary_line "${lines[-1]}")"
  exit 0
fi

echo "Clearing logcat and waiting up to ${TIMEOUT_SEC}s for Mentra FileTransferLatency SUMMARY..."
echo "Trigger a BLE photo / file transfer on the glasses now."
adb logcat -c >/dev/null 2>&1 || true

deadline=$((SECONDS + TIMEOUT_SEC))
while (( SECONDS < deadline )); do
  line="$(adb logcat -d -v time -s FileTransferLatency:I 2>/dev/null | grep 'SUMMARY ' | tail -n 1 || true)"
  if [[ -n "$line" ]]; then
    print_table_from_summary "$(parse_summary_line "$line")"
    echo "K900Server filter hints: $0 --k900"
    exit 0
  fi
  sleep 1
done

echo "Timed out waiting for FileTransferLatency SUMMARY after ${TIMEOUT_SEC}s" >&2
exit 3
