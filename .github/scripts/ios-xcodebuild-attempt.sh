#!/usr/bin/env bash
# Run one xcodebuild attempt for the iOS compile check with full logging.
#
# Usage: ios-xcodebuild-attempt.sh <attempt-id> -- <xcodebuild args...>
#
# - Full stdout+stderr goes to $RUNNER_TEMP/xcodebuild-<attempt-id>.log so the
#   artifact carries every compiler line while the console stays readable.
# - The console gets the xcbeautify --quiet view (errors, warnings, result)
#   when xcbeautify is installed, otherwise a grep of the same classes.
# - The step's exit status is xcodebuild's, taken from PIPESTATUS[0]. Neither
#   tee nor the filter can turn a failed build green, and the caller's retry
#   logic keys off this status.
# - Writes duration_seconds, status, log and timing_summary to GITHUB_OUTPUT.
# - Extracts xcodebuild's "Build Timing Summary" (requires the caller to pass
#   -showBuildTimingSummary) into <log>.timing.txt for the job summary.
set -u
set -o pipefail

attempt="${1:?attempt id required}"
shift
if [ "${1:-}" = "--" ]; then
  shift
fi

tmp="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
log="${tmp}/xcodebuild-${attempt}.log"
timing="${tmp}/xcodebuild-${attempt}.timing.txt"
out="${GITHUB_OUTPUT:-/dev/null}"

if command -v xcbeautify >/dev/null 2>&1; then
  filter=(xcbeautify --quiet)
else
  filter=(grep --line-buffered -E 'error:|warning:|\*\* BUILD|Build Timing Summary')
fi

started_at="$(date +%s)"
set +e
xcodebuild "$@" 2>&1 | tee "$log" | "${filter[@]}"
status="${PIPESTATUS[0]}"
set -e
duration="$(( $(date +%s) - started_at ))"

# The timing summary is the last block of xcodebuild output. Keep everything
# from its header onward (task-type rows plus the final BUILD line).
awk '/^Build Timing Summary/ {found=1} found' "$log" > "$timing" 2>/dev/null || true

{
  echo "duration_seconds=${duration}"
  echo "status=${status}"
  echo "log=${log}"
  echo "timing_summary=${timing}"
} >> "$out"

if [ "$status" -eq 0 ]; then
  echo "xcodebuild (${attempt}) succeeded in ${duration}s"
else
  echo "xcodebuild (${attempt}) failed with status ${status} after ${duration}s; full log: ${log}"
fi
exit "$status"
