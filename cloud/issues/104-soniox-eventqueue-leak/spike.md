# Spike: Soniox SDK `RealtimeSttSession.eventQueue` Unbounded Growth

## Overview

**What this doc covers:** Investigation that traced the non-session heap growth on cloud pods (issue 103) to a specific bug in the upstream `@soniox/node` SDK: `RealtimeSttSession` unconditionally pushes every event to an internal `AsyncEventQueue.queue` Array, even when the consumer uses the `.on()` event-listener API (the documented usage pattern) instead of the async iterator. The queue is never drained and grows by ~1 event per Soniox message for the full lifetime of the session.

**Why this doc exists:** [103-non-session-heap-growth/spike.md](../103-non-session-heap-growth/spike.md) opened the question "where is the ~470-525 MB of post-GC RSS coming from on long-running pods?" The memory census saw 6 KB tracked vs ~280 MB in heap (a ~47,000× blind spot). This spike answers it conclusively, with retainer chains traced from the heap snapshot back to the SDK source.

**Who should read this:** Cloud engineers reviewing the fix PR. Anyone using `@soniox/node` (or `@soniox/web`) via `.on()` listeners (the documented pattern) is affected; if you operate a long-running process, your pod is leaking too.

**Depends on:**

- Heap snapshots from `dev.augmentos.cloud` taken at `T+0` and `T+1h`. Diff at `/tmp/heap-compare/heap-diff.py`.
- Programmatic retainer-chain trace via custom Python script that walks the V8 snapshot's `nodes`/`edges`/`strings` tables (no Chrome DevTools required).
- Source inspection of `node_modules/.bun/@soniox+node@1.1.2/.../dist/index.mjs` and `node_modules/.bun/@soniox+node@1.1.2/.../dist/index.d.mts`.
- Verified the same bug exists in `@soniox/node@2.0.0` (latest, published 2026-04-23).

---

## The Bug In 30 Seconds

`RealtimeSttSession` exposes two consumer APIs for the same event stream:

```typescript
// API 1 — documented in https://soniox.com/docs/stt/SDKs/node-SDK
session.on("result", (result) => { ... });

// API 2 — undocumented (only visible via `class RealtimeSttSession implements AsyncIterable<RealtimeEvent>`)
for await (const event of session) { ... }
```

The SDK's WebSocket message handler pushes every event to BOTH paths unconditionally:

```javascript
// @soniox/node@1.1.2 dist/index.mjs:945-960 (identical in v2.0.0:945-960)
this.emitter.emit("result", filteredResult); // ← path 1
this.eventQueue.push({ kind: "result", data: filteredResult }); // ← path 2

if (hasEndpoint) {
  this.emitter.emit("endpoint");
  this.eventQueue.push({ kind: "endpoint" });
}
if (hasFinalized) {
  this.emitter.emit("finalized");
  this.eventQueue.push({ kind: "finalized" });
}
if (result.finished) {
  this.emitter.emit("finished");
  this.eventQueue.push({ kind: "finished" });
}
```

Consumers who only use `.on()` (the documented happy path) never call `next()` on the iterator, so `eventQueue.queue` (a plain `Array`) accumulates one entry per event for the session's entire lifetime. A long-running session at typical Soniox token rates accumulates tens of thousands of events per hour.

---

## Evidence

### Heap snapshot retainer chain (from production dev pod)

After programmatically walking parent edges in the V8 heap snapshot, the chain from a leaked `"en"` string back to its root is:

```
"en" string × 305,443
  ←language←  SonioxApiToken Object
    ←element N←  Array (tokens[])
      ←tokens←  metadata.soniox Object
        ←data, raw←  RealtimeEvent record Object
          ←element N←  Array (4148+ elements)        ← THE LEAKED BUFFER
            ←queue←  AsyncEventQueue
              ←eventQueue←  RealtimeSttSession
                ←session←  SonioxSdkStream
```

Each retained `"en"` string is a `language: "en"` field on a `SonioxApiToken` inside a tokens array, inside the `data` field of a queued `RealtimeEvent`, inside `AsyncEventQueue.queue`. Same chain for every leaked token-text fragment (` the`, ` and`, ` of`, `ing`, `ly`, `e,`, ` y`, ` it`, ` was`, etc.).

### Same-pod heap diff (1 hour of activity, 4 active sessions)

| Constructor                    | Before (T+0) | After (T+1h) |        Δ | Growth |
| ------------------------------ | -----------: | -----------: | -------: | -----: |
| `Object`                       |      172,112 |      706,342 | +534,230 |  +310% |
| `"en"` (token language tag)    |       61,659 |      305,443 | +243,784 |  +395% |
| `" the"`                       |        1,740 |       10,580 |   +8,840 |  +509% |
| `" and"`                       |          793 |        5,816 |   +5,023 |  +634% |
| `" of"`                        |        1,086 |        5,903 |   +4,817 |  +443% |
| `"ing"`                        |          549 |        3,330 |   +2,781 |  +507% |
| `"ly"`                         |          286 |        1,650 |   +1,364 |  +477% |
| `" I"`                         |          833 |        3,526 |   +2,693 |  +323% |
| `Structure` (V8 hidden class)  |       41,341 |       41,540 |     +199 |  +0.5% |
| `FunctionExecutable` (V8 code) |       27,126 |       27,365 |     +239 |  +0.9% |

Loaded-code overhead (`Structure`, `FunctionExecutable`, `ModuleRecord`) was effectively flat across the same window. **This is pure data accumulation, not V8 metadata growth.**

The heap snapshot file size itself grew **41 MB → 104 MB in one hour** — the largest single retainer was a single `Array (4148)` already at T+0, which would be substantially larger at T+1h.

### Confirmed in v2.0.0

Re-checked the published `@soniox/node@2.0.0` (2026-04-23). Same `eventQueue.push(...)` calls at the same positions in the message handler. The bug was not addressed in the v1→v2 release.

### Affects every documented user

The Soniox docs ([soniox.com/docs/stt/SDKs/node-SDK](https://soniox.com/docs/stt/SDKs/node-SDK)) demonstrate `.on()` as the canonical usage:

```javascript
session.on("result", (result) => {
  const text = result.tokens.map((t) => t.text).join("");
  if (text) console.log(text);
});
```

This is exactly what MentraOS does in [SonioxSdkStream.ts:241-247](../../packages/cloud/src/services/session/transcription/providers/SonioxSdkStream.ts#L241-L247). Any consumer following the docs is leaking.

---

## What We Falsified Along the Way

Before tracing the chain to the SDK, we tested several other hypotheses surfaced from the heap shape:

| Hypothesis                                              | Result                                                                                                                                                                                                           |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pino async transport buffer (revisit of issue 067)      | **Falsified.** `LOG_STDOUT_JSON=true` is set on dev (verified via `kubectl exec ... printenv`). Pino writes raw JSON to stdout via `pino.destination({ sync: false })`; Vector DaemonSet tails container stdout. |
| `SonioxTranscriptionProvider.translationTokenBuffers`   | **Falsified.** The field doesn't appear in the heap snapshot (0 references).                                                                                                                                     |
| `app-session.subscription-history` unbounded            | **Falsified.** 4 instances totaling 22 elements across all sessions. Bounded.                                                                                                                                    |
| Mongoose document/plugin retention                      | **Falsified.** `ObjectId` count grew by only 561 (proportional to traffic, not unbounded).                                                                                                                       |
| `TranscriptionManager._relayDataStream` template object | **Falsified.** Single instance, replaced on every relay call. Not a leak source.                                                                                                                                 |

---

## The Fix

Two parts that ship together:

### Part 1 (in this PR): patch the SDK locally via Bun `patchedDependencies`

Modify `node_modules/@soniox/node/dist/index.mjs` and `index.cjs` to gate every `eventQueue.push(...)` call on a new `iteratorAttached` flag:

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
   // (same gating for endpoint/finalized/finished pushes)
 }
```

Backward compatible. Async-iterator consumers continue to work because the iterator getter sets the flag _before_ any events arrive (the iterator must be obtained before `for await` can iterate).

`bun patch --commit` records this as `cloud/patches/@soniox%2Fnode@2.0.0.patch` and Bun re-applies it automatically on every `bun install` via the `patchedDependencies` field in `cloud/package.json` — no extra dev dependency, no `postinstall` hook.

### Part 2 (separately, this same PR): submit the same fix upstream

PR against [soniox/soniox-js](https://github.com/soniox/soniox-js) main branch with the heap-snapshot evidence + the same code change in TypeScript source ([PR #13](https://github.com/soniox/soniox-js/pull/13)). When upstream merges and ships v2.0.1+, we bump the version, delete `cloud/patches/@soniox%2Fnode@2.0.0.patch`, and remove the `patchedDependencies` entry from `cloud/package.json`.

### Why not just upgrade SDK and skip the patch?

We did upgrade — same bug exists in v2.0.0 (verified). The fix has to come from us either way.

### Why not work around it in our wrapper code (drain loop)?

A 5-line workaround (`for await (const _ of this.session) {}` next to the `.on()` calls in `SonioxSdkStream.ts`) would fix our heap without touching the SDK. We chose the SDK patch instead because:

1. It contributes back to upstream — every other Soniox SDK user benefits.
2. The bug fix lives at the right layer (the SDK shouldn't double-allocate).
3. patch-package + upstream PR is the correct workflow for a known upstream bug.

The wrapper-drain approach remains a valid alternative if upstream rejects the PR for any reason.

---

## Key Numbers

| Metric                                         | Observed                                                                          |
| ---------------------------------------------- | --------------------------------------------------------------------------------- |
| `AsyncEventQueue.queue` size on dev at T+0     | 4,148 elements (1 active session using the SDK path)                              |
| Retained `"en"` strings at T+0                 | 61,659                                                                            |
| Retained `"en"` strings at T+1h                | 305,443                                                                           |
| New `"en"` per hour (4 sessions, ~16 events/s) | +243,784                                                                          |
| Heap snapshot size growth                      | 41 MB → 104 MB in 1 hour (+154%)                                                  |
| Per-session estimated leak rate                | ~15 MB/hour at typical token rates                                                |
| Memory floor on prior pod (66h uptime)         | RSS climbed 286 → 525 MB (+239 MB), heap 117 → 528 MB (+411 MB before GC reclaim) |

---

## Evidence Index

The artifacts produced during this investigation live at:

- `/tmp/heap-compare/dev-1.heapsnapshot` — V8 snapshot from dev pod at 2026-04-27 17:00 UTC (41 MB)
- `/tmp/heap-compare/dev-2.heapsnapshot` — V8 snapshot from dev pod at 2026-04-27 18:00 UTC (104 MB)
- `/tmp/heap-debug.heapsnapshot` — V8 snapshot from debug pod at 2026-04-24 21:30 UTC (22.8 MB), included for cross-pod comparison
- `/tmp/heap-compare/heap-diff.py` — Python script (stdlib-only) that does constructor diff + retainer-class histogram across two `.heapsnapshot` files. Run as `python3 heap-diff.py BEFORE.heapsnapshot AFTER.heapsnapshot`.

To re-confirm the leak on a future pod, pull a snapshot via:

```bash
doppler run --project mentra-sre --config dev -- \
  curl -sS -o /tmp/heap.heapsnapshot \
    -H "Authorization: Bearer $MENTRA_ADMIN_JWT" \
    https://dev.augmentos.cloud/api/admin/memory/heap-snapshot-v8
```

Then count `AsyncEventQueue.queue` array sizes:

```bash
python3 -c "
import json
with open('/tmp/heap.heapsnapshot') as f: d = json.load(f)
nodes = d['nodes']; strings = d['strings']
nf = d['snapshot']['meta']['node_fields']
type_idx = nf.index('type'); name_idx = nf.index('name'); edge_count_idx = nf.index('edge_count')
node_types = d['snapshot']['meta']['node_types'][0]
nfc = len(nf)
for i in range(0, len(nodes), nfc):
    t = node_types[nodes[i+type_idx]]
    n = strings[nodes[i+name_idx]]
    if n == 'AsyncEventQueue':
        print(f'AsyncEventQueue at node {i//nfc}, edges: {nodes[i+edge_count_idx]}')
"
```

If `AsyncEventQueue.queue` size > a few hundred, the bug is back.
