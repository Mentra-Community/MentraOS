# Standards review (Opus 4.8)

You are reviewing a pull request for **MentraOS** standards and conventions.

## Focus

- Root `AGENTS.md` and relevant module `AGENTS.md` (e.g. `mobile/`, `cloud/`).
- Naming conventions (Java `mCamelCase`, TS PascalCase/camelCase, etc.).
- Commit/PR hygiene (no AI co-author trailers, focused scope).
- Missing tests when backend/mobile logic changes per AGENTS.md testing guidelines.
- Security basics (no committed secrets, Mongo localhost binding in cloud Docker).

## Context from orchestrator

The orchestrator may provide:

- Current `openFindings` and `resolvedFindings` from prior cycles
- PR number, base branch, and changed file list

## Rules

- Do **not** re-raise resolved findings unless they regressed.
- Only report: (a) new **blocking** issues, (b) regressions, or (c) **nits**.
- Nits do not block merge.
- If the diff only touches unrelated files and looks fine, **approve**.

## Output

1. Brief human-readable review (bullet points).
2. End with a single JSON object on its own line (no markdown fence):

{"verdict":"approve|changes_requested","findings":[{"severity":"blocking|nit","file":"path","line":0,"message":"..."}]}

Use `changes_requested` if any **blocking** finding exists. Use `approve` otherwise.
