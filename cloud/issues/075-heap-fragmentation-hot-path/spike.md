# Spike: Heap Fragmentation & Hot Path Allocation Reduction

**Issue:** 075
**Related:** [074-sdk-v3-merge-and-ship](../074-sdk-v3-merge-and-ship/), [057-cloud-observability](../057-cloud-observability/), [067-heap-growth-investigation](../067-heap-growth-investigation/)
**Status:** Spike
**Date:** 2026-03-31

---

## Overview

**What this doc covers:** Investigation of monotonic heap growth on production clouds even after the timer leak hotfix (074). The heap grows ~50MB/hour with stable session count, GC frees 0MB on every probe, and pods eventually OOM. Root cause analysis points to JSC heap fragmentation from high-frequency temporary object allocation on the transcription hot path.

**Why this matters:** US Central crashed twice on March 31 (OOM at 9:46 AM, non-zero exit at 1:37 PM). France crashed the day before at 1465MB RSS with 28 sessions. The timer leak hotfix (PR #2377) fixed phantom sessions (`disposedSessionsPendingGC` dropped from 5+ to 0.3), but heap still grows because of allocation churn causing heap page fragmentation in Bun's JSC engine.

**Key insight:** JSC (Bun's JS engine) does NOT compact the old-generation heap like V8 (Node.js) does. When objects are allocated and freed rapidly, the freed space becomes scattered fragments that can't be reused for differently-sized allocations. The heap only grows, never shrinks. The fix isn't better GC — it's **not creating the garbage in the first place**.

---

## Evidence

### Timer Hotfix Is Working

Post-hotfix (PR #2377, deployed ~16:00 UTC March 31):

| Metric | Before hotfix | After hotfix |
|--------|--------------|--------------|
| `disposedSessionsPendingGC` | 5-6, climbing | 0.2-0.3, stable |
| Sessions finalized by GC | Some stuck for 10+ hours | All finalized promptly |
| MemoryLeakDetector warnings | 9 "Potential leak" in 16 hours | 0 |

**The timer fix is confirmed working.** Phantom sessions are no longer pinned.

### But Heap Still Grows

US Central, March 31, post-hotfix (20:40 restart → 22:30):

| Time | Heap | Sessions | MB/session |
|------|------|----------|-----------|
| 20:40 | 80MB | 17 | 4.7 |
| 21:00 | 111MB | 33 | 3.4 |
| 21:30 | 243MB | 49 | 5.0 |
| 22:00 | 370MB | 53 | 7.0 |
| 22:30 | 550MB | 61 | 9.0 |

Sessions stabilized at ~55-60 by 21:30, but heap grew from 243 → 550MB (+307MB) in one hour with flat session count. **MB per session increases over time** — the hallmark of fragmentation, not a code leak.

### GC Frees 0MB Consistently

Every GC probe on March 31 (all hours, all regions) reports `freedMB = 0`. GC IS running (probe durations 50-160ms), objects ARE being collected (MemoryLeakDetector confirms finalization), but `heapUsed` doesn't decrease. This means freed space is scattered across heap pages in unusable fragments.

### External/ArrayBuffer Memory Is Stable

| Component | Behavior | Conclusion |
|-----------|----------|-----------|
| Heap | 80MB → 550MB in 2 hours | Growing — fragmentation |
| External | 44MB → 77MB (tracks session count) | Stable per session |
| ArrayBuffers | 13MB → 29MB (tracks session count) | Stable per session |

The growth is entirely in the JS heap, not in native memory or buffers.

---

## Root Cause: JSC Heap Fragmentation

### How Bun/JSC GC Works

1. **Nursery (young generation):** Bump allocator + copying collector. New objects go here. Survivors get copied (compacted) to old generation. This part IS compacting.

2. **Old generation:** Mark-sweep with free lists. Long-lived objects go here. When GC collects dead objects, the freed space goes on a free list. New allocations check the free list, but if nothing fits (different size), heap extends.

3. **No old-gen compaction:** Unlike V8's Mark-Compact, JSC never slides old-gen objects together to eliminate gaps. Freed space stays fragmented forever. Heap size only goes up.

### Why Our Code Triggers This

The transcription hot path creates and discards thousands of temporary objects per second:

**Per transcription result, per subscribed app (fires ~250 times/second across all users):**

| Allocation | Size | Source |
|-----------|------|--------|
| `effectiveSubscription` string | ~30 bytes | Template literal: `` `${streamType}:${language}` `` |
| `DataStream` object literal | ~200 bytes | `{ type, sessionId, streamType, data, timestamp }` |
| `new Date()` | ~50 bytes | Timestamp in DataStream |
| `JSON.stringify()` result | ~500 bytes | Serializing DataStream for WebSocket send |
| Logger debug object | ~300 bytes | `{ subscription, effectiveSubscription, subscribedApps, ... }` — created even when debug is off |
| `AppMessageResult` object | ~50 bytes | Return value from `sendMessageToApp` |
| Logger debug in sendMessageToApp | ~200 bytes | Another object literal for the log call |
| **Total per result per app** | **~1.3KB** | |

**At scale:** 25 Soniox streams × ~5 results/sec × 2 apps/user = 250 results/sec × 1.3KB = **325KB/sec of garbage = ~1.1GB/hour of allocation churn**.

Every one of these allocations:
1. Goes into the nursery
2. Most die immediately and are collected in the next minor GC
3. Some get promoted to old-gen (if they survive a GC cycle boundary)
4. Promoted objects that later die leave holes in old-gen heap pages
5. Over hours, old-gen is full of holes

---

## The Fix: Reduce Allocation on Hot Paths

### Principle

If we reuse the same objects instead of creating new ones, there's nothing to allocate, nothing to collect, no fragmentation. The hot path should allocate **zero** new objects per message.

### Fix 1: Pre-allocate reusable DataStream template per session

**File:** `TranscriptionManager.ts`

Current (creates new object every relay):
```typescript
const dataStream: DataStream = {
  type: CloudToAppMessageType.DATA_STREAM,
  sessionId: appSessionId,
  streamType: effectiveSubscription,
  data,
  timestamp: new Date(),
};
```

Fixed (mutate pre-allocated template):
```typescript
// In constructor, create once:
private _dataStreamTemplate: DataStream = {
  type: CloudToAppMessageType.DATA_STREAM,
  sessionId: "",
  streamType: "" as ExtendedStreamType,
  data: null,
  timestamp: 0 as any,
};

// In relayDataToApps, mutate:
this._dataStreamTemplate.sessionId = appSessionId;
this._dataStreamTemplate.streamType = appSubscription || effectiveSubscription;
this._dataStreamTemplate.data = data;
this._dataStreamTemplate.timestamp = Date.now(); // number, not new Date()
websocket.send(JSON.stringify(this._dataStreamTemplate));
```

**Saves:** ~250 bytes/result × 250 results/sec = ~62KB/sec = **~224MB/hour less garbage**

### Fix 2: Guard logger calls with level check

**Files:** All hot-path files (TranscriptionManager, AppManager, SubscriptionManager)

Current (object created even when debug is off):
```typescript
this.logger.debug({ subscription, effectiveSubscription, subscribedApps, ... }, "Broadcasting");
```

Fixed (skip object creation entirely):
```typescript
if (this.logger.isLevelEnabled('debug')) {
  this.logger.debug({ subscription, effectiveSubscription, subscribedApps, ... }, "Broadcasting");
}
```

Pino evaluates the level AFTER creating the argument objects. By guarding with `isLevelEnabled`, the object literal is never constructed when debug logging is off (which it is in production).

**Saves:** ~500 bytes/result × 250 results/sec = ~125KB/sec = **~450MB/hour less garbage**

### Fix 3: Cache effectiveSubscription strings per stream

**File:** `TranscriptionManager.ts`

Current (concatenates on every result):
```typescript
effectiveSubscription = `${streamType}:${data.transcribeLanguage}`;
```

Fixed (cache per stream, recompute only on language change):
```typescript
// On stream creation:
stream._cachedEffectiveSubscription = `${streamType}:${language}`;

// In relayDataToApps:
const effectiveSubscription = stream._cachedEffectiveSubscription;
```

**Saves:** ~30 bytes/result — small individually but eliminates string interning pressure.

### Fix 4: Use Date.now() instead of new Date() on hot paths

**Files:** TranscriptionManager, TranslationManager, AppManager relay paths

Current:
```typescript
timestamp: new Date(),
```

Fixed:
```typescript
timestamp: Date.now(),
```

`Date.now()` returns a number (no heap allocation). `new Date()` creates a heap object (~50 bytes). The SDK and logging don't need the Date object — they serialize it to a number or ISO string anyway.

**Saves:** ~50 bytes/result × 250 results/sec = ~12KB/sec = **~44MB/hour less garbage**

### Fix 5: Pre-allocate AppMessageResult

**File:** `AppManager.ts`

Current (new object per send):
```typescript
return { sent: true, resurrectionTriggered: false };
```

Fixed (reusable constants):
```typescript
// Module-level constants:
const SEND_SUCCESS: AppMessageResult = Object.freeze({ sent: true, resurrectionTriggered: false });
const SEND_FAIL_STOPPING: AppMessageResult = Object.freeze({ sent: false, resurrectionTriggered: false, error: "App is being stopped" });
// etc.

// In sendMessageToApp:
return SEND_SUCCESS;
```

**Saves:** ~50 bytes/send — small but removes allocation from the tightest loop.

### Fix 6: TranslationManager same patterns

Apply fixes 1-5 to `TranslationManager.relayDataToApps()` — same hot path, same allocation patterns. Translation has fewer streams but each result is larger.

---

## Expected Impact

| Fix | Garbage reduction | Effort |
|-----|-------------------|--------|
| Pre-allocate DataStream template | ~224MB/hour | 30 min |
| Guard logger with level check | ~450MB/hour | 1 hour (many call sites) |
| Cache effectiveSubscription | Small | 15 min |
| Date.now() instead of new Date() | ~44MB/hour | 15 min |
| Pre-allocate AppMessageResult | Small | 15 min |
| TranslationManager same fixes | ~50MB/hour | 30 min |
| **Total** | **~770MB/hour less garbage** | **~3 hours** |

Current garbage rate: ~1.1GB/hour → reduced to ~330MB/hour. Heap growth rate should slow from ~50MB/hour to ~15MB/hour (fragmentation still happens with 330MB/hour, just slower).

This should extend pod lifetime from ~6 hours before OOM to ~20+ hours — enough that daily low-traffic restarts keep memory in check.

---

## Future: Bun/JSC Compaction PR

Even with allocation reduction, some fragmentation is inevitable. A real fix would be old-generation compaction in JSC. Possible Bun contributions:

1. **File a Bun issue with our data** — monotonic heap growth, 0MB freed, heap snapshot evidence. Ask if there's a GC tuning flag or an existing compaction path we're missing.

2. **`Bun.gc({ compact: true })` API** — trigger JSC's `FullCollection` with aggressive sweep, or call `heap.sweepSynchronously()` which might reclaim more than incremental.

3. **madvise(MADV_DONTNEED) on freed heap pages** — even without compaction, return physical memory to OS for pages that are entirely free. This is what jemalloc `purge` does.

4. **Full old-gen compaction in JSC** — the real fix, but months of work for experienced GC engineers. Would be a WebKit contribution, not just Bun.

We should start with #1 (issue with data) and #2 (API) after shipping the hot-path optimizations.

---

## Plan

### Phase 1: Hot-path optimization hotfix

1. Branch off main
2. Implement fixes 1-5 in TranscriptionManager, TranslationManager, AppManager
3. Deploy to US West (0 sessions, safe to test)
4. Verify build works, no functional regressions
5. Then deploy to US Central, monitor heap growth rate
6. If growth rate drops significantly, merge to main

### Phase 2: Prove the theory

1. Compare heap growth rate before and after hotfix
2. If growth drops from ~50MB/hour to <20MB/hour, fragmentation confirmed
3. Document the evidence for a Bun issue

### Phase 3: Bun contribution

1. File issue on github.com/oven-sh/bun with our data
2. Propose `Bun.gc({ compact: true })` API
3. If accepted, implement and PR

---

## Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | Does JSC have any existing compaction for old-gen? | Need to read WebKit source. There might be a flag we're missing. |
| 2 | Would a periodic `Bun.gc(true)` help? | We removed forced GC in issue 066 because it freed 0MB. But that was before the timer fix — maybe now it would help? |
| 3 | Are Soniox SDK internals also creating garbage? | We can't optimize third-party code, but we could profile it. |
| 4 | Should we pool JSON.stringify buffers? | Bun's `ws.send()` might accept pre-serialized buffers. Could cache the JSON string if the same message goes to multiple apps. |
| 5 | Is `Object.freeze()` on result constants safe? | Should be — the objects are simple, no nested mutation needed. But verify Bun doesn't have a bug with frozen objects in hot loops. |