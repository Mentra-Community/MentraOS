# 044 — CI / CD Build Audit

> **Status**: Spike
> **Date**: 2025-07-18
> **Branch**: `cloud/044-ci-build-audit`
> **Related**: [040-cloud-v3-cleanup/maintainability.md](../040-cloud-v3-cleanup/maintainability.md)

## Summary

An audit of the CI workflows and Docker build files revealed multiple issues: defeated Docker layer caching, wrong build order, stale cache keys referencing a file that doesn't exist, missing packages in build chains, dead LiveKit builds on every deploy, and no concurrency controls on the test workflow. This doc catalogs every issue found and specifies the fix for each.

---

## Package Dependency Graph

Before understanding what's wrong, here's what the build order **should** be:

```
Level 0 (no workspace deps):   @mentra/types, @mentra/display-utils
Level 1 (needs Level 0):       @mentra/sdk  (depends on types + display-utils)
Level 2 (needs Level 1):       @mentra/utils (depends on sdk)
Level 3 (needs Level 2):       @mentra/cloud (depends on sdk, utils, types)
```

**Correct sequential order**: `types` + `display-utils` → `sdk` → `utils` → `cloud`

`types` and `display-utils` have no workspace dependencies and can build in parallel.

---

## Issues Found

### 1. Docker layer caching is completely defeated

**Severity**: 🔴 High — adds 20–40s to every deploy

**Where**: `Dockerfile.porter`, `Dockerfile.stress`, `Dockerfile.livekit`

**Problem**: All three Dockerfiles copy the entire source tree before running `bun install`:

```dockerfile
COPY . .
RUN bun install && ...
```

Docker layer caching works bottom-up — if a layer changes, every layer after it is invalidated. `COPY . .` changes on every source code edit, so `bun install` re-runs from scratch on every build even when dependencies haven't changed.

**Fix**: Split `COPY` into two stages — dependency files first, then source:

```dockerfile
# Stage 1: Copy dependency manifests only
COPY package.json bun.lock ./
COPY packages/types/package.json ./packages/types/
COPY packages/display-utils/package.json ./packages/display-utils/
COPY packages/sdk/package.json ./packages/sdk/
COPY packages/utils/package.json ./packages/utils/
COPY packages/cloud/package.json ./packages/cloud/

# Stage 2: Install (cached unless manifests changed)
RUN bun install

# Stage 3: Copy source (this layer changes often, but install is cached)
COPY . .

# Stage 4: Build
RUN ...
```

`Dockerfile.dev` already does this correctly.

---

### 2. CI cache keys reference `bun.lockb` — file doesn't exist

**Severity**: 🔴 High — cache never hits, 10–20s wasted per CI run

**Where**: `.github/workflows/cloud-tests.yml`, `.github/workflows/augmentos_cloud_pr_dev_main.yml`

**Problem**: Both workflows use `hashFiles('cloud/bun.lockb')` for the cache key. The project uses `bun.lock` (text format), not `bun.lockb` (old binary format). `hashFiles` returns empty string for a non-existent file → cache key is always the same empty-hash fallback → but restore-key mismatches cause fresh installs.

```yaml
# BROKEN — file doesn't exist
key: ${{ runner.os }}-bun-${{ hashFiles('cloud/bun.lockb') }}
```

**Fix**: Change to `cloud/bun.lock`:

```yaml
key: ${{ runner.os }}-bun-${{ hashFiles('cloud/bun.lock') }}
```

---

### 3. `cloud-build.yml` builds packages in wrong order

**Severity**: 🔴 High — latent build failure

**Where**: `.github/workflows/cloud-build.yml`

**Problem**: The workflow builds SDK first, then types, then utils, then cloud:

```
Step 1: Build SDK         ← depends on types + display-utils (not built yet!)
Step 2: Build types
Step 3: Build utils
Step 4: Build cloud
```

This works by accident because Bun resolves workspace packages from source files in dev mode. But `tsc --build --force` (part of SDK's `build:types` script) needs the types package to be compiled. A change to types could silently break this.

**Fix**: Reorder to: types → display-utils → sdk → utils → cloud.

---

### 4. `display-utils` is missing from all Docker builds and most CI workflows

**Severity**: 🔴 High — latent build failure

**Where**: All Dockerfiles (`porter`, `stress`, `livekit`), plus `cloud-build.yml`, `cloud-console-build.yml`, `cloud-store-build.yml`, `cloud-sdk-build.yml`

**Problem**: `@mentra/sdk` depends on `@mentra/display-utils`. None of the Docker build sequences or CI workflows build `display-utils`. The SDK's `bun build` bundles it from source, but `tsc` for type generation needs the compiled output.

**Fix**: Add `display-utils` build step before `sdk` in all build chains:

```
types → display-utils → sdk → utils → cloud
```

For Dockerfiles, insert between types and sdk:

```dockerfile
cd packages/display-utils && bun run build && \
```

For CI workflows, add a step:

```yaml
- name: Build display-utils package
  working-directory: cloud/packages/display-utils
  run: bun run build
```

---

### 5. `cloud-build.yml` uses `bun install` without `--frozen-lockfile`

**Severity**: 🟡 Medium — could mask lockfile drift

**Where**: `.github/workflows/cloud-build.yml` line 66

**Problem**: Every other CI workflow uses `bun install --frozen-lockfile` to catch lockfile drift. This one uses bare `bun install`, meaning it could silently succeed even if the lockfile is stale.

**Fix**: Change to `bun install --frozen-lockfile`.

---

### 6. Production Docker images include devDependencies

**Severity**: 🟡 Medium — larger images, slower pulls

**Where**: `Dockerfile.porter`, `Dockerfile.stress`, `Dockerfile.livekit`

**Problem**: `bun install` without `--production` installs everything — eslint, prettier, typescript, chalk, husky, etc. These aren't needed at runtime (the app runs from `dist/`). This bloats the Docker image and slows down image pulls during deploys.

**Fix**: After the build step, prune devDependencies:

```dockerfile
# Build everything
RUN ...build steps...

# Prune dev deps from final image
RUN rm -rf node_modules && bun install --production
```

Or use a multi-stage build where the final stage only copies `dist/` and production `node_modules`.

---

### 7. `bun-types` version hack runs on every build

**Severity**: 🟡 Medium — fragile, wastes time

**Where**: `Dockerfile.porter`, `Dockerfile.stress`, `Dockerfile.livekit`

**Problem**: After `bun install`, the Dockerfiles do:

```dockerfile
RUN bun install && \
    rm -rf node_modules/@types/bun && \
    bun add -d bun-types@1.0.17
```

This deletes auto-installed bun types and reinstalls a specific version on every build. The root cause is a version conflict between `@types/bun` (auto-provided) and the explicitly wanted `bun-types@1.0.17`.

**Fix**: Pin `bun-types` in the root `package.json` with a `resolutions` or `overrides` field so `bun install` handles it:

```json
{
  "overrides": {
    "bun-types": "1.0.17"
  }
}
```

Then remove the `rm -rf && bun add` hack from all Dockerfiles.

---

### 8. `cloud-tests.yml` has no concurrency group

**Severity**: 🟡 Medium — wastes CI minutes

**Where**: `.github/workflows/cloud-tests.yml`

**Problem**: Every other workflow has:

```yaml
concurrency:
  group: ...-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

`cloud-tests.yml` doesn't. Pushing 3 commits in quick succession runs 3 full test suites simultaneously. The first two are wasted work since only the latest matters.

**Fix**: Add concurrency group:

```yaml
concurrency:
  group: cloud-tests-${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true
```

---

### 9. `cloud-tests.yml` triggers on all `cloud/**` changes with no path filter

**Severity**: 🟡 Medium — wastes CI minutes

**Where**: `.github/workflows/cloud-tests.yml`

**Problem**: The trigger is:

```yaml
on:
  push:
    paths:
      - "cloud/**"
```

This fires the full test suite for documentation edits (`cloud/issues/*.md`), Dockerfile changes, porter YAML changes, website changes — anything under `cloud/`. The other workflows use `dorny/paths-filter` to skip irrelevant changes.

**Fix**: Add paths-filter to gate the test job, or narrow the trigger paths:

```yaml
paths:
  - "cloud/packages/**"
  - "cloud/bun.lock"
  - "cloud/package.json"
```

---

### 10. Every deploy builds the Go LiveKit binary (dead code)

**Severity**: 🟡 Medium — 30–60s wasted per deploy

**Where**: `Dockerfile.livekit` (used by both `porter.yaml` and `porter-livekit.yaml`), `start.sh`

**Problem**: Both `porter.yaml` and `porter-livekit.yaml` reference `Dockerfile.livekit`, which has a multi-stage Go build. It installs `golang:1.24`, `libopus-dev`, `protobuf-compiler`, downloads Go modules, compiles proto files, and builds a `livekit-bridge` binary. Then the final image includes `libopus0`, `libsoxr0` runtime libraries.

LiveKit is dead code (see [maintainability.md §19](../040-cloud-v3-cleanup/maintainability.md)). Audio has moved to WebSocket + UDP transport.

`start.sh` also starts the Go binary and waits for its Unix socket before launching Bun.

**Fix**: This is blocked on the LiveKit removal (maintainability §19). Once LiveKit is removed:

1. Switch `porter.yaml` and `porter-livekit.yaml` to use `Dockerfile.porter` (or a new clean Dockerfile)
2. Replace `start.sh` with a direct `CMD ["bun", "run", "start"]`
3. Delete `Dockerfile.livekit`
4. Remove Go runtime deps (`libopus0`, `libsoxr0`) from the final image

---

### 11. Blacksmith Docker cache isn't leveraged for deploys

**Severity**: 🟢 Low — optimization opportunity

**Where**: `porter-dev.yml`, `porter-prod.yml`, `porter-staging.yml`

**Problem**: The deploy workflows run on `blacksmith-4vcpu-ubuntu-2404` (Blacksmith runners), which provide fast local SSD-backed Docker layer caching. However, the workflows only run `porter apply`, which triggers a Docker build on **Porter's** infrastructure — not on the Blacksmith runner. Blacksmith's Docker cache advantage is unused.

For the CI test/build workflows (cloud-build, console-build, etc.) that run Bun directly on the runner, Blacksmith provides faster CPUs and the `actions/cache` integration works fine. No issue there.

**Fix**: This is a deeper architectural question about whether to build Docker images on Blacksmith (using `docker/build-push-action` with Blacksmith's cache backend) and push to a registry, then have Porter pull — vs. letting Porter build. Deferring for now, but noting the opportunity.

---

### 12. `cloud-sdk-build.yml` builds SDK before types

**Severity**: 🟢 Low — same latent issue as #3

**Where**: `.github/workflows/cloud-sdk-build.yml`

**Problem**: Builds SDK first, types second. Should be reversed.

**Fix**: Reorder to types → display-utils → sdk.

---

### 13. `start.sh` still launches LiveKit bridge

**Severity**: 🟢 Low — blocked on LiveKit removal

**Where**: `cloud/start.sh`

**Problem**: The production entrypoint starts the Go LiveKit binary, waits for its Unix socket, then starts Bun. Once LiveKit is removed, this should become a simple `bun run start`.

**Fix**: Blocked on maintainability §19. Same as #10.

---

## Implementation Plan

### Phase 1 — Quick fixes (this PR)

| #   | Fix                                          | Files                                                                                                                                                        |
| --- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2   | Fix `bun.lockb` → `bun.lock` cache keys      | `cloud-tests.yml`, `augmentos_cloud_pr_dev_main.yml`                                                                                                         |
| 3   | Fix build order in `cloud-build.yml`         | `cloud-build.yml`                                                                                                                                            |
| 4   | Add `display-utils` to all build chains      | `cloud-build.yml`, `cloud-console-build.yml`, `cloud-store-build.yml`, `cloud-sdk-build.yml`, `Dockerfile.porter`, `Dockerfile.stress`, `Dockerfile.livekit` |
| 5   | Add `--frozen-lockfile` to `cloud-build.yml` | `cloud-build.yml`                                                                                                                                            |
| 8   | Add concurrency group to `cloud-tests.yml`   | `cloud-tests.yml`                                                                                                                                            |
| 9   | Add path filter to `cloud-tests.yml`         | `cloud-tests.yml`                                                                                                                                            |
| 12  | Fix build order in `cloud-sdk-build.yml`     | `cloud-sdk-build.yml`                                                                                                                                        |

### Phase 2 — Docker layer caching (this PR)

| #   | Fix                                     | Files                                                          |
| --- | --------------------------------------- | -------------------------------------------------------------- |
| 1   | Split COPY for layer caching            | `Dockerfile.porter`, `Dockerfile.stress`, `Dockerfile.livekit` |
| 7   | Fix bun-types via package.json override | `cloud/package.json`, all three Dockerfiles                    |

### 14. Developers must keep local Bun updated to latest

**Severity**: 🔴 High — causes recurring CI failures when local Bun is behind

**Where**: Developer machines

**Problem**: CI uses `bun-version: latest` which is correct — we always want the latest Bun. But developers may fall behind (e.g., running `1.3.9` locally while CI has `1.3.10`). Different Bun patch versions resolve dependencies slightly differently, so a lockfile generated with an older local Bun will fail `--frozen-lockfile` on CI.

This already caused two CI failures on PR #2108 — the lockfile was committed from a local `1.3.9` install but CI ran `1.3.10`.

**Fix**: Developers should run `bun upgrade` regularly to stay on the latest version. Add a note to `CONTRIBUTING.md` or the cloud `README.md`:

```
## Prerequisites
- Bun (latest) — run `bun upgrade` before committing lockfile changes
```

Optionally, add a CI check that prints the Bun version at the start of each workflow for easier debugging when this happens.

---

### Phase 3 — Deferred (separate PRs)

| #   | Fix                                          | Blocked on                                                  |
| --- | -------------------------------------------- | ----------------------------------------------------------- |
| 6   | Prune devDeps in production images           | Needs testing to ensure runtime doesn't import dev packages |
| 10  | Remove LiveKit from Dockerfiles              | Maintainability §19 (LiveKit removal)                       |
| 11  | Evaluate Blacksmith Docker cache for deploys | Architecture decision on build location                     |
| 13  | Simplify `start.sh`                          | Maintainability §19 (LiveKit removal)                       |

### Phase 1.5 — Bun version hygiene (this PR or fast follow)

| #   | Fix                                                  | Files                       |
| --- | ---------------------------------------------------- | --------------------------- |
| 14  | Document "run `bun upgrade` before lockfile commits" | `CONTRIBUTING.md` or README |

---

## Expected Impact

| Metric                             | Before                           | After (Phase 1+2)                |
| ---------------------------------- | -------------------------------- | -------------------------------- |
| Deploy build time (no dep changes) | ~3–4 min                         | ~1–2 min (install layer cached)  |
| CI test workflow (cache hit)       | Cache never hits                 | Cache hits on lockfile match     |
| CI builds on doc-only changes      | Full test suite runs             | Skipped                          |
| Stale CI runs on rapid pushes      | All run to completion            | Older runs canceled              |
| Build correctness                  | Accidentally works               | Correct dependency order         |
| Lockfile drift CI failures         | Recurring (Bun version mismatch) | Eliminated (devs stay on latest) |
