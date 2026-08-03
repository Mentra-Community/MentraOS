---
name: ci-triage
description: >-
  Triage failing GitHub PR checks: list failures with gh, fetch capped Actions
  logs, skip non-Actions checks, and summarize root cause via the
  ci-investigator subagent. Use when the user pastes CI failures, asks why a PR
  is red, mentions failing checks, or says /ci.
---

# CI failure triage

## Never paste multi-thousand-line logs into chat

Summarize root causes. Cap every log fetch.

## Protocol

### 1. Resolve PR number

- Explicit arg from the user (e.g. `/ci 523` or "PR 3502"), **or**
- `gh pr view --json number -q .number` on the current branch.

### 2. List failing checks

```bash
gh pr checks <n> --json name,link,workflow,bucket,state
```

Filter to entries where `bucket == "fail"`.

**Field name is `workflow`, not `workflowName`.**

### 3. Classify each failure

For each failing check, test `link` against:

```
/\/actions\/runs\/(\d+)/
```

| Match | Meaning | Next step |
|---|---|---|
| Yes | GitHub Actions run | Extract `runId`, go to step 4 |
| No | External check (Cloudflare Pages, Vercel, Bugbot, etc.) | **Do not** call `gh run view`. Carry forward as name + link + state only |

### 4. Dedupe Actions runs

Multiple failing jobs can share one `runId`. Deduplicate by `runId` before fetching logs.

### 5. Fetch bounded logs (max 3 runs)

For each unique `runId`, **stop after the first 3 distinct runs**. Extra runs: list by check name only, with a note that more failures exist.

```bash
gh run view <runId> --log-failed | tail -c 20000
```

Always pipe through `tail -c 20000` (~20KB). Never feed the unbounded stream into context.

### 6. Root-cause via `ci-investigator` subagent

`ci-investigator` is a **built-in Task subagent type** (not a file under `~/.cursor/agents`). Invoke:

```
Task(
  subagent_type: "ci-investigator",
  description: "Investigate PR <n> check <name>",
  prompt: "<PR number, repo, run id, failing check name, and the capped log excerpt>"
)
```

Do **not** search the filesystem for a `ci-investigator` agent definition.

### 7. Reply format

One aggregated report:

1. **Actions root causes** — short summaries from ci-investigator (per run/check).
2. **Non-Actions failures** — name, state, link only (open in browser).
3. No raw log pastes.

If nothing failed, say so and stop.
