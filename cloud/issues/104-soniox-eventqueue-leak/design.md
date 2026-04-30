# Design: Patch Soniox SDK eventQueue Leak — Implementation

## Overview

**What this doc covers:** File-by-file implementation plan for the changes spec'd in [spec.md](./spec.md). Three deliverables: SDK version bump, local `patch-package` patch, and the upstream PR submission.

**What you need to know first:** [spike.md](./spike.md) for the heap-snapshot evidence; [spec.md](./spec.md) for the exact behavior changes and rationale.

**Who should read this:** PR reviewers; whoever lands the upstream PR; whoever drops the patch later when upstream ships the fix.

---

## Branch Plan

One PR for the MentraOS-side change (S1 + S2 from spec). The upstream PR (S3) is an independent submission to `soniox/soniox-js` and doesn't block this PR's merge.

Branch: `cloud/104-soniox-eventqueue-leak-fix` off `origin/dev`. Already created.

---

## Changes Summary

| Component                       | File                                                                                                 | Change                                                                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| S1: SDK version bump            | `cloud/packages/cloud/package.json`                                                                  | `"@soniox/node": "^1.1.1"` → `"^2.0.0"`                                                                                              |
| S2: patchedDependencies entry   | `cloud/package.json`                                                                                 | Add `"patchedDependencies": { "@soniox/node@2.0.0": "patches/@soniox%2Fnode@2.0.0.patch" }` (bun native — no devDep, no postinstall) |
| S2: the patch itself            | `cloud/patches/@soniox%2Fnode@2.0.0.patch` (new)                                                     | Generated patch — adds `iteratorAttached` flag + gates each `eventQueue.push(...)` in both `dist/index.mjs` and `dist/index.cjs`     |
| S3: upstream PR (separate repo) | `soniox/soniox-js` `packages/node/src/realtime-stt-session.ts` (or wherever `RealtimeSttSession` is) | Same fix in TypeScript source                                                                                                        |

Estimated diff in this repo: 3 files modified (`cloud/package.json`, `cloud/packages/cloud/package.json`, `cloud/bun.lock`), 1 file added (`cloud/patches/@soniox%2Fnode@2.0.0.patch`). The patch file is ~80 lines (covers both `.mjs` and `.cjs`).

No changes to MentraOS source code.

---

## S1: Bump `@soniox/node` to `^2.0.0`

### File: `cloud/packages/cloud/package.json`

```diff
   "dependencies": {
     ...
-    "@soniox/node": "^1.1.1",
+    "@soniox/node": "^2.0.0",
     ...
   }
```

After the edit:

```bash
cd cloud
bun install
```

This updates `bun.lock` to pin `@soniox/node@2.0.0`. The bun cache layout (`node_modules/.bun/@soniox+node@2.0.0/...`) replaces the `1.1.2` directory. patch-package needs the new version in path before recording the patch.

Verification: `bunx tsc --noEmit` passes from `cloud/packages/cloud/`. If any new type errors appear due to v1→v2 changes, address them in the same commit (most likely scenario: a type widened or an import name changed for a peripheral symbol).

---

## S2: bun patch + the patch file

### Step 1 — prepare a writable copy

```bash
cd cloud
bun patch @soniox/node@2.0.0
```

Bun materializes `node_modules/@soniox/node` (escapes the bun cache layout into a regular folder) and prints the path to edit.

### Step 2 — modify the materialized SDK

Edit both compiled bundles:

```
cloud/node_modules/@soniox/node/dist/index.mjs
cloud/node_modules/@soniox/node/dist/index.cjs
```

The same change goes into both files. Locate the `RealtimeSttSession` class declaration and apply the diff from spec S2.

The relevant lines in `index.mjs` (v2.0.0):

- Field declarations near line 697 (`eventQueue = new AsyncEventQueue();`)
- `[Symbol.asyncIterator]()` getter near line 888
- `eventQueue.push(...)` calls in the message handler near lines 946, 952, 956, 960

Same offsets exist in `index.cjs` (similar layout, slightly different module wrapper).

The patch in spec.md S2 captures the change verbatim.

### Step 3 — commit the patch

```bash
cd cloud
bun patch --commit 'node_modules/@soniox/node'
```

This produces `cloud/patches/@soniox%2Fnode@2.0.0.patch` (bun encodes `/` as `%2F`) containing the unified diff for both `index.mjs` and `index.cjs`. It also writes the `patchedDependencies` field into `cloud/package.json` automatically.

Verify the file is non-empty and contains both `+++ b/dist/index.mjs` and `+++ b/dist/index.cjs` headers.

### Step 4 — verify the patch applies on a clean install

```bash
cd cloud
rm -rf node_modules
bun install
```

Bun re-extracts the package, then re-applies the patch automatically (no postinstall hook needed). Inspect `node_modules/.bun/@soniox+node@2.0.0/.../dist/index.mjs` to confirm the `iteratorAttached` field and the gates are present.

### Why not `patch-package`?

Initial attempt was `bun add -d patch-package` + `bunx patch-package @soniox/node`. It failed because patch-package looks for `node_modules/@soniox/node/package.json` at the workspace root, but bun's content-addressed cache layout puts the real files at `node_modules/.bun/@soniox+node@2.0.0/...` and only symlinks `packages/cloud/node_modules/@soniox/node`. Bun's native `bun patch` handles this correctly and avoids the extra dev dep + postinstall hook.

### Step 5 — commit

```bash
git add cloud/packages/cloud/package.json cloud/package.json cloud/bun.lock cloud/patches/
git commit -m "fix(104): patch @soniox/node eventQueue leak (upstream PR <link>)

@soniox/node's RealtimeSttSession unconditionally pushes every event
to an internal AsyncEventQueue, even when the consumer uses the .on()
event-listener API (the documented usage). The queue is never drained
and grows ~15 MB/hour per active session for the lifetime of the
session — proven via heap snapshot retainer trace (see issue 104).

This patch adds an iteratorAttached flag set in [Symbol.asyncIterator]()
and gates every eventQueue.push(...) call on it. for await consumers
unaffected (they call the iterator getter before any events arrive);
.on() consumers no longer leak.

Bumps @soniox/node 1.1.1 -> 2.0.0 first so the patch targets the
version Soniox is actively maintaining, and so the upstream PR and
our local patch are both against the same source.

Drop this patch + postinstall hook when upstream merges + ships the
fix — see cloud/issues/104-soniox-eventqueue-leak/."
```

---

## S3: Upstream PR Submission

### Prerequisites

- GitHub auth: `gh auth status` must show admin/repo scope.
- The fork: `gh repo fork soniox/soniox-js --clone --remote=upstream`. This creates a fork under your GitHub account, clones it locally, and adds `soniox/soniox-js` as the `upstream` remote.

### Steps

````bash
# 1. Fork + clone
cd /tmp
gh repo fork soniox/soniox-js --clone --remote=upstream
cd soniox-js

# 2. Create branch
git checkout -b fix/eventqueue-iterator-attach-gate

# 3. Find the source file
ls packages/node/src/
# Likely: realtime-stt-session.ts  (or session/realtime-stt-session.ts)
# Locate the class:
grep -rn "class RealtimeSttSession" packages/node/src/

# 4. Apply the same fix in TypeScript
# Same shape as the S2 patch but in .ts source:
#   - Add `iteratorAttached = false;` field
#   - Set it in [Symbol.asyncIterator]() getter
#   - Gate each eventQueue.push(...) on the flag
#   (Their build will compile this to the same .mjs/.cjs we patched locally)

# 5. Run their test suite
cd packages/node
npm test  # or whatever they use — check their CI config

# 6. Commit
cd /tmp/soniox-js
git add packages/node/src/realtime-stt-session.ts  # or actual path
git commit -m "fix(node): only push to eventQueue when iterator has been attached

When a consumer uses session.on() event listeners (the documented
pattern from soniox.com/docs/stt/SDKs/node-SDK) instead of the async
iterator, the eventQueue grows unbounded — every event is pushed
but nothing drains. Long-running sessions leak ~15 MB/hour of
buffered RealtimeEvent objects.

Fix: track whether [Symbol.asyncIterator]() has been called.
Only push to eventQueue when it has. Both consumer paths continue
to work; the dual-API just no longer double-allocates when only
one is used."

# 7. Push to fork
git push -u origin fix/eventqueue-iterator-attach-gate

# 8. Open PR
gh pr create --repo soniox/soniox-js --base main \
  --title "fix(node): only push to eventQueue when iterator attached" \
  --body "$(cat <<'EOF'
## Summary

`RealtimeSttSession.eventQueue` is unconditionally pushed to on every
WebSocket message, even when no consumer has called the async iterator
(`for await...of session`). Consumers using the documented `.on()`
listener pattern leak ~15 MB/hour of buffered `RealtimeEvent` objects
on long-running sessions.

## Reproduce

```js
import { SonioxNodeClient } from "@soniox/node";
const client = new SonioxNodeClient({ api_key: "..." });
const session = await client.realtime.transcribe({ ... });

// Documented usage (per soniox.com/docs/stt/SDKs/node-SDK):
session.on("result", (result) => {
  // handle result
});

await session.connect();
// Stream audio for any extended period.
// Inspect the heap: session.eventQueue.queue.length grows by 1 per event.
// Memory leaks indefinitely.
````

## Evidence

Programmatic heap-snapshot retainer trace from a production Node pod
(uptime 66h, 4 active sessions):

- Single `AsyncEventQueue.queue` array contained **4,148+ elements**
  after 1h of activity.
- Same-pod 1h diff showed **+243,784 retained `"en"` strings** (the
  `language` field on each token in each queued result), **+534,230**
  generic `Object` instances. Loaded-code overhead (V8 `Structure`,
  `FunctionExecutable`) was flat — pure data accumulation.
- Heap snapshot file size: **41 MB → 104 MB in 1 hour**.
- Verified the same bug exists in `@soniox/node@2.0.0`.

Full investigation writeup with retainer chain:

<link to issue 104 spike when public, or paste inline>

## Fix

Track whether `[Symbol.asyncIterator]()` has been called via a new
`iteratorAttached` flag. Only push to `eventQueue` when the flag is set.

```diff
 class RealtimeSttSession implements AsyncIterable<RealtimeEvent> {
   private readonly eventQueue = new AsyncEventQueue();
+  private iteratorAttached = false;

   [Symbol.asyncIterator]() {
+    this.iteratorAttached = true;
     return this.eventQueue[Symbol.asyncIterator]();
   }

   // (in handleMessage)
   this.emitter.emit("result", filteredResult);
-  this.eventQueue.push({ kind: "result", data: filteredResult });
+  if (this.iteratorAttached) {
+    this.eventQueue.push({ kind: "result", data: filteredResult });
+  }
   // (same gating for endpoint/finalized/finished)
 }
```

## Backward compatibility

- `for await...of session` consumers: unaffected. The async iterator
  protocol calls `[Symbol.asyncIterator]()` before requesting any
  values; the flag is set before any events arrive.
- `.on(event, handler)` consumers: unaffected. The emitter path is
  unchanged.
- API surface: no changes. The new field is private.

## Test plan

- Existing tests should pass unchanged.
- Recommend adding a regression test:
  - Subscribe to events via `.on("result", ...)` only.
  - Drive the session for 1000+ events.
  - Assert `(session as any).eventQueue.queue.length === 0`.
    EOF
    )"

````

The PR's URL goes back into our MentraOS commit message and into the patch's leading comment line.

---

## Constants and Imports

None added in MentraOS source. The patch-package change is in `node_modules/`. The MentraOS source code is unchanged.

The upstream PR adds one private field to `RealtimeSttSession`. No imports change.

---

## Testing

### Local

1. `bun install` from `cloud/packages/cloud/` — must succeed; postinstall must apply the patch.
2. `bunx tsc --noEmit` — must pass.
3. Inspect `node_modules/.bun/@soniox+node@2.0.0/.../dist/index.mjs` — confirm patch applied (search for `iteratorAttached`).
4. Programmatic check on `cloud-debug` after deploy:
   ```bash
   doppler run --project mentra-sre --config dev -- \
     curl -sS -o /tmp/heap-after.heapsnapshot \
       -H "Authorization: Bearer $MENTRA_ADMIN_JWT" \
       https://debug.augmentos.cloud/api/admin/memory/heap-snapshot-v8
   python3 /tmp/heap-compare/heap-diff.py /tmp/heap-debug.heapsnapshot /tmp/heap-after.heapsnapshot
````

Expected: `"en"` count near baseline, no `Array (4148)`-class growth, retainer trace shows AsyncEventQueue.queue with ≤1 element.

### Smoke (deploy to debug or dev)

Add `cloud/104-soniox-eventqueue-leak-fix` to the `branches:` list in `.github/workflows/porter-debug.yml` to auto-deploy to `debug.augmentos.cloud`. After 15-30 min of activity, pull a heap snapshot and verify per the local test above.

### Acceptance (after merge to dev)

1. After deploy to `cloud-dev`, watch `system-vitals` `rssMB` and `heapUsedMB` over 24 hours.
2. Expected: post-GC RSS floor stays near startup baseline (~250-300 MB) instead of climbing to 500+ MB.
3. Expected: GC frequency drops because no steady stream of long-lived `RealtimeEvent` objects to clean up.
4. Issue 104 stays open until upstream merges + releases v2.0.1+.

---

## Rollout

1. Branch `cloud/104-soniox-eventqueue-leak-fix` off `dev`. Done.
2. S1: bump version, run `bun install`, `bunx tsc --noEmit`.
3. S2: install patch-package, modify SDK files, generate patch, wire postinstall, verify clean reinstall.
4. Open MentraOS PR against `dev`.
5. Open upstream PR against `soniox/soniox-js` in parallel (S3).
6. Add `cloud/104-soniox-eventqueue-leak-fix` to porter-debug.yml triggers, auto-deploy, soak ≥1h.
7. Pull post-fix heap snapshot from debug. Compare against `dev-2.heapsnapshot`. Confirm `AsyncEventQueue.queue` size collapsed.
8. Merge MentraOS PR → auto-deploys to cloud-dev.
9. Watch us-central-dev memory floor for 24h.
10. Cherry-pick to main → prod regions.
11. When upstream ships the fix in a new release: bump version, delete patch, remove postinstall hook, close issue 104.

---

## Risks and Open Questions

**Risk: v1→v2 SDK changes break our wrapper.** Mitigated by spec'd typecheck pass; the diff shows only additive changes to consumed surface. If we hit a breaking change at runtime, fix in the same PR.

**Risk: patch-package patch fails to apply after `bun install`.** patch-package exits non-zero, install fails loudly. That's the intended behavior — when upstream releases v2.0.1 with line numbers shifted, we want a hard fail so we know to update or drop the patch.

**Risk: upstream PR rejected by Soniox** (e.g., they prefer a different fix shape). We keep the local patch indefinitely. Cost: tracking patch validity across SDK versions. We'd reconsider the wrapper-drain workaround as Plan B.

**Risk: postinstall script breaks Bun's install caching.** patch-package interacts with `node_modules` directly; bun's content-addressed cache may need to materialize files differently. Mitigated by step 5 of S2 (clean reinstall verification).

**Risk: deploy to debug still leaks** because debug pod hasn't been restarted with the patched build. Mitigated by waiting for the porter-debug.yml workflow run to complete, then explicitly checking pod uptime in `system-vitals` to confirm we're looking at the post-deploy pod.

---

## Summary

Three small changes (one version bump, one dev dep, one patch file). Zero MentraOS source-code changes. The upstream PR is parallel and independent. When upstream ships the fix, removing the patch is a 1-line PR.

The fix at the SDK layer (rather than as a wrapper-side workaround) means every Soniox SDK consumer eventually benefits and our codebase stays free of compensatory hacks.
