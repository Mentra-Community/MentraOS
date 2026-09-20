#!/usr/bin/env bash
# Write the iOS compile-check job summary: attempt outcomes, per-step timings
# for THIS job so far (from the Actions jobs API), xcodebuild's Build Timing
# Summary per attempt, and the Actions cache state recorded at job start.
#
# Everything here is diagnostic. The caller marks the step continue-on-error
# so a summary hiccup can never fail the compile check.
#
# Inputs (env):
#   GH_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, RUNNER_NAME
#   GITHUB_STEP_SUMMARY, RUNNER_TEMP
#   JOB_STARTED_AT            epoch seconds recorded by the first step
#   CACHE_SIZE_BYTES, CACHE_COUNT   Actions cache usage at job start
#   DERIVED_CACHE_HIT         optional; printed when set
#   ATTEMPT1_OUTCOME, ATTEMPT1_SECONDS, ATTEMPT1_TIMING, ATTEMPT1_TIMELINE, ATTEMPT1_MEMORY
#   ATTEMPT2_OUTCOME, ATTEMPT2_SECONDS, ATTEMPT2_TIMING, ATTEMPT2_TIMELINE, ATTEMPT2_MEMORY
#   EVENT_NAME, PR_COMPILE_MODE, HEAD_SHA
#   CCACHE_ENABLED, CCACHE_STATSLOG, CCACHE_DIR   per-job ccache stats when enabled
set -u

summary="${GITHUB_STEP_SUMMARY:-/dev/stdout}"
tmp="${RUNNER_TEMP:-/tmp}"

format_duration() {
  local seconds="$1"
  if ! [[ "$seconds" =~ ^[0-9]+$ ]]; then
    echo "not recorded"
    return
  fi
  printf '%dm %02ds' "$((seconds / 60))" "$((seconds % 60))"
}

now="$(date +%s)"
elapsed="not recorded"
if [[ "${JOB_STARTED_AT:-}" =~ ^[0-9]+$ ]]; then
  elapsed="$(format_duration "$((now - JOB_STARTED_AT))")"
fi

{
  echo "## iOS compile check timing"
  echo ""
  echo "- Runner: \`${RUNNER_NAME:-unknown}\`  event: \`${EVENT_NAME:-?}\`  PR compile mode: \`${PR_COMPILE_MODE:-?}\`  sha: \`${HEAD_SHA:-?}\`"
  echo "- Elapsed at summary time (excludes post-job steps such as cache saves): **${elapsed}**"
  if [ -n "${DERIVED_CACHE_HIT:-}" ]; then
    echo "- DerivedData exact-key cache hit: ${DERIVED_CACHE_HIT}"
  fi
  echo ""
  echo "| Attempt | Outcome | Duration |"
  echo "| --- | --- | ---: |"
  echo "| First build | ${ATTEMPT1_OUTCOME:-not run} | $(format_duration "${ATTEMPT1_SECONDS:-}") |"
  echo "| Clean-cache retry | ${ATTEMPT2_OUTCOME:-not run} | $(format_duration "${ATTEMPT2_SECONDS:-}") |"
  echo ""
} >> "$summary"

# Per-step table for this job from the jobs API. Steps still running (this
# one and the post steps) have no completed_at and are listed as in progress.
steps_json=""
if command -v gh >/dev/null 2>&1 && command -v jq >/dev/null 2>&1 && [ -n "${GH_TOKEN:-}" ]; then
  jobs_json="$(gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/attempts/${GITHUB_RUN_ATTEMPT:-1}/jobs" 2>/dev/null || true)"
  if [ -n "$jobs_json" ]; then
    steps_json="$(printf '%s' "$jobs_json" | jq -c --arg runner "${RUNNER_NAME:-}" '
      [.jobs[] | select($runner == "" or .runner_name == $runner)] | sort_by(.started_at) | last
      | (.steps // [])[]
      | {name, conclusion, started_at, completed_at}' 2>/dev/null || true)"
  fi
fi

if [ -n "$steps_json" ]; then
  {
    echo "### Steps (this job, so far)"
    echo ""
    echo "| Step | Outcome | Duration |"
    echo "| --- | --- | ---: |"
    printf '%s\n' "$steps_json" | jq -r '
      def secs: if . == null then null else (sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) end;
      . as $s
      | (($s.completed_at | secs) as $c | ($s.started_at | secs) as $b
         | if $c == null or $b == null then "in progress" else (($c - $b) | tostring + "s") end) as $d
      | "| \($s.name) | \($s.conclusion // "running") | \($d) |"'
    echo ""
  } >> "$summary"
else
  {
    echo "_Per-step table unavailable (jobs API not reachable from this job)._"
    echo ""
  } >> "$summary"
fi

emit_timing() {
  local title="$1" file="$2"
  if [ -n "$file" ] && [ -s "$file" ]; then
    {
      echo "### ${title}: xcodebuild Build Timing Summary"
      echo ""
      echo '```'
      # Cap so a pathological summary cannot blow the 1 MiB step-summary limit.
      head -c 60000 "$file"
      echo '```'
      echo ""
    } >> "$summary"
  fi
}
emit_timing "First build" "${ATTEMPT1_TIMING:-}"
emit_timing "Clean-cache retry" "${ATTEMPT2_TIMING:-}"

emit_timeline() {
  local title="$1" file="$2" mem="$3"
  local script="${GITHUB_WORKSPACE:-.}/.github/scripts/ios-build-timeline.py"
  if [ -n "$file" ] && [ -s "$file" ] && [ -f "$script" ]; then
    {
      echo "### ${title}: task timeline"
      echo ""
      python3 "$script" "$file" "${mem:-}" --top=12 2>/dev/null || echo "_timeline analysis failed_"
      echo ""
    } >> "$summary"
  fi
}
emit_timeline "First build" "${ATTEMPT1_TIMELINE:-}" "${ATTEMPT1_MEMORY:-}"
emit_timeline "Clean-cache retry" "${ATTEMPT2_TIMELINE:-}" "${ATTEMPT2_MEMORY:-}"

if [ "${CCACHE_ENABLED:-false}" = "true" ] && command -v ccache >/dev/null 2>&1; then
  {
    echo "### ccache (this job only, from CCACHE_STATSLOG)"
    echo ""
    echo '```'
    if [ -n "${CCACHE_STATSLOG:-}" ] && [ -s "$CCACHE_STATSLOG" ]; then
      ccache --show-log-stats 2>&1 | head -40
    else
      echo "(no stats log written; no compiler invocation went through ccache)"
    fi
    echo '```'
    echo ""
    echo "Shared cache dir: \`${CCACHE_DIR:-?}\` — $(ccache --show-stats 2>/dev/null | grep -iE 'cache size|max cache size' | tr -s ' ' | paste -sd ';' - || echo 'size unavailable')"
    echo ""
  } >> "$summary"
  # Also print to the job log. GITHUB_STEP_SUMMARY is not in `gh run view --log`.
  echo "ccache-stats-start"
  if [ -n "${CCACHE_STATSLOG:-}" ] && [ -s "$CCACHE_STATSLOG" ]; then
    ccache --show-log-stats 2>&1 | head -40
  else
    echo "(no stats log written; no compiler invocation went through ccache)"
  fi
  ccache --show-stats 2>&1 | head -20 || true
  echo "ccache-stats-end"
fi

if [[ "${CACHE_SIZE_BYTES:-}" =~ ^[0-9]+$ ]]; then
  {
    echo "### Actions cache at job start"
    echo ""
    printf -- '- %s entries, %s GB in use (repo limit not exposed by the API; 10 GB unless changed in settings)\n' \
      "${CACHE_COUNT:-?}" "$(awk -v b="${CACHE_SIZE_BYTES}" 'BEGIN { printf "%.2f", b / 1073741824 }')"
    if [ -s "${tmp}/cache-entries.txt" ]; then
      echo ""
      echo '```'
      cat "${tmp}/cache-entries.txt"
      echo '```'
    fi
    echo ""
  } >> "$summary"
fi

if [ "${ATTEMPT1_OUTCOME:-}" = "failure" ]; then
  echo "::warning::First iOS build attempt failed after $(format_duration "${ATTEMPT1_SECONDS:-}"); clean-cache retry outcome: ${ATTEMPT2_OUTCOME:-not run} ($(format_duration "${ATTEMPT2_SECONDS:-}"))."
fi
