---
name: sync-miniapp
description: >-
  Prepare an external Mentra miniapp for bundling into mobile/assets/miniapps
  (version bump, pack, zip install, regenerate bundledMiniapps). Use when the
  user asks to sync a miniapp, bundle livestreamer/notes/etc into the Mentra
  App, or update mobile/assets/miniapps from an external miniapp repo. Never
  commits or pushes.
---

# Sync miniapp (prepare only — no git commits)

## Command

From the MentraOS repo root:

```bash
bun scripts/sync-miniapp.mjs <name> [--bump patch|minor|major] [--no-bump] [--dry-run]
# or
bun scripts/sync-miniapp.mjs --repo /path/to/external-miniapp [--bump patch] [--dry-run]
```

Named repos live in [scripts/miniapp-repos.json](../../../scripts/miniapp-repos.json).

## What it does

1. Reads `miniapp.json` (packageName + version are canonical).
2. Bumps strict `MAJOR.MINOR.PATCH` (rejects prerelease/build unless `--no-bump`).
3. Runs the external repo's `bun run pack` (or vendored `mentra-miniapp pack`).
4. Verifies the zip's embedded `miniapp.json`.
5. Copies into `mobile/assets/miniapps/`, prunes older same-package zips.
6. Regenerates `mobile/src/generated/bundledMiniapps.ts`.

## Critical: no commits

This skill **must not** run `git add`, `git commit`, or `git push` in either the external miniapp repo or MentraOS.

After a successful run, tell the user:

> No commits made. Remaining manual steps: commit+push in `<repoPath>`, then commit the MentraOS changes.

## Agent workflow

1. Prefer `--dry-run` first if the user wants a preview.
2. Run the script; do not reimplement pack/copy by hand.
3. Report old → new version and destination zip path.
4. Never commit unless the user explicitly asks in a separate request.
