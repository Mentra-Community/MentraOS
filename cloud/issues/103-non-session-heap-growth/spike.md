# Spike: Non-Session Heap Growth on Cloud Pod

> **Resolved 2026-04-27 — root cause identified.** The non-session heap growth this spike opened the question on traces to a single upstream bug in `@soniox/node`'s `RealtimeSttSession.eventQueue`. See [104-soniox-eventqueue-leak/spike.md](../104-soniox-eventqueue-leak/spike.md) for the full retainer-chain trace and [104/spec.md](../104-soniox-eventqueue-leak/spec.md) for the fix being shipped (SDK patch via `patch-package` + upstream PR).

## Overview

**What this doc covers:** Evidence of a sustained heap leak on cloud pods that lives **outside** the UserSession ownership graph. On dev with two idle sessions and negligible traffic, heap grows ~18MB/hour. The per-session memory census accounts for roughly **0.001%** of what's actually retained — the other 99.999% is owned by something else. This spike catalogs the evidence and the candidate owners, without committing to a cause.

**Why this doc exists:** Separate from the [102 event-loop cascade](../102-pod-loop-stall-cascade/). That issue is about UDP/audio monopolizing the event loop under load on us-central prod. This issue is about a slow memory accumulation visible even at near-zero load on dev. The two can interact — larger heap → longer natural GC → more fragile under cascade — but they are distinct problems with distinct fixes.

**Why this is filed now:** Dev telemetry sample captured 2026-04-24 17:09 UTC shows:

- `heapUsedMB: 429` on 2 sessions, uptime 17h45m (`uptimeSeconds: 63902`)
- `memoryEstimatedSessionBytes: 6,214` (6KB across all sessions)
- `heapObjectCount: 7,660,597`
- `gc-probe` forced GC freed **0 MB** at 453MB heap
- `disposedSessionsPendingGC: 3`

Gap between session-tracked memory (6KB) and actual heap (429MB) is **~69,000×**. The existing census is blind to essentially everything.

**Who should read this:** Cloud engineers. Anyone extending the memory census. Anyone triaging a long-running pod that grows past ~1GB RSS.

**Relationship to issue 102:**

- 102 instruments the audio path + event-loop timer starvation. Phase 1 won't catch this leak directly.
- But heap growth here feeds into the cascade indirectly: larger heap → longer natural major GCs → shorter kill threshold margin. If this leak is fixed, 102's cascade gets more headroom per pod.
- Fixing 103 does not replace 102. Fixing 102 does not replace 103.

---

## Evidence

Raw log sample, dev, us-central-dev, v1011, 2026-04-24 17:09:41 UTC:

```json
{
  "feature": "system-vitals",
  "heapUsedMB": 429,
  "heapTotalMB": 444,
  "rssMB": 683,
  "externalMB": 38,
  "arrayBuffersMB": 9,
  "activeSessions": 2,
  "activeAppWebsockets": 2,
  "activeTranscriptionStreams": 1,
  "glassesWebSockets": 2,
  "micActiveCount": 1,
  "mongoQueryCount": 0,
  "mongoTotalBlockingMs": 0,
  "disposedSessionsPendingGC": 3,
  "memoryEstimatedSessionBytes": 6214,
  "memoryOwnerCount": 16,
  "memoryTopOwners": [
    {"owner": "calendar.events", "estimatedBytes": 3986, "itemCount": 23},
    {"owner": "app-session.subscription-history", "estimatedBytes": 1583, "itemCount": 11},
    {"owner": "app-session.subscriptions", "estimatedBytes": 277, "itemCount": 11},
    {"owner": "transcription.streams", "estimatedBytes": 256, "itemCount": 1},
    {"owner": "dashboard.widgets", "estimatedBytes": 65, "itemCount": 1}
  ],
  "heapObjectCount": 7660597,
  "heapTopTypes": {
    "Object": 3006627,
    "string": 2673323,
    "Array": 188271,
    "Function": 49478,
    "Structure": 40934,
    "UnlinkedFunctionExecutable": 29688,
    "FunctionExecutable": 28115,
    "Uint8Array": 12654,
    "JSLexicalEnvironment": 11956,
    "SymbolTable": 8668
  },
  "wsDisconnects": 0,
  "wsReconnects": 0,
  "uptimeSeconds": 63902
}
```

Same window gc-probe:

```json
{
  "feature": "gc-probe",
  "gcDurationMs": 102.8,
  "heapBeforeMB": 453,
  "heapAfterMB": 453,
  "freedMB": 0,
  "rssMB": 698,
  "activeSessions": 2
}
```

And an unrelated but telling log, same minute:

```json
{
  "feature": "app-cache",
  "count": 1453,
  "refreshMs": 209,
  "refreshCount": 2131,
  "msg": "App cache refreshed: 1453 apps in 209ms"
}
```

---

## What We Know

1. **Leak is traffic-independent.** Two idle sessions, zero Mongo queries, zero WS disconnects in the current vitals window. Still ~18MB/hour growth over 17h45m.
2. **Leak is outside UserSession.** Census walks UserSession-owned maps and reports 6KB total. The 429MB heap is ~99.999% unaccounted.
3. **Everything in heap is reachable.** Forced `Bun.gc(true)` at 453MB freed 0MB. There is no garbage to collect; everything is live from some root.
4. **Heap is dominated by generic types.** 3M `Object` + 2.67M `string` + 188K `Array` + 49K `Function` + 29K `UnlinkedFunctionExecutable`. These are the shapes V8/JSC uses for everything — not diagnostic on their own, but consistent with large retained object graphs (JSON results, parsed documents, callback closures) rather than raw buffers (`Uint8Array` only 12,654).
5. **`disposedSessionsPendingGC: 3`.** Three sessions had `dispose()` called but are still reachable. Some strong reference somewhere is preventing collection. Small absolute number but a clear signal of a reference leak class.
6. **App cache is a heavy background process.** 1,453 apps loaded per refresh, refresh #2,131 (~every 30s for 17h). If the cache retains references between refreshes, the leak math is enormous: `1,453 × avg_app_doc_size × historical_versions_retained`.
7. **External memory is only 38MB.** So the leak is in the managed JS heap, not in native buffers (would appear in `external` or `arrayBuffers`).

---

## What We Don't Know

- **Which root holds the 400+ MB.** Could be one big owner or the sum of many.
- **Whether app-cache is the leak or is constant.** 1,453 docs × ~100KB each ≈ 145MB in heap at steady state. If this is flat, it's not a _leak_; it's just cost. If it grows with each refresh, it is.
- **Whether Mongoose internals retain.** Mongoose tracks document subscribers, connection pool buffers, possibly query plan caches.
- **Whether SDK clients (Soniox/Deepgram) retain buffers.** Each TranscriptionManager creates provider streams; closed streams might leave buffers reachable if a reference remains.
- **Whether the leak is in Pino/logtail transport buffers.** Async log buffers queue messages; if flush never succeeds (or backpressure holds references), messages pile up.
- **Whether bun-specific internals hold references longer than expected.** Bun's JSC differs from V8 in GC timing and closure retention edge cases.
- **Whether `disposedSessionsPendingGC` is the whole story or a small tip.** 3 sessions could be 3MB or 300MB depending on what they hold.

---

## Candidate Causes (not yet tested)

Ranked by plausibility given the evidence:

### 1. App cache retention between refreshes

`AppCache.ts` loads 1,453 app documents every ~30s. If old document objects are still reachable (e.g., old handler closures, event listeners, module references), each refresh accumulates. Over 2,131 refreshes at even 1% retention per cycle, you'd accumulate 30× the baseline over 17 hours.

**To test**: grep AppCache for `Map<>` / `Array<>` fields that grow; check whether the old snapshot is fully released on refresh; add an owner entry in memory census for the cache.

### 2. Mongoose document/plugin retention

Mongoose's internal change-tracking and plugins can retain document references. The `slowQueryPlugin` in `mongodb.connection.ts` attaches pre/post hooks to every query; if the hook closures capture something, they retain it.

**To test**: disable the slow-query plugin temporarily on dev; observe whether heap growth slows. Check Mongoose docs + source for internal caches.

### 3. Soniox SDK client retained state

Each session uses `SonioxClient` / transcription streams. Failed reconnects, closed-but-not-cleaned streams, or the SDK's internal retry state could leak. At 2,131 app-cache refreshes but only 1 active transcription stream, this isn't the dominant leak but could contribute.

**To test**: audit `TranscriptionManager.dispose()` / translation cleanup paths for retained callbacks; instrument Soniox/Deepgram SDK client lifecycle.

### 4. Disposed-but-referenced UserSession chain

`disposedSessionsPendingGC: 3` says three old sessions are still reachable. If each retains its managers, audio buffers, and per-session caches, three leaked sessions could be 10-30 MB by themselves. Not the whole 400MB but a measurable fraction.

**To test**: extend `MemoryLeakDetector` to record which root path is keeping each disposed session alive (heap-snapshot path or instrumented reference-holding).

### 5. Pino / logtail transport buffer

If the remote log endpoint is slow/flaky, pino's async buffer holds messages. Each message is small but millions × hundreds of bytes adds up.

**To test**: check pino transport queue depth; temporarily log to stdout only on dev and re-observe growth rate.

### 6. Dashboard / calendar / notification poll state

Dashboard mini-app (per architecture doc) is separate process but cloud has `DashboardManager` per session. Calendar events are an observed owner (3,986 bytes / 23 items in census). These are small per-session and capped, so unlikely primary cause.

---

## Recommendation

Two-step investigation (Phase 1 data-gathering):

1. **Extend memory census to cover the likely blind spots.** Add owner entries for:
   - App cache map size (`app-cache.documents`, `app-cache.subscribers`)
   - Mongoose document cache if accessible
   - Pino transport buffer depth if accessible
   - Any module-level Maps/Sets holding per-user or per-app data

   This is a small PR (~50 lines across 2-3 files). Doesn't fix anything, but the next 17-hour dev sample will show _which owner_ is growing.

2. **Enable heap snapshot on signal.** Add a SIGUSR1 handler that writes a heap snapshot (`bun:jsc.heapStats()` + `writeHeapSnapshot` if available) to a known path. Operators can SIGUSR1 the dev pod when heap hits 600MB, load the snapshot in Chrome DevTools, and see the retention graph directly.

   Larger PR (~100 lines, needs testing against actual Bun snapshot format) but gives us ground truth.

Step 1 alone probably narrows the cause. Step 2 confirms.

**Explicitly NOT in scope for this spike:**

- Any fix. Need to know the cause first.
- Changes to UserSession ownership. The leak is outside it.
- Changes to GC behavior / heap limits. Treats symptom; leaves root cause.
- Consolidation with issue 102. They are separate problems.

---

## Key Numbers

| Metric                      | Current (dev, 17h45m, 2 sessions) | What we need                                   |
| --------------------------- | --------------------------------- | ---------------------------------------------- |
| Heap used                   | 429 MB                            | Expected ~80-150 MB at steady idle             |
| Session-tracked memory      | 6 KB                              | —                                              |
| Census blind-spot ratio     | ~69,000×                          | Want <2× (census within a factor of 2 of heap) |
| Growth rate at idle         | ~18 MB/hour                       | Want <1 MB/hour                                |
| `disposedSessionsPendingGC` | 3                                 | Want 0                                         |
| Objects in heap             | 7.66M                             | —                                              |
| Forced GC freed             | 0 MB                              | Want freed > 0 when heap is large              |

---

## Evidence Index

Re-capture the sample:

```bash
doppler run --project mentra-sre --config dev -- \
  bun cloud/tools/bstack/bstack.ts sql "
SELECT dt,
       JSONExtract(raw,'heapUsedMB','Nullable(Float64)') AS heap_mb,
       JSONExtract(raw,'rssMB','Nullable(Float64)') AS rss_mb,
       JSONExtract(raw,'activeSessions','Nullable(Int32)') AS sessions,
       JSONExtract(raw,'memoryEstimatedSessionBytes','Nullable(Int64)') AS census_bytes,
       JSONExtract(raw,'heapObjectCount','Nullable(Int64)') AS heap_obj_count,
       JSONExtract(raw,'disposedSessionsPendingGC','Nullable(Int32)') AS pending_gc,
       JSONExtract(raw,'uptimeSeconds','Nullable(Int32)') AS uptime_s
FROM remote(t373499_augmentos_logs)
WHERE dt >= now() - INTERVAL 1 HOUR
  AND JSONExtract(raw,'region','Nullable(String)')='us-central-dev'
  AND JSONExtract(raw,'feature','Nullable(String)')='system-vitals'
ORDER BY dt DESC
LIMIT 20"
```

Heap growth rate over time:

```bash
doppler run --project mentra-sre --config dev -- \
  bun cloud/tools/bstack/bstack.ts sql "
SELECT toStartOfInterval(dt, INTERVAL 15 MINUTE) AS bucket,
       round(avg(JSONExtract(raw,'heapUsedMB','Nullable(Float64)')), 0) AS heap_mb,
       round(avg(JSONExtract(raw,'rssMB','Nullable(Float64)')), 0) AS rss_mb,
       round(avg(JSONExtract(raw,'activeSessions','Nullable(Int32)')), 0) AS sessions
FROM s3Cluster(primary, t373499_augmentos_s3)
WHERE _row_type=1
  AND dt >= now() - INTERVAL 24 HOUR
  AND JSONExtract(raw,'region','Nullable(String)')='us-central-dev'
  AND JSONExtract(raw,'feature','Nullable(String)')='system-vitals'
GROUP BY bucket
ORDER BY bucket"
```

App cache refresh pattern:

```bash
doppler run --project mentra-sre --config dev -- \
  bun cloud/tools/bstack/bstack.ts sql "
SELECT dt,
       JSONExtract(raw,'count','Nullable(Int32)') AS app_count,
       JSONExtract(raw,'refreshMs','Nullable(Float64)') AS refresh_ms,
       JSONExtract(raw,'refreshCount','Nullable(Int32)') AS refresh_count
FROM remote(t373499_augmentos_logs)
WHERE dt >= now() - INTERVAL 1 HOUR
  AND JSONExtract(raw,'region','Nullable(String)')='us-central-dev'
  AND JSONExtract(raw,'feature','Nullable(String)')='app-cache'
ORDER BY dt DESC
LIMIT 20"
```
