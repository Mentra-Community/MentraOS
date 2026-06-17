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

## Local development

```bash
cd scripts/pr-agent
bun install
export CURSOR_API_KEY=cursor_...
bun run cli -- help
```
