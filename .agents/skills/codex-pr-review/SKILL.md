---
name: codex-pr-review
description: >-
  Run an independent local Codex (gpt-6-astra, medium) review of a GitHub pull
  request and relay its verdict. Use for every PR an agent opens or updates,
  and whenever the user asks to review a PR "with Codex". The review is posted
  on the PR as approve / request-changes; it never edits, commits or merges.
---

# Local Codex PR review

One command does everything. Run it in the background and wait for it; do not
re-verify the Codex binary, the scripts, the token minter or the gh login first.
The script fails loudly if anything is missing.

```bash
nohup scripts/codex-review/codex-pr-review.sh <repo-dir> <pr-number> [extra-prompt-file] > <log> 2>&1 &
```

Then wait on the log (`until grep -q 'codex-pr-review: done\|FAILED' <log>; do sleep 15; done`)
and keep working. Every exit path prints exactly one of those markers, including preflight
failures. A run normally takes 5-20 minutes. The watchdog kills an attempt, with every
process it spawned, after 8 minutes without an event from the Codex process, or 30 minutes
total, and retries once unless the verdict was already posted. Never launch a bare
`codex exec` for a review.

## What the script does

- Fetches the PR head into the sibling worktree `<repo-dir>-pr-<n>`, so the main checkout is
  never touched. The tool marks worktrees it created with a `<repo-dir>-pr-<n>.codex-review-owned`
  sentinel; on reruns it resets and cleans only those (ignored files such as `node_modules`
  are kept) and refuses a path at that location it did not create. A per-PR lock refuses a
  second concurrent run; a lock whose owner is dead is reclaimed through a short-lived
  `<lock>.reclaim` mutex, so two reclaimers cannot clobber each other.
  A worktree created by an earlier version of the script has no sentinel: add the file by
  hand (any content) or remove the worktree with `git worktree remove`.
- Chooses the posting account. GitHub refuses a formal review from the PR author, so a PR
  authored by the logged-in gh user posts through a `mentra-release-coordinator` GitHub App
  token minted by `mentra-release-coordinator-token.mjs`; anyone else's PR posts from the
  logged-in account. Override with `GH_ACCOUNT=app|own`.
- Writes the standard prompt: read the diff against the base, read every existing comment
  (bots included) and judge each on its merits, favour low complexity and a coherent design over
  patchy fixes, no edits or pushes, and finish with `gh pr review <n> --approve` or
  `--request-changes` whose body starts with `Reviewed by local Codex (gpt-6-astra, medium).`
  and lists what was checked. If GitHub refuses the formal review it falls back to `--comment`
  with `Approve.` or `Request changes.` as the first line.
- Always adds an "Is this change needed?" step: Codex must judge whether the change is needed or
  desirable for the project at all (real problem, existing or planned alternative, surface area
  and maintenance cost versus benefit, smaller change possible) and let that weigh in the
  verdict, not only implementation quality.
- Runs `codex-review.sh` (watchdog + one retry) and prints Codex's final message. Success means
  a review carrying the marker was found on the head commit after the run started, checked
  through the GitHub API by `review-receipt.sh`; the runner performs the same check before any
  retry so a verdict posted just before a crash is never duplicated. Artifacts:
  `$CODEX_REVIEW_HOME/<repo>-pr-<n>-<timestamp>/{prompt.txt,last-message.txt,runner.log,events-<attempt>.jsonl}`
  (default `~/.codex-reviews`).

## Configuration

| Variable                                                      | Default                                                | Purpose                                                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `CODEX_BIN`                                                   | `codex`                                                | Codex CLI binary. Point it at a specific install if the shim on PATH does not support `exec`. |
| `CODEX_REVIEW_MODEL` / `CODEX_REVIEW_EFFORT`                  | `gpt-6-astra` / `medium`                               | Model and reasoning effort.                                                                   |
| `CODEX_HOME`                                                  | `~/.codex`                                             | Where Codex writes `sessions/`; the watchdog reads progress there.                            |
| `CODEX_REVIEW_HOME`                                           | `~/.codex-reviews`                                     | Where prompts, final messages and runner logs are kept.                                       |
| `MENTRA_RELEASE_COORDINATOR_KEY`                              | `~/.config/mentra-release-coordinator/private-key.pem` | App private key (0600) for posting on your own PRs.                                           |
| `GH_ACCOUNT`                                                  | auto                                                   | `app` or `own`, see above.                                                                    |
| `STALL_SECONDS` / `MAX_SECONDS` / `ATTEMPTS` / `POLL_SECONDS` | 480 / 1800 / 2 / 5                                     | Watchdog limits and poll interval.                                                            |
| `LOCK_STALE_SECONDS`                                          | 60                                                     | Age after which a lock directory without a pid file is reclaimed.                             |

The App must be installed on the target repository or the mint fails with HTTP 422 and the run
falls back to a comment review from the logged-in account.

## Tests

`bun test scripts/codex-review` runs the lifecycle suite with fake `gh` and `codex` binaries:
markers on every exit path, worktree ownership, lock behaviour, receipt-before-retry, and
stall handling. CI runs it on changes under `scripts/codex-review/`.

## Extra prompt file

Only when the review needs context Codex cannot get from the PR itself (a design decision made
in chat, a known-flaky test to ignore). Do not use it to steer the verdict on a specific
comment; let Codex weigh comments itself.

## After the run

- Relay the verdict and Codex's list to the user. Do not merge.
- If the PR is the agent's own and the verdict is request-changes: read the bot comments too,
  fix real defects with a coherent design change, say which comments were ignored and why, push,
  and rerun the script on the new head.
- If the PR belongs to someone else, report only; do not rework unless asked.
- On `codex-pr-review: FAILED`, read `runner.log`, report the failure, and do not claim a review
  was posted.
