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
repo_dir="$1"; pr="$2"; extra_prompt="${3:-}"

# Every exit path prints exactly one terminal marker ("codex-pr-review: done" or
# "codex-pr-review: FAILED ..."), so a caller waiting on the log never hangs on a
# preflight error (gh not logged in, PR not found, fetch refused, ...).
lock=""
reported=""
fail() { reported=1; echo "codex-pr-review: FAILED: $*" >&2; exit 1; }
on_exit() {
  local status=$?
  [[ -n "$lock" ]] && rm -rf "$lock"
  if (( status != 0 )) && [[ -z "$reported" ]]; then
    echo "codex-pr-review: FAILED (exit $status before the review ran)" >&2
  fi
}
trap on_exit EXIT
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
lock="${wt}.lock"
if ! mkdir "$lock" 2>/dev/null; then
  other=$(cat "$lock/pid" 2>/dev/null || true)
  if [[ -n "$other" ]] && kill -0 "$other" 2>/dev/null; then
    lock=""  # not ours; leave it in place
    fail "another review of ${slug}#${pr} is running (pid ${other}); wait for it or remove ${wt}.lock"
  fi
  rm -rf "$lock"; mkdir "$lock" || { lock=""; fail "cannot create lock ${wt}.lock"; }
fi
echo $$ > "$lock/pid"
git -C "$repo_dir" fetch -q origin "$base" "pull/${pr}/head"
# The branch ref can be ahead of GitHub's pull ref right after a push; fetch it when it exists on origin.
git -C "$repo_dir" ls-remote --exit-code origin "refs/heads/${head_branch}" >/dev/null 2>&1 \
  && git -C "$repo_dir" fetch -q origin "refs/heads/${head_branch}"
if [[ -d "$wt" ]]; then
  # A reused tree may hold leftovers from a previous run (test artifacts, an aborted
  # checkout). Reset tracked files and drop untracked ones; ignored files such as
  # node_modules are kept so dependencies do not have to be reinstalled every run.
  git -C "$wt" reset -q --hard && git -C "$wt" clean -fdq
  git -C "$wt" checkout -q --detach "$head_sha"
else
  git -C "$repo_dir" worktree add -q --detach "$wt" "$head_sha"
fi
[[ "$(git -C "$wt" rev-parse HEAD)" == "$head_sha" ]] || fail "worktree $wt is not at ${head_sha:0:8}"
[[ -z "$(git -C "$wt" status --porcelain)" ]] || fail "worktree $wt is not clean after reset"

# Every PR also gets a "should this change exist at all" assessment.
need_step="
4b. Also evaluate whether the change is needed or desirable at all, independently of its quality:
   what problem it solves and whether that problem is real for this project, whether the
   repository already has or is moving toward a different solution (check AGENTS.md, notes/,
   agents/, docs and recent commits on the base branch), whether the added surface area,
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
6. Do NOT edit any files, do NOT commit, and do NOT push.
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
"$script_dir/codex-review.sh" "$wt" "$repo_name" "$out_dir/last-message.txt" "$prompt" \
  > "$out_dir/runner.log" 2>&1 || { tail -5 "$out_dir/runner.log" >&2; fail "runner did not finish (see $out_dir/runner.log)"; }
# Codex exiting cleanly is not the deliverable; a review from this run on this head is.
# Count reviews on head_sha carrying the standard marker and submitted after we started.
posted=$(gh api "repos/${slug}/pulls/${pr}/reviews" --paginate \
  --jq "[.[] | select(.commit_id == \"${head_sha}\" and (.body | contains(\"Reviewed by local Codex\")) and .submitted_at >= \"${started_at}\")] | length" \
  2>/dev/null | awk '{ n += $1 } END { print n + 0 }')
if [[ "${posted:-0}" -lt 1 ]]; then
  fail "Codex finished but no review from this run is on ${head_sha:0:8} (see $out_dir/last-message.txt)"
fi
reported=1
echo "codex-pr-review: done. Final message:"
cat "$out_dir/last-message.txt"
