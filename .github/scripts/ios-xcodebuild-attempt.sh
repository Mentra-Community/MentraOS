#!/usr/bin/env bash
# Run one xcodebuild attempt for the iOS PR build with full logging.
#
# Usage: ios-xcodebuild-attempt.sh <attempt-id> -- <command that runs xcodebuild...>
#   e.g. ios-xcodebuild-attempt.sh attempt-1 -- node mobile/ci/pr-ios/build.mjs
#
# The command is expected to run xcodebuild with -showBuildTimingSummary and
# without -quiet (this wrapper does the console filtering).
#
# - Full stdout+stderr goes to $RUNNER_TEMP/xcodebuild-<attempt-id>.log so the
#   artifact carries every compiler line while the console stays readable.
# - A timestamped copy (epoch seconds prefixed per line) goes to
#   <log>.timeline so ios-build-timeline.py can derive per-target windows;
#   xcodebuild itself prints no timestamps.
# - memory_pressure / vm_stat are sampled every 10 s into <log>.memory while
#   the build runs (regression matrix C2).
# - MENTRA_IOS_RESULT_BUNDLE names a fresh .xcresult path for the command to
#   pass as -resultBundlePath (xcodebuild refuses an existing path).
# - The console gets the xcbeautify --quiet view (errors, warnings, result)
#   when xcbeautify is installed, otherwise a grep of the same classes.
# - The step's exit status is xcodebuild's, taken from PIPESTATUS[0]. Neither
#   tee nor the filter can turn a failed build green, and the caller's retry
#   logic keys off this status.
# - Writes duration_seconds, status, log, timing_summary, timeline, memory
#   and result_bundle to GITHUB_OUTPUT.
set -u
set -o pipefail

attempt="${1:?attempt id required}"
shift
if [ "${1:-}" = "--" ]; then
  shift
fi
if [ "$#" -eq 0 ]; then
  echo "ios-xcodebuild-attempt.sh: no command given" >&2
  exit 2
fi

tmp="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
log="${tmp}/xcodebuild-${attempt}.log"
timing="${tmp}/xcodebuild-${attempt}.timing.txt"
timeline="${tmp}/xcodebuild-${attempt}.timeline"
memory="${tmp}/xcodebuild-${attempt}.memory"
result_bundle="${tmp}/xcodebuild-${attempt}.xcresult"
out="${GITHUB_OUTPUT:-/dev/null}"

rm -rf "$result_bundle"
export MENTRA_IOS_RESULT_BUNDLE="$result_bundle"

if command -v xcbeautify >/dev/null 2>&1; then
  filter=(xcbeautify --quiet)
else
  filter=(grep --line-buffered -E 'error:|warning:|\*\* (BUILD|ARCHIVE)|Build Timing Summary')
fi

# Memory sampler (macOS). Stops when the build finishes.
sampler_pid=""
if command -v memory_pressure >/dev/null 2>&1; then
  (
    while :; do
      printf '%s ' "$(date +%s)"
      memory_pressure -Q 2>/dev/null | tr '\n' ' '
      vm_stat 2>/dev/null | awk '/Pages free|Pages active|Pages inactive|Pageouts|Swapouts/ { gsub(/[.:]/, ""); printf "%s=%s ", $1$2, $NF }'
      echo
      sleep 10
    done
  ) > "$memory" 2>/dev/null &
  sampler_pid=$!
fi

started_at="$(date +%s)"
set +e
"$@" 2>&1 \
  | tee "$log" \
  | tee >(python3 -u -c 'import sys,time
for line in sys.stdin:
    sys.stdout.write(f"{time.time():.1f} {line}")' > "$timeline") \
  | "${filter[@]}"
status="${PIPESTATUS[0]}"
set -e
duration="$(( $(date +%s) - started_at ))"

if [ -n "$sampler_pid" ]; then
  kill "$sampler_pid" 2>/dev/null || true
  wait "$sampler_pid" 2>/dev/null || true
fi
# Give the timeline writer a moment to flush its last lines.
sleep 1

# The timing summary is the last block of xcodebuild output. Keep everything
# from its header onward (task-type rows plus the final BUILD line).
awk '/^Build Timing Summary/ {found=1} found' "$log" > "$timing" 2>/dev/null || true

{
  echo "duration_seconds=${duration}"
  echo "status=${status}"
  echo "log=${log}"
  echo "timing_summary=${timing}"
  echo "timeline=${timeline}"
  echo "memory=${memory}"
  if [ -d "$result_bundle" ]; then echo "result_bundle=${result_bundle}"; fi
} >> "$out"

if [ -d "$result_bundle" ]; then
  echo "Result bundle: $result_bundle ($(du -sh "$result_bundle" 2>/dev/null | cut -f1))"
fi
if [ "$status" -eq 0 ]; then
  echo "xcodebuild (${attempt}) succeeded in ${duration}s"
else
  echo "xcodebuild (${attempt}) failed with status ${status} after ${duration}s; full log: ${log}"
fi
exit "$status"
