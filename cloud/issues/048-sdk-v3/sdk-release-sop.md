# SOP: SDK Version Releases & Breaking Changes

**Issue:** 048
**Related:** [docs-update-spec.md](./docs-update-spec.md), [sdk-cicd-plan.md](./sdk-cicd-plan.md)
**Status:** Draft SOP
**Date:** 2026-03-18

---

## Purpose

This document defines the standard operating procedure for releasing new versions of `@mentra/sdk`, with particular focus on how to handle breaking changes, major version bumps, and prerelease/experimental versions. It exists because:

1. Currently, releases happen manually from arbitrary branches with no process.
2. Nobody else on the team knows which code is actually published or under which tag.
3. The `3.0.0-hono.8` prerelease tag was published from a feature branch with no documentation of what it contains.
4. There is no established pattern for deprecation timelines, compat layers, or developer communication.

This SOP applies to `@mentra/sdk` specifically but the principles extend to any published package in the monorepo (`@mentra/types`, `@mentra/display-utils`, etc.).

---

## Version Numbering

We follow [Semantic Versioning 2.0.0](https://semver.org/):

```
MAJOR.MINOR.PATCH[-prerelease][+buildmetadata]

Examples:
  2.5.3           — stable release
  3.0.0           — major (breaking changes)
  3.0.0-beta.1    — prerelease on the beta channel
  3.0.0-hono.8    — prerelease on a named experiment channel (avoid going forward)
  3.0.1           — patch (bugfix, no breaking changes)
  3.1.0           — minor (new features, backward compatible)
```

### What constitutes a breaking change?

Any of the following require a **major** version bump:

- Removing or renaming a public class, method, property, or type
- Changing the signature of a public method (parameter types, return type)
- Changing the behavior of a public method in a way that breaks existing callers
- Removing a public export from `package.json` `exports`
- Dropping support for a Node.js / Bun version that was previously supported
- Changing the wire protocol in a non-additive way (removing fields, changing message types)

The following are **NOT** breaking (minor or patch):

- Adding new classes, methods, properties, or types
- Adding optional parameters to existing methods
- Adding new exports to `package.json`
- Adding new fields to wire protocol messages (additive)
- Deprecating something (with warning) without removing it
- Bug fixes that change behavior to match documented intent
- Internal refactors that don't change public API

### Compat layers turn major changes into minor changes

If a breaking change is accompanied by a compatibility shim that preserves the old API (with deprecation warnings), the release can be a **minor** version — as long as:

1. The old API still works (no runtime errors)
2. The deprecation warning clearly explains the new API
3. The compat layer has a documented removal timeline
4. Removal of the compat layer is a separate major version

**Example:** SDK v3.0 renames `AppServer` → `MiniAppServer` but ships an `AppServer` compat shim. The compat shim means existing code doesn't break on update. The removal of the compat shim in v3.1 is a separate breaking change (but since we already did the major bump to 3.0, it's a minor — the major bump "bought" us the right to remove deprecated APIs in the 3.x line).

---

## Release Channels (npm dist-tags)

npm supports multiple "channels" via dist-tags. When a developer runs `npm install @mentra/sdk`, they get the `latest` tag by default. Other tags require explicit opt-in: `npm install @mentra/sdk@beta`.

### Standard channels

| Tag      | Branch    | Purpose                   | Who uses it                           | Stability                           |
| -------- | --------- | ------------------------- | ------------------------------------- | ----------------------------------- |
| `latest` | `main`    | Stable production release | All developers, production apps       | Must not break anything             |
| `beta`   | `dev`     | Pre-release testing       | Internal team, adventurous developers | May have rough edges, API is ~final |
| `rc`     | `staging` | Release candidate         | QA, staging environments              | API frozen, only bugfixes           |

### Experimental channels (on-demand, not always active)

| Tag                 | Branch                    | Purpose                                          | Lifecycle                                                           |
| ------------------- | ------------------------- | ------------------------------------------------ | ------------------------------------------------------------------- |
| `next`              | `dev` or dedicated branch | Next major version development                   | Active during major version development, merged to `dev` when ready |
| `{experiment-name}` | `feature/{name}`          | Named experiment (e.g., `hono`, `local-runtime`) | Created for specific spikes, deleted when experiment concludes      |

### Rules

1. **`latest` is sacred.** It must always point to tested, stable, production-ready code from `main`. Never publish `latest` from a feature branch. Never publish `latest` without the full test suite passing.

2. **`beta` auto-publishes from `dev`.** Every merge to `dev` that changes `packages/sdk/` triggers a beta publish. Developers opt in with `npm install @mentra/sdk@beta`.

3. **`rc` auto-publishes from `staging`.** When `dev` is promoted to `staging`, an RC is published. This is the "final test" before production.

4. **Experimental tags are short-lived.** Create them for specific experiments, document them, delete the tag when the experiment merges or is abandoned. Don't let experimental tags linger — they confuse developers.

5. **Version numbers always increase.** Even within a prerelease channel: `3.0.0-beta.1`, `3.0.0-beta.2`, `3.0.0-beta.3`, never `3.0.0-beta.1` again.

---

## The Release Lifecycle

### Patch release (bugfix)

```
1. Fix the bug on a branch off dev
2. PR → dev (CI runs, beta auto-publishes: 3.0.1-beta.1)
3. Test on beta
4. dev → staging (CI publishes: 3.0.1-rc.1)
5. Verify on staging
6. staging → main (CI publishes: 3.0.1 as latest)
```

Timeline: hours to days.

### Minor release (new feature, backward compatible)

```
1. Build the feature on a branch off dev
2. PR → dev (CI publishes beta)
3. Write/update docs
4. Test on beta, iterate
5. dev → staging (CI publishes RC)
6. Final QA on staging
7. staging → main (CI publishes latest)
8. Announce: changelog, blog post, Discord
```

Timeline: days to weeks.

### Major release (breaking changes)

This is the full process. Do not skip steps.

```
Phase 1: Design & Spike
  1. Write spike documents (API design, compat strategy, migration path)
  2. Review with team
  3. Decide: compat layer yes/no, deprecation timeline

Phase 2: Implementation
  4. Implement on feature branch off dev
  5. Build compat layer (if applicable)
  6. Write migration guide draft
  7. PR → dev (CI publishes beta: 3.0.0-beta.1)

Phase 3: Beta Period
  8. Internal testing on beta
  9. Share beta with trusted external developers (if any)
  10. Iterate on feedback (beta.2, beta.3, ...)
  11. Finalize migration guide
  12. Update README, examples

Phase 4: Release Candidate
  13. dev → staging (CI publishes: 3.0.0-rc.1)
  14. Full QA pass on staging
  15. Verify compat layer: install RC in a v2 app, confirm no breakage
  16. Verify migration guide: follow it step by step on a real app
  17. Fix any issues (rc.2 if needed)

Phase 5: Ship
  18. staging → main (CI publishes: 3.0.0 as latest)
  19. Archive v2 docs, publish v3 docs
  20. Set up redirects for renamed doc pages
  21. Announce: changelog, migration guide link, deprecation timeline
  22. Monitor: npm download stats, GitHub issues, Discord questions

Phase 6: Compat Removal (separate release)
  23. After deprecation period (minimum 8 weeks):
  24. Remove compat layer on branch off dev
  25. Follow the normal minor release process (3.1.0)
  26. Announce compat removal with 2-week advance warning
```

---

## Deprecation Policy

### Timeline

| Deprecated in | Removed in | Minimum gap     | Communication                                     |
| ------------- | ---------- | --------------- | ------------------------------------------------- |
| 3.0.0         | 3.1.0      | 8 weeks minimum | Console warnings + migration guide + announcement |

The 8-week minimum gives developers time to:

- Discover the deprecation (via console warnings)
- Read the migration guide
- Plan and execute the migration
- Test the updated code

### Deprecation warning format

Every deprecation warning follows this format:

```
⚠️  DEPRECATION: {old API} is deprecated. Use {new API} instead.
   Migration: https://docs.mentra.glass/sdk/migration#{section}
   Removal: v{next_version} (estimated {month} {year})
```

Example:

```
⚠️  DEPRECATION: session.layouts is deprecated. Use session.display instead.
   Migration: https://docs.mentra.glass/sdk/migration#step-3
   Removal: v3.1.0 (estimated May 2026)
```

### Deprecation warnings fire once per session

Use the `warnOnce(key, message)` utility (see `src/utils/error-utils.ts`). First access per session emits the warning. Subsequent accesses are silent. This prevents console spam while ensuring the developer sees the message.

### What gets a deprecation period vs immediate removal

| Change                                        | Treatment                                        |
| --------------------------------------------- | ------------------------------------------------ |
| Renamed class/method (same behavior)          | Compat shim + deprecation warning                |
| Removed feature (no replacement)              | Deprecation warning for one version, then remove |
| Internal-only code (`_prefixed`, not in docs) | Remove immediately, no deprecation               |
| Dead code (never worked, no callers)          | Remove immediately                               |
| Security fix that changes behavior            | Remove immediately with advisory                 |

---

## Communication Checklist

For every release (not just majors):

### Patch / Minor

- [ ] Changelog entry in GitHub release
- [ ] Update `CHANGELOG.md` in the SDK package
- [ ] Discord message in #sdk-updates (if it exists)

### Major

All of the above, plus:

- [ ] Migration guide published at `docs.mentra.glass/sdk/migration`
- [ ] Blog post / announcement with examples of before/after
- [ ] Email to registered developers (if we have a mailing list)
- [ ] Deprecation timeline clearly stated
- [ ] Update all example apps / starter templates
- [ ] Notify the mobile team (local runtime depends on SDK types)
- [ ] Update internal apps (captions, dashboard) — either migrate or verify compat
- [ ] Archive old docs to `/sdk/v2/`

### Experimental / Prerelease

- [ ] Document in the repo what the experiment is and which tag/branch it's on
- [ ] Add a `README-EXPERIMENTAL.md` or a section in the issue folder
- [ ] Tell the team in Slack/Discord: "There's a new experimental version, here's what it is, here's how to try it"
- [ ] Set a review date — experiments that linger for >4 weeks without activity should be closed or merged

---

## Who Can Publish

### Current state (problem)

Anyone with npm credentials can publish from any branch at any time. In practice, only Isaiah publishes, manually, from whatever branch has the latest code. Nobody else knows the process.

### Target state

| Action                   | Who                              | How                                                     |
| ------------------------ | -------------------------------- | ------------------------------------------------------- |
| Publish `beta`           | CI (automated)                   | Merge to `dev` triggers publish                         |
| Publish `rc`             | CI (automated)                   | Merge to `staging` triggers publish                     |
| Publish `latest`         | CI (automated) + manual approval | Merge to `main` triggers publish, requires one approval |
| Publish experimental tag | Any engineer                     | Manual, documented process (see below)                  |
| Emergency hotfix publish | Isaiah or designated backup      | Manual, from `main` after cherry-pick                   |

### Publishing an experimental tag manually

```bash
# 1. Make sure you're on the experiment branch
git checkout feature/my-experiment

# 2. Build and test
cd cloud/packages/sdk
bun run build
bun run test  # if tests exist

# 3. Bump the prerelease version
npm version prerelease --preid=my-experiment
# This changes package.json to e.g. 3.0.0-my-experiment.1

# 4. Publish under the experiment tag (NOT latest!)
npm publish --tag my-experiment
# ⚠️ NEVER use --tag latest from a feature branch

# 5. Document what you published
# Add a note to the experiment's issue/spike with:
#   - Version: 3.0.0-my-experiment.1
#   - Branch: feature/my-experiment
#   - What it contains
#   - How to install: npm install @mentra/sdk@my-experiment

# 6. Tell the team
# Post in Slack/Discord with install instructions
```

---

## Rollback Procedure

### "I published a bad version to latest"

```bash
# 1. DON'T npm unpublish — it breaks installs for anyone who already downloaded it.

# 2. Identify the last good version
npm view @mentra/sdk versions --json | tail -20

# 3. Point 'latest' back to the last good version
npm dist-tag add @mentra/sdk@2.5.3 latest
# This makes 'npm install @mentra/sdk' download 2.5.3 again

# 4. Deprecate the bad version (shows a warning on install)
npm deprecate @mentra/sdk@3.0.0 "This version has a critical bug. Use 2.5.3 instead."

# 5. Fix the bug, publish a new patch version
# Follow the normal release process

# 6. Post-mortem: why did the bad version get published?
# Was CI not running? Was a test missing? Fix the process.
```

### "I published to the wrong tag"

```bash
# Remove the tag from the wrong version
npm dist-tag rm @mentra/sdk my-tag

# Add the tag to the correct version
npm dist-tag add @mentra/sdk@3.0.0-beta.5 beta
```

---

## Monorepo Considerations

### Inter-package dependencies

The monorepo has packages that depend on each other:

```
@mentra/types         ← foundational, no deps on other @mentra packages
@mentra/display-utils ← depends on @mentra/types
@mentra/utils         ← depends on @mentra/types
@mentra/sdk           ← depends on @mentra/types (bundled)
```

When publishing, build order matters:

```
1. @mentra/types       (if changed)
2. @mentra/display-utils, @mentra/utils  (parallel, if changed)
3. @mentra/sdk         (last, depends on the above)
```

### Version coordination

If a change in `@mentra/types` breaks `@mentra/sdk`, both need to be published together. The CI pipeline should:

1. Detect which packages changed
2. Build them in dependency order
3. Publish all changed packages in the same CI run
4. Use matching prerelease suffixes (e.g., `types@1.1.0-beta.1` + `sdk@3.0.0-beta.1`)

### `workspace:*` protocol

The root `package.json` uses `"@mentra/sdk": "workspace:*"` for local development. The SDK's `package.json` uses `"@mentra/types": "^1.0.0-beta.1"` with `bundledDependencies` for publishing. This means the published SDK bundles its own copy of `@mentra/types` — consumers don't need to install it separately.

When bumping `@mentra/types`, also bump the version range in `@mentra/sdk`'s `dependencies` and rebuild the bundle.

---

## Post-Release Monitoring

After every `latest` publish:

1. **Verify the publish:**

   ```bash
   npm view @mentra/sdk version          # should show new version
   npm view @mentra/sdk dist-tags        # latest should point to new version
   ```

2. **Test a clean install:**

   ```bash
   mkdir /tmp/test-sdk && cd /tmp/test-sdk
   npm init -y
   npm install @mentra/sdk
   # Verify it installs, version is correct, basic import works
   ```

3. **Check for install warnings:**
   - Peer dependency warnings?
   - Deprecation notices from subdependencies?
   - Bundle size regression? (check with `npm pack --dry-run`)

4. **Monitor for issues (first 48 hours):**
   - GitHub issues tagged `sdk`
   - Discord #support channel
   - npm download count (sudden drop = something is wrong)
   - BetterStack logs for increased SDK error rates

---

## Version History Log

Keep a running log of every published version, what branch it came from, and what it contains. This is the "what is actually published" reference that the team is currently missing.

| Version                     | Tag               | Branch             | Date       | What changed                       | Published by  |
| --------------------------- | ----------------- | ------------------ | ---------- | ---------------------------------- | ------------- |
| `2.5.3`                     | latest (previous) | main               | 2026-02-xx | Last stable v2                     | Isaiah        |
| `3.0.0-hono.1` through `.8` | hono              | sdk-hono (feature) | 2026-01-xx | Hono migration experiment          | Isaiah        |
| `3.0.0-beta.1`              | beta              | dev                | TBD        | First v3 beta (Phase 1 foundation) | CI            |
| `3.0.0-beta.N`              | beta              | dev                | TBD        | Iterative v3 development           | CI            |
| `3.0.0-rc.1`                | rc                | staging            | TBD        | Release candidate                  | CI            |
| `3.0.0`                     | latest            | main               | TBD        | SDK v3 stable                      | CI (approved) |
| `3.1.0`                     | latest            | main               | TBD        | Compat layer removal               | CI (approved) |

**Update this table with every publish.** If it's not in this table, nobody knows it exists.

---

## Open Questions

| #   | Question                                                  | Notes                                                                                                                                                                                            |
| --- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Where does this version log live long-term?**           | In the issue folder it gets buried. Should it be in `packages/sdk/RELEASES.md` or in the dev console?                                                                                            |
| 2   | **Should we add `engines` to package.json?**              | e.g., `"engines": { "node": ">=18", "bun": ">=1.0" }` — signals supported runtimes.                                                                                                              |
| 3   | **Should we publish ESM + CJS or ESM only?**              | Currently ESM only (`"format": "esm"`). Some older projects need CJS. But dual publishing adds complexity.                                                                                       |
| 4   | **npm 2FA for publishes?**                                | npm supports requiring 2FA for all publishes. Good security but blocks CI. Solution: use npm automation tokens (bypass 2FA for CI, require 2FA for manual).                                      |
| 5   | **Should prerelease versions be installable by default?** | Currently, `npm install @mentra/sdk` skips prereleases. This is correct behavior. But should the dev console's "install SDK" instructions point to beta during active development?               |
| 6   | **Changelogs — manual or auto-generated?**                | Tools like `changesets` auto-generate changelogs from PR descriptions. Manual changelogs are more curated. Recommendation: use changesets for the mechanical part, hand-edit for major releases. |
| 7   | **Should we notify developers programmatically?**         | If we have developer emails from the dev console, we could email on major releases. Privacy and spam concerns — probably opt-in only.                                                            |
