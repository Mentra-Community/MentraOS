#!/usr/bin/env bash
# Runs one local Codex PR review under a watchdog so a stalled model response can
# never block the caller: no event from the child for STALL_SECONDS, or MAX_SECONDS
# in total, kills the attempt; one retry, then a clear failure.
#
# usage: codex-review.sh <repo-dir> <repo-name> <output-file> <prompt-file>
#
# Progress is read from the child's own `--json` event stream, written to
# <output-file's directory>/events-<attempt>.jsonl, so other Codex sessions on
# the machine (Codex Desktop, another review) cannot be mistaken for this one.
#
# When REVIEW_SLUG, REVIEW_PR, REVIEW_HEAD and REVIEW_STARTED_AT are set (the
# wrapper sets them), a review receipt on the PR counts as success even if the
# attempt then crashed, so a posted verdict is never retried into a duplicate.
set -uo pipefail
repo_dir="$1"; repo_name="$2"; output="$3"; prompt_file="$4"
STALL_SECONDS="${STALL_SECONDS:-480}"
MAX_SECONDS="${MAX_SECONDS:-1800}"
ATTEMPTS="${ATTEMPTS:-2}"
POLL_SECONDS="${POLL_SECONDS:-5}"
# GH_ACCOUNT=app (default): mint a mentra-release-coordinator App token so the verdict is not
# rejected as the PR author's own review. GH_ACCOUNT=own: leave GH_TOKEN unset so gh posts from
# the logged-in account (use for PRs the logged-in user did not author).
GH_ACCOUNT="${GH_ACCOUNT:-app}"
CODEX="${CODEX_BIN:-codex}"
MODEL="${CODEX_REVIEW_MODEL:-gpt-6-astra}"
EFFORT="${CODEX_REVIEW_EFFORT:-medium}"
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
out_dir=$(dirname "$output")

# shellcheck source=common.sh
source "$script_dir/common.sh"

# Prints the number of reviews this run has already posted, or 0 when the
# wrapper did not pass PR coordinates (standalone use).
posted_reviews() {
  if [[ -n "${REVIEW_SLUG:-}" && -n "${REVIEW_PR:-}" && -n "${REVIEW_HEAD:-}" && -n "${REVIEW_STARTED_AT:-}" ]]; then
    "$script_dir/review-receipt.sh" "$REVIEW_SLUG" "$REVIEW_PR" "$REVIEW_HEAD" "$REVIEW_STARTED_AT" 2>/dev/null || echo 0
  else
    echo 0
  fi
}

# With job control on, every background job runs in its own process group whose id is
# the job's pid, so the whole tree Codex spawned (shells, gh, node) can be terminated
# together. Nothing from a killed attempt may survive into the receipt check or the
# retry, or a late `gh pr review` could post a second verdict.
set -m
group_alive() { pgrep -g "$1" >/dev/null 2>&1; }
kill_attempt() {
  local pgid="$1" i
  [[ -n "$pgid" ]] || return 0
  kill -TERM -- "-$pgid" 2>/dev/null || true
  for i in $(seq 1 10); do group_alive "$pgid" || return 0; sleep 0.5; done
  kill -KILL -- "-$pgid" 2>/dev/null || true
  for i in $(seq 1 10); do group_alive "$pgid" || return 0; sleep 0.5; done
  echo "codex-review: warning: process group $pgid still has members after SIGKILL" >&2
  return 1
}
pid=""
on_signal() { echo "codex-review: cancelled; terminating attempt" >&2; kill_attempt "$pid"; exit 130; }
trap on_signal INT TERM HUP

for attempt in $(seq 1 "$ATTEMPTS"); do
  if [[ "$GH_ACCOUNT" == "own" ]]; then
    token_env=()
  else
    token_env=(GH_TOKEN="$(node "$script_dir/mentra-release-coordinator-token.mjs" "$repo_name")")
  fi
  rm -f "$output"  # success below requires output written by this attempt
  events="$out_dir/events-${attempt}.jsonl"
  : > "$events"
  env ${token_env[@]+"${token_env[@]}"} "$CODEX" exec -C "$repo_dir" -m "$MODEL" -c model_reasoning_effort="$EFFORT" \
    --dangerously-bypass-approvals-and-sandbox --json -o "$output" "$(cat "$prompt_file")" < /dev/null > "$events" 2>>"$out_dir/codex-stderr.log" &
  pid=$!
  started=$(date +%s)
  while kill -0 "$pid" 2>/dev/null; do
    sleep "${POLL_SECONDS:-5}"
    now=$(date +%s)
    if [[ -s "$events" ]]; then
      last=$(file_mtime "$events")
    else
      last=$started
    fi
    if (( now - last > STALL_SECONDS )); then
      echo "codex-review: attempt $attempt stalled for $((now - last))s (no event from the child); killing pid $pid" >&2
      kill_attempt "$pid"; break
    fi
    if (( now - started > MAX_SECONDS )); then
      echo "codex-review: attempt $attempt exceeded ${MAX_SECONDS}s; killing pid $pid" >&2
      kill_attempt "$pid"; break
    fi
  done
  wait "$pid" 2>/dev/null; status=$?
  # Codex may exit while a command it spawned is still running; drain the group first.
  kill_attempt "$pid"
  if [[ $status -eq 0 && -s "$output" ]]; then
    echo "codex-review: attempt $attempt finished"; tail -c 1500 "$output"; exit 0
  fi
  echo "codex-review: attempt $attempt did not finish (exit $status)" >&2
  # The attempt may have posted its verdict before dying. Never retry a posted review.
  if [[ "$(posted_reviews)" -ge 1 ]]; then
    echo "codex-review: attempt $attempt posted its review before exiting; treating as success" >&2
    [[ -s "$output" ]] || echo "(Codex exited $status after posting; see $events for the transcript)" > "$output"
    exit 0
  fi
done
echo "codex-review: FAILED after $ATTEMPTS attempts; review not posted" >&2
exit 1
