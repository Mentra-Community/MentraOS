#!/usr/bin/env bash
# One-shot local Codex review of a GitHub PR.
#
# usage: codex-pr-review.sh <repo-dir> <pr-number> [extra-prompt-file]
#
# - Fetches the PR head into a sibling worktree <repo-dir>-pr-<n> (reused if present).
# - Picks the posting account: the PR author's own gh account cannot approve/request-changes,
#   so PRs authored by the logged-in gh user post through the mentra-release-coordinator App
#   token (GH_ACCOUNT=app); anyone else's PR posts from the logged-in account (GH_ACCOUNT=own).
#   Override with GH_ACCOUNT=app|own in the environment.
# - Writes the standard review prompt (plus optional extra instructions) and runs
#   codex-review.sh, which adds the stall/total watchdog and one retry.
# - Prints Codex's final message; artifacts land in $CODEX_REVIEW_HOME (default ~/.codex-reviews).
set -euo pipefail
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=common.sh
source "$script_dir/common.sh"

# Every exit path prints exactly one terminal marker ("codex-pr-review: done" or
# "codex-pr-review: FAILED ..."), so a caller waiting on the log never hangs on a
# preflight error (gh not logged in, PR not found, fetch refused, ...).
lock=""
reported=""
fail() { reported=1; echo "codex-pr-review: FAILED: $*" >&2; exit 1; }
on_exit() {
  local status=$?
  [[ -n "${reclaim_held:-}" ]] && rmdir "${reclaim_path:-}" 2>/dev/null
  [[ -n "$lock" ]] && rm -rf "$lock"
  if (( status != 0 )) && [[ -z "$reported" ]]; then
    echo "codex-pr-review: FAILED (exit $status before the review ran)" >&2
  fi
}
trap on_exit EXIT
# Cancellation (Ctrl-C, SIGTERM, lost terminal) is forwarded to the runner, which
# terminates its Codex attempt and every process it spawned; the lock is released only
# after the runner has exited, so a second invocation can never reset a worktree that
# is still being reviewed.
runner_pid=""
on_signal() {
  reported=1
  echo "codex-pr-review: cancelled; stopping the review runner" >&2
  if [[ -n "$runner_pid" ]] && kill -0 "$runner_pid" 2>/dev/null; then
    kill -TERM "$runner_pid" 2>/dev/null || true
    wait "$runner_pid" 2>/dev/null || true
  fi
  echo "codex-pr-review: FAILED: cancelled" >&2
  exit 130
}
trap on_signal INT TERM HUP
repo_dir="${1:-}"; pr="${2:-}"; extra_prompt="${3:-}"
[[ -n "$repo_dir" && -n "$pr" ]] || fail "usage: codex-pr-review.sh <repo-dir> <pr-number> [extra-prompt-file]"
[[ "$pr" =~ ^[0-9]+$ ]] || fail "pr-number must be numeric, got '$pr'"
[[ -d "$repo_dir" ]] || fail "repo dir $repo_dir does not exist"
repo_dir="$(cd "$repo_dir" && pwd)"

origin_url=$(git -C "$repo_dir" remote get-url origin 2>/dev/null) || fail "$repo_dir has no git remote named origin"
slug=$(gh repo view "$origin_url" --json nameWithOwner -q .nameWithOwner) || fail "cannot resolve $origin_url on GitHub (is gh logged in?)"
repo_name=${slug##*/}
read -r author base head_branch state title < <(gh pr view "$pr" -R "$slug" --json author,baseRefName,headRefName,state,title \
  -q '"\(.author.login) \(.baseRefName) \(.headRefName) \(.state) \(.title)"')
if [[ "$state" != "OPEN" && "${ALLOW_CLOSED:-}" != "1" ]]; then
  fail "${slug}#${pr} is ${state}, not OPEN; refusing to review (set ALLOW_CLOSED=1 to override)"
fi
# GitHub's pull ref is the PR head by definition: it is fresher than gh's cached headRefOid right
# after a push, and unlike the branch ref it never includes commits pushed after a merge.
head_sha=$(git -C "$repo_dir" ls-remote origin "refs/pull/${pr}/head" | cut -f1)
# Right after a push the pull ref can lag the branch by a few seconds; when the PR branch lives
# on origin, wait (bounded) until they agree so the review targets the commit just pushed.
branch_sha=$(git -C "$repo_dir" ls-remote origin "refs/heads/${head_branch}" | cut -f1)
if [[ -n "$branch_sha" && "$branch_sha" != "$head_sha" ]]; then
  for _ in $(seq 1 12); do
    sleep 5
    head_sha=$(git -C "$repo_dir" ls-remote origin "refs/pull/${pr}/head" | cut -f1)
    [[ "$head_sha" == "$branch_sha" ]] && break
  done
  [[ "$head_sha" == "$branch_sha" ]] || echo "codex-pr-review: warning: pull ref ${head_sha:0:8} still differs from branch ${branch_sha:0:8}; reviewing the pull ref" >&2
fi
[[ -n "$head_sha" ]] || head_sha=$(gh pr view "$pr" -R "$slug" --json headRefOid -q .headRefOid)
me=$(gh api user -q .login)
if [[ -z "${GH_ACCOUNT:-}" ]]; then
  if [[ "$author" == "$me" ]]; then GH_ACCOUNT=app; else GH_ACCOUNT=own; fi
fi
export GH_ACCOUNT

wt="${repo_dir}-pr-${pr}"
# One review per PR worktree at a time: the runner identifies its Codex session by this
# directory, and two runs checking out into the same tree would corrupt each other.
# mkdir is atomic, so only one caller ever owns the lock directory. A lock is
# reclaimed only when its owner is provably dead: its pid file names a process that
# no longer exists, or the directory is older than LOCK_STALE_SECONDS with no pid file
# (the owner died between mkdir and writing the pid). Reclaims are serialised through
# a second directory, <lock>.reclaim, and the lock is inspected AGAIN while holding it:
# a caller that saw a dead pid, then lost the race to another reclaimer, now sees that
# reclaimer's live pid and backs off instead of renaming its fresh lock away. The
# mutex is held for milliseconds; it can only outlive a run that crashed inside that
# window, and then it has to be removed by hand. Anything unclear fails closed.
lock_path="${wt}.lock"
reclaim_path="${lock_path}.reclaim"
reclaim_held=""
LOCK_STALE_SECONDS="${LOCK_STALE_SECONDS:-60}"
release_reclaim() { [[ -n "$reclaim_held" ]] && rmdir "$reclaim_path" 2>/dev/null; reclaim_held=""; }
# Sets lock_verdict to "stale <why>" when the lock may be reclaimed, otherwise to the
# reason it must not be.
inspect_lock() {
  local other runner age
  if [[ ! -d "$lock_path" ]]; then
    # Another caller moved it away between our failed mkdir and this look.
    lock_verdict="lock ${lock_path} vanished while another caller was reclaiming it; retry shortly"
    return 0
  fi
  other=$(cat "$lock_path/pid" 2>/dev/null || true)
  runner=$(cat "$lock_path/runner-pid" 2>/dev/null || true)
  # A wrapper killed with SIGKILL cannot forward cancellation, so its runner may still
  # be reviewing in this worktree. The runner pid is recorded in the lock for exactly
  # that case: the lock stays live while either process is alive.
  if [[ -n "$runner" ]] && kill -0 "$runner" 2>/dev/null; then
    lock_verdict="another review of ${slug}#${pr} is running (runner pid ${runner}, wrapper pid ${other:-unknown}); wait for it or stop that runner"
  elif [[ -n "$other" ]]; then
    if kill -0 "$other" 2>/dev/null; then
      lock_verdict="another review of ${slug}#${pr} is running (pid ${other}); wait for it or remove ${lock_path}"
    else
      lock_verdict="stale lock left by dead pid ${other}"
    fi
  else
    age=$(( $(date +%s) - $(file_mtime "$lock_path") ))
    if (( age > LOCK_STALE_SECONDS )); then
      lock_verdict="stale ${age}s-old lock with no owner"
    else
      lock_verdict="another review of ${slug}#${pr} is starting (lock ${lock_path} is ${age}s old); retry shortly"
    fi
  fi
}
take_lock() {
  mkdir "$lock_path" 2>/dev/null && { lock="$lock_path"; echo $$ > "$lock/pid"; return 0; }
  inspect_lock
  [[ "$lock_verdict" == stale* ]] || fail "$lock_verdict"
  # Test hook: lets the lifecycle test replace the lock between the two inspections.
  [[ -z "${CODEX_REVIEW_HOOK_BEFORE_RECLAIM:-}" ]] || eval "$CODEX_REVIEW_HOOK_BEFORE_RECLAIM"
  mkdir "$reclaim_path" 2>/dev/null \
    || fail "another caller is reclaiming ${lock_path}; retry shortly (remove ${reclaim_path} by hand only if no review is running)"
  reclaim_held=1
  if mkdir "$lock_path" 2>/dev/null; then
    # The previous reclaimer finished and released; the path was free again.
    lock="$lock_path"; echo $$ > "$lock/pid"; release_reclaim; return 0
  fi
  inspect_lock
  [[ "$lock_verdict" == stale* ]] || { release_reclaim; fail "$lock_verdict"; }
  echo "codex-pr-review: reclaiming ${lock_verdict}" >&2
  local stale="${lock_path}.stale.$$"
  mv "$lock_path" "$stale" 2>/dev/null || { release_reclaim; fail "lock ${lock_path} changed while reclaiming; retry shortly"; }
  rm -rf "$stale"
  mkdir "$lock_path" 2>/dev/null || { release_reclaim; fail "lock ${lock_path} was taken by another caller; retry shortly"; }
  lock="$lock_path"; echo $$ > "$lock/pid"
  release_reclaim
}
take_lock
git -C "$repo_dir" fetch -q origin "$base" "pull/${pr}/head"
# The branch ref can be ahead of GitHub's pull ref right after a push; fetch it when it exists on origin.
git -C "$repo_dir" ls-remote --exit-code origin "refs/heads/${head_branch}" >/dev/null 2>&1 \
  && git -C "$repo_dir" fetch -q origin "refs/heads/${head_branch}"
# The sibling path is only ever reset if this tool created it: a sentinel beside the
# worktree records ownership. A directory at that path without the sentinel belongs to
# someone else and is never touched.
owned="${wt}.codex-review-owned"
if [[ -e "$wt" ]]; then
  [[ -f "$owned" ]] || fail "$wt exists but was not created by codex-pr-review; move it or pass a different repo dir"
  # Drop leftovers from a previous run (test artifacts, an aborted checkout). Ignored
  # files such as node_modules are kept so dependencies need not be reinstalled.
  git -C "$wt" reset -q --hard && git -C "$wt" clean -fdq
  # Submodules a previous run checked out are repositories of their own: the parent's
  # reset and clean never touch what is inside them, so each one is reset separately and
  # then moved to the commit the PR head records. Only submodules that exist inside THIS
  # worktree are touched: a submodule the main checkout happens to have initialised is
  # never cloned here, so a repeat review needs no extra network access. Nested
  # submodules are not descended into; if one is dirty its parent gitlink stays dirty
  # and the status check below fails closed.
  subs=$(populated_submodules "$wt")
  while IFS= read -r sub; do
    [[ -n "$sub" ]] || continue
    git -C "$wt/$sub" reset -q --hard && git -C "$wt/$sub" clean -fdq \
      || fail "cannot reset submodule $sub in $wt"
  done <<<"$subs"
  git -C "$wt" checkout -q --detach "$head_sha"
  while IFS= read -r sub; do
    [[ -n "$sub" && -e "$wt/$sub/.git" ]] || continue
    git -C "$wt" submodule update --quiet -- "$sub" \
      || fail "cannot restore submodule $sub in $wt to the commit recorded at ${head_sha:0:8}"
  done <<<"$subs"
else
  git -C "$repo_dir" worktree add -q --detach "$wt" "$head_sha"
  echo "created by codex-pr-review.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ); safe to delete together with $wt" > "$owned"
fi
[[ "$(git -C "$wt" rev-parse HEAD)" == "$head_sha" ]] || fail "worktree $wt is not at ${head_sha:0:8}"
# Right after the resets above, nothing a previous run left behind can remain, so what
# `git status` still reports is judged by kind. Untracked files mean the clean failed,
# and a submodule that still differs from the PR head holds source this run did not
# ask for: both are fatal. Ordinary tracked paths that still show as modified are a
# property of the checkout itself (case-colliding paths on a case-insensitive
# filesystem, line-ending or mode normalisation), not leftovers; they are reported
# and the review proceeds.
wt_status=$(git -C "$wt" status --porcelain=v2)
leftover=$(untracked_paths <<<"$wt_status")
[[ -z "$leftover" ]] || fail "worktree $wt still has untracked files after clean: $(head -3 <<<"$leftover" | tr '\n' ' ')"
gitlinks=$(dirty_gitlinks <<<"$wt_status")
[[ -z "$gitlinks" ]] || fail "submodule(s) in $wt still differ from the PR head after reset: $(tr '\n' ' ' <<<"$gitlinks")"
if [[ -n "$wt_status" ]]; then
  echo "codex-pr-review: note: $(grep -c . <<<"$wt_status") tracked path(s) show as modified right after a hard reset (intrinsic to this checkout, e.g. case-colliding paths); continuing" >&2
fi

# Every PR also gets a "should this change exist at all" assessment.
need_step="
4b. Also evaluate whether the change is needed or desirable at all, independently of its quality:
   what problem it solves and whether that problem is real for this project, whether the
   repository already has or is moving toward a different solution (check AGENTS.md, the private spec workflow it links, public
   docs and recent commits on the base branch), whether the added surface area,
   dependencies or maintenance burden are justified by the benefit, and whether a smaller change
   would do. State your conclusion explicitly in the review body under a heading \"Is this change
   needed?\" and let it weigh in the verdict: a clean implementation of an unneeded or undesirable
   change is still a request-changes."
out_dir="${CODEX_REVIEW_HOME:-$HOME/.codex-reviews}/${repo_name}-pr-${pr}-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$out_dir"
prompt="$out_dir/prompt.txt"
cat > "$prompt" <<PROMPT
You are reviewing GitHub pull request #${pr} in ${slug} ("${title}", author ${author}).
This checkout is the PR head (commit ${head_sha}); the base branch is origin/${base}.

Do the following, in order:

1. Read the PR description: \`gh pr view ${pr} -R ${slug} --json title,body\`.
2. Read the full diff against the base branch: \`git diff origin/${base}...HEAD\`. Read surrounding
   code wherever the diff alone is not enough to judge correctness. Follow the repository's
   AGENTS.md / CLAUDE.md conventions.
3. Read every existing comment on the PR, including bots (Codex connector, Cursor Bugbot, cubic,
   github-actions): \`gh api repos/${slug}/issues/${pr}/comments\`,
   \`gh api repos/${slug}/pulls/${pr}/comments\`, and \`gh pr view ${pr} -R ${slug} --json reviews\`.
   Judge each comment on its merits; do not accept a comment as correct just because it exists,
   and do not reject the PR merely because a comment is unresolved if the head already addresses it.
4. Review for correctness, reliability, and coherent high-level design. Favour low complexity and
   reliability and a coherent design over patchy fixes made only to satisfy review comments.
   Check backwards compatibility, thread-safety, error handling, and whether tests cover the new
   behaviour.${need_step}
5. You may run cheap local tests or compile checks in the touched packages if they help you decide,
   but do not spend more than a few minutes on builds.
6. Do NOT edit any files, do NOT commit, and do NOT push. Read private specs through
   authenticated access when available; report an access gap instead of inventing requirements.
   Never reproduce confidential spec or customer/business content in the public review.
   Explain public code findings and link the private document when needed.
7. Finish by posting your verdict on the PR itself using exactly one of:
   \`gh pr review ${pr} -R ${slug} --approve --body "<body>"\` or
   \`gh pr review ${pr} -R ${slug} --request-changes --body "<body>"\`.
   If GitHub refuses the formal review, post \`gh pr review ${pr} -R ${slug} --comment --body "<body>"\`
   whose first line is "Approve." or "Request changes." and say in your final message that you fell back.
   The body must start with "Reviewed by local Codex (gpt-6-astra, medium)." and then list: what
   you checked (files/areas, tests/builds run), each existing comment and whether you agree with it
   and why, any defects found with file:line references and a suggested coherent fix, the
   "Is this change needed?" conclusion, and the reason for the verdict. Keep it
   concise and factual.

Your final message must contain the verdict (Approve or Request changes) and the same list, plus the
command you used to post it and whether it succeeded.
PROMPT
if [[ -n "$extra_prompt" ]]; then
  { echo; echo "Additional instructions for this review:"; cat "$extra_prompt"; } >> "$prompt"
fi

echo "codex-pr-review: ${slug}#${pr} by ${author} (gh user ${me}) -> GH_ACCOUNT=${GH_ACCOUNT}; worktree ${wt}; output ${out_dir}"
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# The runner runs in the background so cancellation signals reach this script while
# it waits; its pid goes into the lock (see inspect_lock).
REVIEW_SLUG="$slug" REVIEW_PR="$pr" REVIEW_HEAD="$head_sha" REVIEW_STARTED_AT="$started_at" \
  "$script_dir/codex-review.sh" "$wt" "$repo_name" "$out_dir/last-message.txt" "$prompt" \
  > "$out_dir/runner.log" 2>&1 &
runner_pid=$!
echo "$runner_pid" > "$lock/runner-pid"
runner_status=0
wait "$runner_pid" || runner_status=$?
runner_pid=""
if (( runner_status != 0 )); then
  tail -5 "$out_dir/runner.log" >&2
  fail "runner did not finish (see $out_dir/runner.log)"
fi
# Codex exiting cleanly is not the deliverable; a review from this run on this head is.
# An unknown answer (API failure) is not zero: it fails the run, never passes it.
posted=$("$script_dir/review-receipt.sh" "$slug" "$pr" "$head_sha" "$started_at") \
  || fail "cannot verify whether the review was posted on ${head_sha:0:8}: GitHub review lookup failed (see $out_dir/last-message.txt)"
[[ "$posted" =~ ^[0-9]+$ ]] || fail "review lookup returned an unusable count '${posted}'"
if (( posted < 1 )); then
  fail "Codex finished but no review from this run is on ${head_sha:0:8} (see $out_dir/last-message.txt)"
fi
reported=1
echo "codex-pr-review: done. Final message:"
cat "$out_dir/last-message.txt"
