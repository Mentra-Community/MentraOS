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

# Prints the number of reviews this run has already posted, "unknown" when GitHub
# could not answer, or 0 when the wrapper did not pass PR coordinates (standalone use).
posted_reviews() {
  local count
  if [[ -n "${REVIEW_SLUG:-}" && -n "${REVIEW_PR:-}" && -n "${REVIEW_HEAD:-}" && -n "${REVIEW_STARTED_AT:-}" ]]; then
    if count=$("$script_dir/review-receipt.sh" "$REVIEW_SLUG" "$REVIEW_PR" "$REVIEW_HEAD" "$REVIEW_STARTED_AT" 2>/dev/null) \
       && [[ "$count" =~ ^[0-9]+$ ]]; then
      echo "$count"
    else
      echo unknown
    fi
  else
    echo 0
  fi
}

# Cleanup has to survive Codex exiting first. Codex runs tool commands in sessions
# of their own; when Codex dies before the watchdog acts they re-parent to init and
# can no longer be found by walking down from its pid. Two independent views are
# therefore combined: the descendant tree is snapshotted on every poll while the
# parent is alive, and every attempt is launched with a unique CODEX_REVIEW_ATTEMPT
# marker in its environment, which each descendant inherits and which can be found
# by scanning process environments after the fact (procfs on Linux, `ps -E` on
# macOS). The group and every pid found either way get SIGTERM, then SIGKILL, and
# each is verified dead. A survivor is a hard failure: the runner neither retries
# nor trusts a receipt, because a late `gh pr review` from it could still post.
set -m
descendants() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null); do
    echo "$child"
    descendants "$child"
  done
}
marked_processes() {  # pids whose environment carries this attempt's marker
  if [[ -d /proc/self ]]; then
    grep -lz "CODEX_REVIEW_ATTEMPT=$1" /proc/[0-9]*/environ 2>/dev/null | sed -E 's#/proc/([0-9]+)/environ#\1#'
  else
    ps -ax -o pid=,command= -E 2>/dev/null | awk -v m="CODEX_REVIEW_ATTEMPT=$1" 'index($0, m) { print $1 }'
  fi
}
alive() {
  local state
  state=$(ps -o stat= -p "$1" 2>/dev/null) && [[ -n "$state" && "$state" != Z* ]]
}
seen_pids=""
note_descendants() { seen_pids="$seen_pids $(descendants "$1") $(pgrep -g "$1" 2>/dev/null)"; }
survivors=""
kill_attempt() {
  local pgid="$1" marker="$2" i p pids
  [[ -n "$pgid" ]] || return 0
  note_descendants "$pgid"
  pids=$(printf '%s\n' $pgid $seen_pids $(marked_processes "$marker") | grep -v "^$$\$" | sort -u)
  kill -TERM -- "-$pgid" 2>/dev/null || true
  for p in $pids; do kill -TERM "$p" 2>/dev/null || true; done
  for i in $(seq 1 10); do
    survivors=""; for p in $pids; do alive "$p" && survivors="$survivors $p"; done
    [[ -n "$survivors" ]] || return 0
    sleep 0.5
  done
  kill -KILL -- "-$pgid" 2>/dev/null || true
  for p in $pids; do kill -KILL "$p" 2>/dev/null || true; done
  for i in $(seq 1 10); do
    survivors=""; for p in $pids; do alive "$p" && survivors="$survivors $p"; done
    [[ -n "$survivors" ]] || return 0
    sleep 0.5
  done
  echo "codex-review: processes of the attempt survived SIGKILL:${survivors}" >&2
  return 1
}
pid=""
marker=""
on_signal() { echo "codex-review: cancelled; terminating attempt" >&2; kill_attempt "$pid" "$marker"; exit 130; }
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
  marker="$$-${attempt}-$(date +%s)-$RANDOM"
  seen_pids=""
  env ${token_env[@]+"${token_env[@]}"} CODEX_REVIEW_ATTEMPT="$marker" "$CODEX" exec -C "$repo_dir" -m "$MODEL" -c model_reasoning_effort="$EFFORT" \
    --dangerously-bypass-approvals-and-sandbox --json -o "$output" "$(cat "$prompt_file")" < /dev/null > "$events" 2>>"$out_dir/codex-stderr.log" &
  pid=$!
  started=$(date +%s)
  while kill -0 "$pid" 2>/dev/null; do
    sleep "${POLL_SECONDS:-5}"
    note_descendants "$pid"
    now=$(date +%s)
    if [[ -s "$events" ]]; then
      last=$(file_mtime "$events")
    else
      last=$started
    fi
    if (( now - last > STALL_SECONDS )); then
      echo "codex-review: attempt $attempt stalled for $((now - last))s (no event from the child); killing pid $pid" >&2
      kill_attempt "$pid" "$marker"; break
    fi
    if (( now - started > MAX_SECONDS )); then
      echo "codex-review: attempt $attempt exceeded ${MAX_SECONDS}s; killing pid $pid" >&2
      kill_attempt "$pid" "$marker"; break
    fi
  done
  wait "$pid" 2>/dev/null; status=$?
  # Codex may exit while a command it spawned is still running; drain everything first.
  # Fail closed if that cannot be verified: a survivor could still post a late review.
  kill_attempt "$pid" "$marker" || { echo "codex-review: FAILED: cannot verify the attempt is fully terminated; not retrying" >&2; exit 1; }
  if [[ $status -eq 0 && -s "$output" ]]; then
    echo "codex-review: attempt $attempt finished"; tail -c 1500 "$output"; exit 0
  fi
  echo "codex-review: attempt $attempt did not finish (exit $status)" >&2
  # The attempt may have posted its verdict before dying. Never retry a posted review,
  # and never retry while it is unknown whether one was posted.
  posted=$(posted_reviews)
  if [[ "$posted" == unknown ]]; then
    echo "codex-review: FAILED: cannot tell whether attempt $attempt posted its review (GitHub lookup failed); not retrying" >&2
    exit 1
  fi
  if (( posted >= 1 )); then
    echo "codex-review: attempt $attempt posted its review before exiting; treating as success" >&2
    [[ -s "$output" ]] || echo "(Codex exited $status after posting; see $events for the transcript)" > "$output"
    exit 0
  fi
done
echo "codex-review: FAILED after $ATTEMPTS attempts; review not posted" >&2
exit 1
