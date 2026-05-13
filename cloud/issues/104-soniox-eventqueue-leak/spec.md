# Spec: Patch Soniox SDK eventQueue Leak

## Overview

**What this doc covers:** The exact behavior changes that ship in PR #<TBD> for issue 104. Three coordinated changes: (1) bump `@soniox/node` from `^1.1.1` to `^2.0.0`, (2) apply a local `bun patch` that gates `RealtimeSttSession.eventQueue.push(...)` on iterator attachment, (3) submit the same fix as a PR upstream against `soniox/soniox-js` ([PR #13](https://github.com/soniox/soniox-js/pull/13) — also patches `RealtimeTtsStream.audioQueue` which has the same shape).

**Why this doc exists:** [spike.md](./spike.md) traces the non-session heap growth that has been climbing on every long-running cloud pod (~15 MB/hour per active session) to a specific upstream SDK bug. We could work around it in our wrapper code (~5-line drain loop), but chose the SDK-patch + upstream-PR path so every other Soniox SDK consumer also benefits.

**What you need to know first:** [spike.md](./spike.md) for the heap-snapshot evidence, retainer chain, and v2.0.0 verification.

**Who should read this:** PR reviewers. Anyone touching the transcription stack.

---

## Spec

### S1. Bump `@soniox/node` to `^2.0.0`

**File:** `cloud/packages/cloud/package.json`

**Before:** `"@soniox/node": "^1.1.1"` (resolves to `1.1.2`).

**After:** `"@soniox/node": "^2.0.0"` (resolves to `2.0.0`).

**Net effect:** picks up upstream's latest. v1→v2 changes are mostly additive (new `tts` API on `SonioxNodeClient`; new `SonioxHttpError` class hierarchy for REST errors). Our consumed surface (`SonioxNodeClient`, `RealtimeSttSession`, `RealtimeUtteranceBuffer`, types `RealtimeResult`/`RealtimeToken`/`SttSessionConfig`) is unchanged. Only public-API addition on `RealtimeSttSession` is a private `connectTimeoutMs` field.

Verification: `bunx tsc --noEmit` from `cloud/packages/cloud/` must pass with no new errors attributable to the bump.

### S2. Apply the eventQueue-attach gate locally via `bun patch`

**Files:**

- `cloud/package.json` — add `patchedDependencies` field (bun native; no devDep, no postinstall hook)
- `cloud/patches/@soniox%2Fnode@2.0.0.patch` (new) — generated patch (bun encodes `/` as `%2F`)
- Modified working copy at `cloud/node_modules/@soniox/node/dist/index.{mjs,cjs}` before `bun patch --commit` records it

**The change:** add an `iteratorAttached` flag on `RealtimeSttSession`; set it from the async-iterator getter; gate every `eventQueue.push(...)` call on the flag.

```diff
 class RealtimeSttSession {
   emitter = new TypedEmitter();
   eventQueue = new AsyncEventQueue();
+  iteratorAttached = false;

   [Symbol.asyncIterator]() {
+    this.iteratorAttached = true;
     return this.eventQueue[Symbol.asyncIterator]();
   }

   // ... in handleMessage:
   this.emitter.emit("result", filteredResult);
-  this.eventQueue.push({ kind: "result", data: filteredResult });
+  if (this.iteratorAttached) {
+    this.eventQueue.push({ kind: "result", data: filteredResult });
+  }
   if (hasEndpoint) {
     this.emitter.emit("endpoint");
-    this.eventQueue.push({ kind: "endpoint" });
+    if (this.iteratorAttached) this.eventQueue.push({ kind: "endpoint" });
   }
   if (hasFinalized) {
     this.emitter.emit("finalized");
-    this.eventQueue.push({ kind: "finalized" });
+    if (this.iteratorAttached) this.eventQueue.push({ kind: "finalized" });
   }
   if (result.finished) {
     this.emitter.emit("finished");
-    this.eventQueue.push({ kind: "finished" });
+    if (this.iteratorAttached) this.eventQueue.push({ kind: "finished" });
     this.settleFinish();
     this.cleanup("finished");
   }
 }
```

The same modification applies to both `dist/index.mjs` and `dist/index.cjs`. `bun patch --commit` records both into a single `.patch` file at `cloud/patches/`.

Bun reads `patchedDependencies` natively — no `postinstall` hook, no extra dev dependency. Our `cloud/package.json` gains:

```json
{
  "patchedDependencies": {
    "@soniox/node@2.0.0": "patches/@soniox%2Fnode@2.0.0.patch"
  }
}
```

**Net effect:** every `bun install` re-applies the patch from cache. `eventQueue.queue` grows by 0 entries when no consumer has called `[Symbol.asyncIterator]()` (our case — we only use `.on()`). `for await...of session` consumers are unaffected because the iterator-getter sets `iteratorAttached = true` before any events arrive.

### S3. Submit the same fix upstream

**Repo:** [github.com/soniox/soniox-js](https://github.com/soniox/soniox-js) — the SDK source. The published `@soniox/node` is its `packages/node` workspace.

**Branch:** Fork → `fix/eventqueue-iterator-attach-gate`.

**Change:** same as S2 but in TypeScript source (`packages/node/src/realtime-stt-session.ts` or wherever `RealtimeSttSession` lives upstream).

**PR body:** the spike's evidence — heap snapshot retainer chain, before/after diff numbers, v2.0.0 reproducer note. Cross-link to this issue.

When upstream merges + ships v2.0.1+: bump our pinned version, delete `cloud/patches/@soniox%2Fnode@2.0.0.patch`, remove the `patchedDependencies` entry from `cloud/package.json`, close issue 104.

### S4. No changes to MentraOS code

Explicitly out of scope for this PR:

- `SonioxSdkStream.ts` — the wrapper is correct. Consumes events via the documented `.on()` pattern. No changes.
- `SonioxTranscriptionProvider.ts` — uses a different code path (`SonioxNodeClient`, not `RealtimeSttSession`). Unaffected.
- The `for await` drain-loop workaround alternative — not used. The SDK patch supersedes it.

---

## Non-Goals

- **Migrating to Soniox's `for await...of session` API** — `.on()` is the documented usage and our wrapper is correct. No reason to refactor.
- **Adding our own bounded queue around the SDK** — the SDK should be fixed at the source, not papered over.
- **Switching transcription providers** — Soniox is fine. The bug is one isolated SDK design issue, not a vendor reliability concern.
- **Capping `AsyncEventQueue.queue` size in the patch** — capping would change observable behavior for legit `for await` consumers (they'd silently lose events). The iterator-attach gate is the right fix because it preserves both APIs' semantics.

---

## Decision Log

| Decision                                                  | Alternatives considered                                                | Why we chose this                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Patch the SDK + upstream PR                               | Drain-loop workaround in `SonioxSdkStream.ts` (5 lines)                | The SDK patch (a) fixes the bug for every other Soniox SDK consumer, (b) lives at the right architectural layer, (c) is removable in one commit when upstream ships the fix. The drain-loop hack would survive forever if we forget. User explicitly wanted to contribute upstream.                                                                                                                    |
| Bump to `^2.0.0` before patching                          | Patch against `1.1.2`                                                  | Soniox is no longer maintaining v1; patches against v1 would be wasted work. v2 has the same bug, low-risk diff for our consumed surface, and upstream will only accept the PR against current source. Bumping first means the patch and the upstream PR both target the same version.                                                                                                                 |
| `iteratorAttached` flag set in `[Symbol.asyncIterator]()` | Set on first `next()` call; explicit opt-in API                        | Setting in the iterator-getter is semantically correct — if a consumer obtained the iterator at all, they intend to consume from it (otherwise they wouldn't have called the getter). First-`next()` would lose events between getter call and first `next()`, breaking valid usage patterns.                                                                                                          |
| `bun patch` (native) over `patch-package`                 | `patch-package` + `postinstall` hook; vendor a fork in `cloud/vendor/` | Bun has built-in `patchedDependencies` support — reads the same unified-diff format and re-applies on every install. No extra dev dep, no postinstall hook to maintain. `patch-package` works but errored on bun's content-addressed cache layout (couldn't find `node_modules/@soniox/node/package.json` — the symlink lives in the workspace `node_modules/`). Forking is heavyweight by comparison. |
| Patch lives at `cloud/patches/`                           | Patch under `cloud/packages/cloud/patches/`                            | `bun patch` puts patches at the workspace root next to the `package.json` that declares `patchedDependencies`. That's the conventional bun layout and works out of the box.                                                                                                                                                                                                                            |
| Keep `SonioxSdkStream.ts` exactly as-is                   | Add a comment + drain-loop "just in case"                              | The wrapper code is correct. Adding workaround code that fights the SDK is the kind of change that future engineers don't know is safe to remove. Keep our code clean; let the SDK be the layer that owns this responsibility.                                                                                                                                                                         |

---

## Testing

### Local

1. `bun install` from `cloud/packages/cloud/` — must succeed; postinstall must apply the patch and report "patching @soniox/node@2.0.0".
2. `bunx tsc --noEmit` — must pass with zero errors.
3. `bun run test` — must pass (transcription tests should be unaffected since `.on()` semantics didn't change).
4. Inspect `node_modules/.bun/@soniox+node@2.0.0/.../dist/index.mjs` — confirm `iteratorAttached = false` field exists and `if (this.iteratorAttached)` guards each push.

### Smoke (deploy to debug or dev)

1. Deploy branch to `cloud-debug` (debug.augmentos.cloud) via the existing porter-debug.yml workflow trigger.
2. Confirm a transcription session works end-to-end — open a webview, speak, verify text appears. The fix doesn't change `.on()` semantics; behavior should be identical.
3. After ~15 minutes of activity, pull a heap snapshot and run `python3 /tmp/heap-compare/heap-diff.py against-baseline.heapsnapshot debug-now.heapsnapshot`. Expected:
   - `AsyncEventQueue` `.queue` array size: **≤1 element** (instead of growing unboundedly).
   - `"en"` count: stable instead of growing 200k+/hour.
   - Total heap snapshot size: stable instead of growing 60+ MB/hour.

### Acceptance after one prod cycle

After merging to `dev` and deploying to us-central-prod:

1. Track `system-vitals` `rssMB` and `heapUsedMB` over 24-72 hours.
2. Expected: post-GC RSS floor stays near startup baseline (~250-300 MB) instead of climbing to 500+ MB over hours.
3. Expected: GC frequency drops because there's no longer a steady stream of long-lived `RealtimeEvent` objects to clean up.
4. Pull a heap snapshot mid-run. `AsyncEventQueue.queue` size should be ≤1.

---

## Rollout

1. Branch `cloud/104-soniox-eventqueue-leak-fix` off `dev`. Done.
2. Apply changes per S1, S2 in this PR.
3. Open this PR against `dev`.
4. Open the upstream PR per S3 in parallel (independent of MentraOS PR review).
5. Deploy to `cloud-debug` for soak validation (≥1 hour).
6. Merge MentraOS PR → auto-deploys to `cloud-dev` via porter-dev.yml.
7. Watch dev for 24 hours; confirm memory floor stable.
8. Cherry-pick to `main` → deploys to prod regions.
9. When upstream merges + releases v2.0.1+: file follow-up PR to bump version + remove patch + remove postinstall hook + close issue 104.

---

## Key Numbers

| Metric                                       | Today (with leak)      | After fix (expected)                     |
| -------------------------------------------- | ---------------------- | ---------------------------------------- |
| `AsyncEventQueue.queue` size after 1h on dev | 4,148+ elements        | ≤1                                       |
| `"en"` strings in heap                       | 305,443 (and climbing) | <100                                     |
| Heap snapshot file size on dev               | 104 MB (and growing)   | ~25 MB stable (transcription baseline)   |
| Per-session memory growth                    | ~15 MB/hour            | ~0                                       |
| Post-GC RSS floor on 66h pod                 | 525 MB (climbing)      | Stable near startup baseline (~250 MB)   |
| us-central crashes per day (issue 102)       | Daily                  | Should reduce; this leak was a co-factor |
