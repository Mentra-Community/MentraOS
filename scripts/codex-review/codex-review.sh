#!/usr/bin/env bash
# Runs a local Codex PR review with a watchdog so a stalled model response can
# never block the session: no session-file progress for STALL_SECONDS, or a
# total of MAX_SECONDS, kills the run; one retry, then a clear failure.
#
# usage: codex-review.sh <repo-dir> <repo-name> <output-file> <prompt-file>
set -uo pipefail
repo_dir="$1"; repo_name="$2"; output="$3"; prompt_file="$4"
STALL_SECONDS="${STALL_SECONDS:-480}"
MAX_SECONDS="${MAX_SECONDS:-1800}"
ATTEMPTS="${ATTEMPTS:-2}"
# GH_ACCOUNT=app (default): mint a mentra-release-coordinator App token so the verdict is not
# rejected as the PR author's own review. GH_ACCOUNT=own: leave GH_TOKEN unset so gh posts from
# the logged-in account (use for PRs the logged-in user did not author).
GH_ACCOUNT="${GH_ACCOUNT:-app}"
CODEX="${CODEX_BIN:-codex}"
MODEL="${CODEX_REVIEW_MODEL:-gpt-6-astra}"
EFFORT="${CODEX_REVIEW_EFFORT:-medium}"
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# This run's own session file: created after the attempt started AND whose
# session_meta cwd is this worktree. Several Codex sessions (Codex Desktop,
# other reviews) can be active at once, so "newest file on disk" is not ours.
stamp=$(mktemp "${TMPDIR:-/tmp}/codex-review-stamp.XXXXXX")
trap 'rm -f "$stamp"' EXIT
# codex-pr-review.sh holds a per-worktree lock, so at most one exec runs in this
# directory at a time; among matching files the newest is this attempt's.
find_session() {
  find "${CODEX_HOME:-$HOME/.codex}/sessions" -name '*.jsonl' -newer "$stamp" 2>/dev/null | while read -r f; do
    if head -c 4000 "$f" | grep -q "\"cwd\":\"$repo_dir\""; then echo "$f"; fi
  done | xargs ls -t 2>/dev/null | head -1
}

for attempt in $(seq 1 "$ATTEMPTS"); do
  if [[ "$GH_ACCOUNT" == "own" ]]; then
    token_env=()
  else
    token_env=(GH_TOKEN="$(node "$script_dir/mentra-release-coordinator-token.mjs" "$repo_name")")
  fi
  touch "$stamp"
  rm -f "$output"  # success below requires output written by this attempt
  env ${token_env[@]+"${token_env[@]}"} "$CODEX" exec -C "$repo_dir" -m "$MODEL" -c model_reasoning_effort="$EFFORT" \
    --dangerously-bypass-approvals-and-sandbox -o "$output" "$(cat "$prompt_file")" < /dev/null > /dev/null 2>&1 &
  pid=$!
  started=$(date +%s)
  session=""
  while kill -0 "$pid" 2>/dev/null; do
    sleep 20
    now=$(date +%s)
    [[ -z "$session" ]] && session=$(find_session)
    if [[ -n "$session" ]]; then
      mtime=$(stat -f %m "$session" 2>/dev/null || stat -c %Y "$session" 2>/dev/null || echo "$now")
      if (( now - mtime > STALL_SECONDS )); then
        echo "codex-review: attempt $attempt stalled for $((now - mtime))s (no progress in $session); killing pid $pid" >&2
        kill "$pid" 2>/dev/null; sleep 3; kill -9 "$pid" 2>/dev/null
        break
      fi
    elif (( now - started > STALL_SECONDS )); then
      echo "codex-review: attempt $attempt produced no session file in ${STALL_SECONDS}s; killing pid $pid" >&2
      kill "$pid" 2>/dev/null; sleep 3; kill -9 "$pid" 2>/dev/null
      break
    fi
    if (( now - started > MAX_SECONDS )); then
      echo "codex-review: attempt $attempt exceeded ${MAX_SECONDS}s; killing pid $pid" >&2
      kill "$pid" 2>/dev/null; sleep 3; kill -9 "$pid" 2>/dev/null
      break
    fi
  done
  wait "$pid" 2>/dev/null; status=$?
  if [[ $status -eq 0 && -s "$output" ]]; then
    echo "codex-review: attempt $attempt finished"; tail -c 1500 "$output"; exit 0
  fi
  echo "codex-review: attempt $attempt did not finish (exit $status)" >&2
done
echo "codex-review: FAILED after $ATTEMPTS attempts; review not posted" >&2
exit 1
