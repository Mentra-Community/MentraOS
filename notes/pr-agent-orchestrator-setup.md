# PR Agent Orchestrator — Setup

Automated PR review (Bugbot + Opus 4.8) and fix (Opus 4.8) via [`.github/workflows/pr-agent-orchestrator.yml`](../.github/workflows/pr-agent-orchestrator.yml).

## Prerequisites

### 1. Cursor GitHub app

Install the [Cursor GitHub app](https://cursor.com/docs/integrations/github) on the org/repo with access to pull requests and checks.

### 2. Bugbot (manual trigger only)

1. Enable Bugbot for this repo in the [Bugbot dashboard](https://cursor.com/bugbot).
2. Set **Run only when mentioned** (`bugbot run` / `cursor review`) so the orchestrator controls when Bugbot runs (required for 2-of-3 rotation).
3. Do **not** enable Bugbot Autofix — the Opus 4.8 SDK fixer is the only auto-commit agent.

### 3. GitHub secrets

| Secret | Required | Purpose |
|--------|----------|---------|
| `CURSOR_API_KEY` | Yes | Opus 4.8 reviews + fixer ([Cursor SDK](https://cursor.com/docs/sdk/typescript)) |
| `PR_AGENT_GITHUB_TOKEN` | Optional | Fine-grained PAT with `contents:write` + `pull-requests:write` if `GITHUB_TOKEN` cannot push fixes |

Create a team service account key at [Cursor Dashboard → Integrations](https://cursor.com/dashboard/integrations).

### 4. Repo config

Edit [`.github/pr-agent.yml`](../.github/pr-agent.yml):

- `authors.mode` — start with `label_only` or `allowlist` for rollout
- `dryRun` — set `false` after Phase A testing
- `reviewModel` / `fixModel` — defaults: Opus 4.8 / Opus 4.8

## Rollout phases

1. **Phase A:** `dryRun: true` — logs which reviewers would run; no fixer push
2. **Phase B:** `dryRun: false`, reviews enabled; verify Bugbot polling
3. **Phase C:** fixer enabled; tune `maxFixRounds` after observing credit usage
4. **Phase D:** widen `authors.mode` to `all` when ready

## Human controls

| Control | Effect |
|---------|--------|
| Label `agent-review` | Opt-in when `authors.mode: label_only` |
| Label `agent-stop` | Disable orchestrator on PR |
| Label `agent-resume` | Re-enable after handoff |
| Comment `agent-resolve <id>` | Mark finding false positive |

Handoff applies label `ready-for-human-review`. **Humans always merge** — agents never auto-merge.

## Bugbot ingestion

Native Cursor Bugbot posts a GitHub review (`<!-- BUGBOT_REVIEW -->`) plus
inline comments. The orchestrator treats that as the bugbot-slot verdict —
it does **not** require `<!-- pr-agent-bugbot-verdict -->`. High / Critical /
Medium Severity comments are blocking and start the fixer; Low Severity is a
nit. Per-bot regex overrides live under `externalReviewers.blockingPatterns`
in [`.github/pr-agent.yml`](../.github/pr-agent.yml).

## Tooling pin

Orchestrator jobs run code from the PR **base** (`tool_ref`, defaulting to
`base_ref`), not the PR tip. That way a branch cut before an orchestrator
fix still gets the latest agent, and a fork cannot rewrite the reviewer.

- Plan / aggregate / wait-ci / recheck-handoff / finalize / review-bugbot
  check out `tool_ref` directly.
- Model reviewer jobs check out PR `head_sha` for the diff, then overlay
  `scripts/pr-agent` and `.github/pr-agent*` from `tool_ref`.
- The fixer checks out the PR branch and a sibling `.pr-agent-tool` tree
  (hidden via `.git/info/exclude`) so `git add -A` cannot commit tooling.

To self-test an orchestrator PR against its own code, dispatch the workflow
with `tool_ref` set to the PR head branch.

## Local development

```bash
cd scripts/pr-agent
bun install
export CURSOR_API_KEY=cursor_...
bun run cli -- help
```
