# SDK CI/CD — Automated Publishing Pipeline Plan

**Issue:** 048
**Related:** [sdk-release-sop.md](./sdk-release-sop.md), [docs-update-spec.md](./docs-update-spec.md)
**Status:** Plan (not yet implemented)
**Date:** 2026-03-18

---

## Purpose

This document plans the CI/CD pipeline for automated `@mentra/sdk` publishing from the MentraOS monorepo. It replaces the current manual process where Isaiah publishes from arbitrary branches and nobody else knows what's live.

**Problems this solves:**

1. **Manual publishes from random branches.** The current `3.0.0-hono.8` was published from a feature branch. No record of what commit it corresponds to.
2. **No branch → npm tag mapping.** Developers install `@mentra/sdk` and have no idea if they're getting `dev`, `staging`, or `main` code.
3. **Team doesn't know what's published.** No CI trail, no GitHub release, no changelog — just a human running `npm publish` in a terminal.
4. **No safety net.** Nothing prevents publishing broken code to `latest`. No build verification, no test gate, no approval step.
5. **Experimental versions are ad-hoc.** The `hono` tag was a good idea but there's no process for creating, documenting, or cleaning up experiment tags.

---

## Current State

### What exists

| Component       | State                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------- |
| Build CI        | ✅ Exists — `cloud-sdk-build.yml` runs on PR + push to `main`/`dev`/`staging`. Builds SDK + types. |
| Test CI         | ⚠️ Partial — build verification only, no SDK-specific tests                                        |
| Publish CI      | ❌ Does not exist — manual `npm publish`                                                           |
| Changelogs      | ❌ None                                                                                            |
| GitHub Releases | ❌ None for SDK                                                                                    |
| npm dist-tags   | ⚠️ Ad-hoc — `latest` (old v2), `hono` (experimental v3)                                            |
| Version bumping | ❌ Manual edit of `package.json`                                                                   |

### Current SDK build workflow (`cloud-sdk-build.yml`)

```yaml
# Triggers on PR and push to main/dev/staging
# Only runs if cloud/packages/sdk/** changed
# Steps: checkout → setup bun → install → build SDK → build types
# Does NOT publish, does NOT create releases
```

This is a solid foundation. The publish pipeline builds on top of it.

---

## Target Architecture

```
Feature Branch           dev                  staging              main
     │                    │                      │                   │
     │   PR merge ──────► │                      │                   │
     │                    │                      │                   │
     │              ┌─────▼─────┐                │                   │
     │              │  CI Build  │                │                   │
     │              │  CI Test   │                │                   │
     │              │  Publish   │                │                   │
     │              │  @beta     │                │                   │
     │              └────────────┘                │                   │
     │                    │                      │                   │
     │                    │   Promote ──────────► │                   │
     │                    │                ┌──────▼──────┐           │
     │                    │                │  CI Build    │           │
     │                    │                │  CI Test     │           │
     │                    │                │  Publish     │           │
     │                    │                │  @rc         │           │
     │                    │                └─────────────┘           │
     │                    │                      │                   │
     │                    │                      │   Promote ──────► │
     │                    │                      │             ┌─────▼─────┐
     │                    │                      │             │  CI Build  │
     │                    │                      │             │  CI Test   │
     │                    │                      │             │  Publish   │
     │                    │                      │             │  @latest   │
     │                    │                      │             │  GH Release│
     │                    │                      │             └───────────┘
     │                    │                      │                   │
     ▼                    ▼                      ▼                   ▼
  (no publish)     3.0.0-beta.N           3.0.0-rc.N             3.0.0
```

### Branch → Tag Mapping

| Branch         | npm dist-tag | Version format   | Auto-publish?  | Approval needed?                       |
| -------------- | ------------ | ---------------- | -------------- | -------------------------------------- |
| `main`         | `latest`     | `3.0.0`          | Yes, on merge  | ✅ Requires manual approval step in CI |
| `staging`      | `rc`         | `3.0.0-rc.N`     | Yes, on merge  | No                                     |
| `dev`          | `beta`       | `3.0.0-beta.N`   | Yes, on merge  | No                                     |
| `feature/*`    | (none)       | —                | No             | —                                      |
| `experiment/*` | `{name}`     | `3.0.0-{name}.N` | Manual trigger | No                                     |

---

## Tooling Decision: Changesets vs Semantic-Release vs Manual

### Options evaluated

| Tool                                                                         | How it works                                                                                                                                | Pros                                                                                                     | Cons                                                                                                                      |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **[Changesets](https://github.com/changesets/changesets)**                   | Developers add "changeset" files in PRs describing their change. CI consumes changesets to bump versions, generate changelogs, and publish. | Monorepo-native. Human-written changelogs. Used by Radix, Chakra, Turborepo, Pnpm. Fine-grained control. | Requires discipline (add changeset to every PR). Extra file per PR.                                                       |
| **[semantic-release](https://github.com/semantic-release/semantic-release)** | Reads conventional commit messages (`feat:`, `fix:`, `BREAKING CHANGE:`). Auto-determines version bump. Publishes + creates GitHub release. | Fully automated — no manual version management. Used by Angular, Material UI.                            | Requires strict commit message format. Hard to override. Single-package focused (monorepo plugins exist but are complex). |
| **[release-please](https://github.com/googleapis/release-please)** (Google)  | Creates a "Release PR" that accumulates changes. Merging the Release PR triggers publish. Commit-message driven like semantic-release.      | GitHub-native (runs as a GitHub Action). Low maintenance.                                                | Less flexible than changesets. Commit message format required.                                                            |
| **Manual**                                                                   | Bump version in `package.json`, run `npm publish` in CI, tag the commit.                                                                    | Simple. No tooling dependencies. Full control.                                                           | Error-prone. No changelogs. No coordination between packages. No guardrails.                                              |

### Recommendation: **Changesets**

Reasons:

1. **Monorepo-first.** Changesets was designed for monorepos where multiple packages might be published from one repo. Our repo has `@mentra/sdk`, `@mentra/types`, `@mentra/display-utils`, `@mentra/utils` — they need coordinated publishes.

2. **Human-written changelogs.** For an SDK with external developers, auto-generated changelogs from commit messages are garbage. "fix: address issue #247" means nothing to a developer reading the changelog. Changesets let the author write a human-readable description: "Fixed a bug where `session.transcription.forLanguage()` would not receive events after reconnection."

3. **Works with Bun + GitHub Actions.** Changesets is runtime-agnostic — it's just file manipulation and npm commands. The `changesets/action` GitHub Action handles the publish step.

4. **Does not require conventional commits.** Developers write normal commit messages. The changeset file is the structured metadata, not the commit message.

5. **Supports prerelease channels.** Changesets has a `pre enter beta` / `pre enter rc` mode that handles prerelease version numbering automatically.

### How Changesets works (quick overview)

```
1. Developer makes a change to packages/sdk/
2. Developer runs `bunx changeset` — interactive prompt:
   - Which packages changed? → @mentra/sdk
   - Is this a major/minor/patch? → minor
   - Describe the change: "Added session.transcription.forLanguage() for language-specific subscriptions"
3. This creates a file: .changeset/funny-dogs-dance.md
   ---
   "@mentra/sdk": minor
   ---
   Added session.transcription.forLanguage() for language-specific subscriptions
4. Developer commits the changeset file with their PR
5. When PR merges to dev:
   - CI detects changeset files
   - CI bumps version: 3.1.0-beta.1
   - CI generates CHANGELOG.md entry
   - CI publishes to npm with --tag beta
   - CI deletes consumed changeset files
```

For the rare case where a developer forgets to add a changeset, a CI check on PRs can warn (not block — some PRs are docs-only or infra changes that don't need a changeset).

---

## Pipeline Design

### Workflow 1: `sdk-publish-beta.yml` — Auto-publish on dev merge

```yaml
name: 📦 Publish SDK (beta)

on:
  push:
    branches: [dev]
    paths:
      - "cloud/packages/sdk/**"
      - "cloud/packages/types/**"
      - "cloud/.changeset/**"

jobs:
  publish-beta:
    runs-on: blacksmith-4vcpu-ubuntu-2404
    permissions:
      contents: write # for changeset commits
      id-token: write # for npm provenance
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: oven-sh/setup-bun@v2

      - name: Install dependencies
        working-directory: cloud
        run: bun install

      - name: Build all packages (dependency order)
        working-directory: cloud
        run: bun run build

      - name: Run SDK tests
        working-directory: cloud/packages/sdk
        run: bun test || echo "No tests yet — add tests!"

      - name: Enter prerelease mode (beta)
        working-directory: cloud
        run: |
          bunx changeset pre enter beta || true
          bunx changeset version
          # Commit the version bump
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add -A
          git commit -m "chore: version packages (beta)" --no-verify || true

      - name: Publish to npm (beta tag)
        working-directory: cloud
        run: bunx changeset publish --tag beta
        env:
          NPM_TOKEN: ${{ secrets.NPM_AUTOMATION_TOKEN }}
          NODE_AUTH_TOKEN: ${{ secrets.NPM_AUTOMATION_TOKEN }}
```

### Workflow 2: `sdk-publish-rc.yml` — Auto-publish on staging merge

Same structure as beta, but:

- Triggers on `push` to `staging`
- Uses `bunx changeset pre enter rc`
- Publishes with `--tag rc`

### Workflow 3: `sdk-publish-latest.yml` — Publish on main merge (with approval)

```yaml
name: 📦 Publish SDK (latest)

on:
  push:
    branches: [main]
    paths:
      - "cloud/packages/sdk/**"
      - "cloud/packages/types/**"
      - "cloud/.changeset/**"

jobs:
  build-and-test:
    runs-on: blacksmith-4vcpu-ubuntu-2404
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - name: Install
        working-directory: cloud
        run: bun install
      - name: Build
        working-directory: cloud
        run: bun run build
      - name: Test
        working-directory: cloud/packages/sdk
        run: bun test || echo "No tests yet"

  publish:
    needs: build-and-test
    runs-on: blacksmith-4vcpu-ubuntu-2404
    environment: npm-production # ← GitHub environment with required reviewers
    permissions:
      contents: write
      id-token: write
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - uses: oven-sh/setup-bun@v2

      - name: Install + Build
        working-directory: cloud
        run: |
          bun install
          bun run build

      - name: Exit prerelease mode
        working-directory: cloud
        run: bunx changeset pre exit || true

      - name: Version packages
        working-directory: cloud
        run: |
          bunx changeset version
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add -A
          git commit -m "chore: version packages" --no-verify || true
          git push

      - name: Publish to npm (latest)
        working-directory: cloud
        run: bunx changeset publish
        env:
          NPM_TOKEN: ${{ secrets.NPM_AUTOMATION_TOKEN }}
          NODE_AUTH_TOKEN: ${{ secrets.NPM_AUTOMATION_TOKEN }}

      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          tag_name: "sdk-v${{ steps.version.outputs.version }}"
          generate_release_notes: true
```

The `npm-production` environment in GitHub has **required reviewers** — merging to `main` triggers the build, but the publish job waits for a human to click "Approve" in the GitHub Actions UI. This is the safety net against accidental publishes.

### Workflow 4: `sdk-changeset-check.yml` — PR check for changeset

```yaml
name: 📋 Changeset Check

on:
  pull_request:
    branches: [dev, staging, main]
    paths:
      - "cloud/packages/sdk/**"
      - "cloud/packages/types/**"

jobs:
  check:
    runs-on: blacksmith-4vcpu-ubuntu-2404
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Check for changeset
        run: |
          CHANGESETS=$(find cloud/.changeset -name '*.md' ! -name 'README.md' 2>/dev/null | wc -l)
          if [ "$CHANGESETS" -eq "0" ]; then
            echo "::warning::No changeset found. If this PR changes SDK behavior, run 'bunx changeset' and commit the file."
            echo "If this is a docs-only or infra change, you can ignore this warning."
          else
            echo "✅ Found $CHANGESETS changeset(s)"
          fi
        # Note: this is a WARNING, not a failure. Not every PR needs a changeset.
```

### Workflow 5: `sdk-publish-experimental.yml` — Manual trigger for experiments

```yaml
name: 🧪 Publish SDK (experimental)

on:
  workflow_dispatch:
    inputs:
      tag_name:
        description: "npm dist-tag name (e.g., 'hono', 'local-runtime')"
        required: true
        type: string
      branch:
        description: "Branch to publish from"
        required: true
        type: string

jobs:
  publish-experimental:
    runs-on: blacksmith-4vcpu-ubuntu-2404
    permissions:
      contents: write
      id-token: write
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ inputs.branch }}

      - uses: oven-sh/setup-bun@v2

      - name: Install + Build
        working-directory: cloud
        run: |
          bun install
          bun run build

      - name: Bump prerelease version
        working-directory: cloud/packages/sdk
        run: |
          # Get current version, bump with experiment preid
          npm version prerelease --preid=${{ inputs.tag_name }} --no-git-tag-version

      - name: Publish with experimental tag
        working-directory: cloud/packages/sdk
        run: npm publish --tag ${{ inputs.tag_name }}
        env:
          NPM_TOKEN: ${{ secrets.NPM_AUTOMATION_TOKEN }}
          NODE_AUTH_TOKEN: ${{ secrets.NPM_AUTOMATION_TOKEN }}

      - name: Output install instructions
        run: |
          VERSION=$(node -p "require('./cloud/packages/sdk/package.json').version")
          echo "## 🧪 Experimental version published" >> $GITHUB_STEP_SUMMARY
          echo "" >> $GITHUB_STEP_SUMMARY
          echo "**Version:** $VERSION" >> $GITHUB_STEP_SUMMARY
          echo "**Tag:** ${{ inputs.tag_name }}" >> $GITHUB_STEP_SUMMARY
          echo "**Branch:** ${{ inputs.branch }}" >> $GITHUB_STEP_SUMMARY
          echo "" >> $GITHUB_STEP_SUMMARY
          echo "Install with:" >> $GITHUB_STEP_SUMMARY
          echo "\`\`\`" >> $GITHUB_STEP_SUMMARY
          echo "npm install @mentra/sdk@${{ inputs.tag_name }}" >> $GITHUB_STEP_SUMMARY
          echo "\`\`\`" >> $GITHUB_STEP_SUMMARY
```

This is a GitHub Actions **manual dispatch** — anyone on the team can trigger it from the Actions tab, specifying the branch and tag name. The publish summary shows up in the Actions run page so the team can see what was published.

---

## Setup Steps

### 1. Create npm automation token

```bash
# Login to npm as the @mentra org owner
npm login

# Create an automation token (bypasses 2FA, suitable for CI)
npm token create --type=automation
# Copy the token
```

Add as a GitHub secret: `Settings → Secrets → Actions → NPM_AUTOMATION_TOKEN`

### 2. Create GitHub environment for production publishes

`Settings → Environments → New → "npm-production"`

- Required reviewers: Isaiah (+ one backup)
- Wait timer: 0 (or 5 minutes for a cooling-off period)
- Only allow `main` branch

### 3. Install changesets

```bash
cd cloud
bun add -D @changesets/cli @changesets/changelog-github
bunx changeset init
```

This creates `cloud/.changeset/config.json`:

```json
{
  "$schema": "https://unpkg.com/@changesets/config@3.0.0/schema.json",
  "changelog": ["@changesets/changelog-github", { "repo": "user/MentraOS" }],
  "commit": false,
  "fixed": [],
  "linked": [["@mentra/sdk", "@mentra/types"]],
  "access": "public",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "ignore": ["@mentra/cloud", "@mentra/cloud-client"]
}
```

Key config:

- `"linked": [["@mentra/sdk", "@mentra/types"]]` — these packages version together. If `@mentra/types` gets a bump, `@mentra/sdk` gets the same bump level.
- `"access": "public"` — publishes as public packages (not private).
- `"ignore"` — packages in the monorepo that should NOT be published to npm.
- `"changelog": "@changesets/changelog-github"` — generates changelog entries with GitHub PR links.

### 4. Add `.changeset/README.md`

```markdown
# Changesets

This directory is used by [changesets](https://github.com/changesets/changesets)
to track version bumps and changelogs for published packages.

## When to add a changeset

If your PR changes behavior in `@mentra/sdk` or `@mentra/types` (anything a
consumer of the package would notice), add a changeset:

    bunx changeset

Follow the prompts. Commit the generated file with your PR.

## When NOT to add a changeset

- Docs-only changes
- CI/infra changes
- Changes to unpublished packages (@mentra/cloud, websites, etc.)
- Test-only changes
```

### 5. Configure `.npmrc` for CI

Create `cloud/.npmrc`:

```
//registry.npmjs.org/:_authToken=${NPM_TOKEN}
```

This tells npm to use the `NPM_TOKEN` environment variable for authentication. The CI workflows set this from the GitHub secret.

### 6. Add `publishConfig` to SDK package.json

```json
{
  "publishConfig": {
    "access": "public",
    "registry": "https://registry.npmjs.org/"
  }
}
```

### 7. Wire up new `./session` export

The SDK v3 adds a second entrypoint. Update `package.json` exports:

```json
{
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./session": {
      "import": "./dist/session.js",
      "types": "./dist/session.d.ts"
    },
    "./display-utils": {
      "import": "./dist/display-utils.js",
      "types": "./dist/display-utils.d.ts"
    }
  }
}
```

And update the build script to include the new entrypoint:

```json
{
  "scripts": {
    "build:js": "bun build src/index.ts src/session.ts src/display-utils.ts --outdir dist --target node --format esm ..."
  }
}
```

---

## Multi-Package Publish Coordination

### The problem

The monorepo has multiple publishable packages:

```
@mentra/types          → foundational types
@mentra/display-utils  → text wrapping utilities
@mentra/utils          → shared utilities
@mentra/sdk            → the SDK (depends on @mentra/types, bundled)
```

If `@mentra/types` changes, `@mentra/sdk` needs to be rebuilt and republished with the new types bundled.

### How changesets handles this

Changesets' `linked` config ensures coordinated versioning:

```json
"linked": [["@mentra/sdk", "@mentra/types"]]
```

When a changeset bumps `@mentra/types`, changesets also bumps `@mentra/sdk` to the same level. The CI pipeline builds in dependency order and publishes all changed packages in one run.

If `@mentra/display-utils` changes independently (no SDK impact), it gets its own version bump without affecting `@mentra/sdk`.

### Build order in CI

```bash
# Always build in dependency order
bun run build:types        # @mentra/types first
bun run build:display-utils build:utils  # parallel, depend on types
bun run build:sdk          # last, depends on types
```

This already matches the existing `build` script in the root `package.json`:

```json
"build": "bun run build:types && bun run --parallel build:display-utils build:utils && bun run build:sdk"
```

---

## Handling the v3 Transition

### Current situation

- npm `latest` tag points to some old v2 version
- npm `hono` tag points to `3.0.0-hono.8` (the experimental Hono branch)
- The `hono` branch code is effectively what becomes v3
- We need to get from here to a clean CI-managed state

### Transition plan

```
Step 1: Merge the current sdk-v3 work to dev
  - This becomes the first beta: 3.0.0-beta.1
  - CI auto-publishes to npm as @mentra/sdk@beta

Step 2: Deprecate the hono tag
  npm dist-tag rm @mentra/sdk hono
  npm deprecate "@mentra/sdk@3.0.0-hono.*" "Use @mentra/sdk@beta instead"

Step 3: Iterate on dev (beta.2, beta.3, ...)
  - Each merge to dev auto-publishes a new beta
  - Internal testing against beta

Step 4: Promote dev → staging
  - CI publishes 3.0.0-rc.1
  - Full QA pass

Step 5: Promote staging → main
  - CI publishes 3.0.0 as latest (with approval gate)
  - GitHub Release created
  - Old v2 is no longer latest
  - Docs updated (see docs-update-spec.md)

Step 6: Clean up
  - Remove hono tag from npm
  - Delete experiment branch
  - Update version history log in SOP
```

### What about developers on `3.0.0-hono.8`?

Anyone who installed `npm install @mentra/sdk@hono` is on a pinned prerelease. They won't auto-update. When we deprecate the hono versions, they'll see a deprecation warning on `npm install` telling them to switch to `@beta` or `@latest`.

No action required from us beyond the deprecation message. Their code keeps working — we're not unpublishing anything.

---

## Monitoring & Alerts

### npm publish verification (add to every publish workflow)

```yaml
- name: Verify publish
  run: |
    sleep 10  # npm registry propagation delay
    EXPECTED=$(node -p "require('./cloud/packages/sdk/package.json').version")
    PUBLISHED=$(npm view @mentra/sdk@${{ env.TAG }} version 2>/dev/null || echo "NONE")
    if [ "$PUBLISHED" != "$EXPECTED" ]; then
      echo "::error::Publish verification failed! Expected $EXPECTED, got $PUBLISHED"
      exit 1
    fi
    echo "✅ Verified: @mentra/sdk@$PUBLISHED published to tag ${{ env.TAG }}"
```

### Package size check (add to build workflow)

```yaml
- name: Check package size
  working-directory: cloud/packages/sdk
  run: |
    SIZE=$(npm pack --dry-run 2>&1 | grep 'package size' | awk '{print $NF}')
    echo "📦 Package size: $SIZE"
    # Alert if over 2MB (current SDK is ~500KB)
    BYTES=$(npm pack --dry-run 2>&1 | grep 'unpacked size' | awk '{print $NF}' | numfmt --from=iec)
    if [ "$BYTES" -gt 2097152 ]; then
      echo "::warning::Package size ($SIZE) exceeds 2MB threshold. Check for accidentally bundled files."
    fi
```

### Slack/Discord notification (optional, add to publish workflows)

```yaml
- name: Notify team
  if: success()
  run: |
    VERSION=$(node -p "require('./cloud/packages/sdk/package.json').version")
    curl -X POST "${{ secrets.DISCORD_WEBHOOK_URL }}" \
      -H "Content-Type: application/json" \
      -d "{\"content\": \"📦 **@mentra/sdk@${VERSION}** published to npm (\`${{ env.TAG }}\` tag)\"}"
```

---

## Implementation Checklist

### Phase 1: Foundation (do first)

- [ ] Create npm automation token, add as GitHub secret
- [ ] Create `npm-production` GitHub environment with required reviewers
- [ ] Install `@changesets/cli` and `@changesets/changelog-github`
- [ ] Run `bunx changeset init`, configure `config.json`
- [ ] Add `.changeset/README.md` with team instructions
- [ ] Add `publishConfig` to `packages/sdk/package.json`
- [ ] Create `cloud/.npmrc` for CI auth

### Phase 2: Workflows (do second)

- [ ] Create `sdk-changeset-check.yml` (PR warning)
- [ ] Create `sdk-publish-beta.yml` (auto on dev merge)
- [ ] Create `sdk-publish-rc.yml` (auto on staging merge)
- [ ] Create `sdk-publish-latest.yml` (auto on main merge, with approval)
- [ ] Create `sdk-publish-experimental.yml` (manual dispatch)
- [ ] Add publish verification step to all publish workflows
- [ ] Add package size check to build workflow

### Phase 3: Transition (do when v3 is ready)

- [ ] Merge v3 to dev → first beta auto-publishes
- [ ] Deprecate `hono` npm tag
- [ ] Verify beta install works cleanly
- [ ] Promote to staging → RC auto-publishes
- [ ] Full QA on RC
- [ ] Promote to main → latest publishes (with approval)
- [ ] Create GitHub Release
- [ ] Update version history log

### Phase 4: Team Onboarding (do after pipeline is live)

- [ ] Write a 1-page guide: "How to add a changeset to your PR"
- [ ] Demo the pipeline in a team meeting
- [ ] Ensure at least one other person can trigger the manual experimental publish
- [ ] Ensure at least one other person is a reviewer on the `npm-production` environment
- [ ] Add `bunx changeset` to the PR template as a reminder

---

## Open Questions

| #   | Question                                                                  | Notes                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Should `@mentra/types` be independently published or always bundled?**  | Currently bundled in SDK via `bundledDependencies`. If it's always bundled, it doesn't need its own npm publish pipeline. But `@mentra/cloud` also depends on it — does it use the npm version or the workspace version? Probably workspace for cloud, bundled for SDK. No independent publish needed.                                                                     |
| 2   | **Should we use `bun publish` instead of `npm publish`?**                 | Bun has a `publish` command now. It supports npm registry. But changesets calls `npm publish` internally. Probably not worth customizing — `npm publish` works fine from a Bun-installed project.                                                                                                                                                                          |
| 3   | **Do we need provenance attestations?**                                   | npm supports [provenance](https://docs.npmjs.com/generating-provenance-statements) — cryptographic proof that a package was built by a specific CI workflow from a specific commit. Good security practice for public packages. Requires `permissions: id-token: write` in the workflow (already included above). Consider adding `--provenance` flag to publish commands. |
| 4   | **Should prerelease versions update `CHANGELOG.md`?**                     | Changesets can generate changelog entries for prereleases. These are noisy (many entries for incremental betas). Alternative: only generate changelog for stable releases, accumulate changeset descriptions until then. Leaning toward changelog on stable only.                                                                                                          |
| 5   | **What about the `@mentra/react-sdk` and `@mentra/client-sdk` packages?** | The monorepo has `packages/react-sdk` and `packages/client-sdk`. Are these published? Do they need the same pipeline? Need to check if they're actively used or dead code. If published, add to changesets config.                                                                                                                                                         |
| 6   | **Canary releases on every PR?**                                          | Some projects publish a canary version for every PR so reviewers can test the exact code. e.g., `@mentra/sdk@0.0.0-pr-247.1`. Useful but noisy. Probably overkill for our team size. Revisit if the team grows.                                                                                                                                                            |
| 7   | **Should we auto-close stale experimental tags?**                         | A scheduled workflow that checks npm dist-tags and warns/removes tags older than 30 days. Prevents tag accumulation. Low priority but good hygiene.                                                                                                                                                                                                                        |
| 8   | **What about the `prepare` script?**                                      | The SDK's `package.json` has `"prepare": "bun run build"` which runs on every `bun install`. This is fine for development but might cause issues in CI if the build fails during install. Consider removing `prepare` and relying on explicit build steps in CI.                                                                                                           |
