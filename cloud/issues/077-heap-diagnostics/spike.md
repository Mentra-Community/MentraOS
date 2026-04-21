# Spike & Spec: Heap Diagnostics — Find What's Growing

**Issue:** 077
**Related:** [075-heap-fragmentation-hot-path](../075-heap-fragmentation-hot-path/), [074-sdk-v3-merge-and-ship](../074-sdk-v3-merge-and-ship/), [057-cloud-observability](../057-cloud-observability/)
**Status:** Spike + Spec
**Date:** 2026-04-01

---

## Problem

The cloud's heap grows ~300MB/hour with stable session count. We've fixed timer leaks (issue 074, PR #2377) and tried reducing hot-path allocation churn (issue 075, PR #2389). Neither stopped the growth. GC frees 0MB on every probe — the growing objects are reachable, not garbage.

**We know memory is growing. We don't know WHAT is growing.**

The missing observability: we can see `heapUsedMB` climbing in system-vitals, but we can't see which object types are accumulating. We're guessing instead of measuring.

---

## What We Have vs What We Need

### Current tools (what we have)

| Tool | What it tells us | Limitation |
|------|-----------------|------------|
| `process.memoryUsage()` | RSS, heap, external as numbers (logged every 30s) | Tells us memory IS growing, not WHAT is growing |
| `Bun.generateHeapSnapshot()` | JSC-format JSON (~170MB) | OOM risk (doubles memory), slow Python analysis, no comparison view |
| `MemoryLeakDetector` + `FinalizationRegistry` | Whether disposed objects get GC'd | Only useful for objects we explicitly track (UserSession). Doesn't help with live objects growing. |
| `gc-probe` (forced GC every 60s) | GC duration, freed MB | Confirms GC frees 0MB. Doesn't say why. |

### New tools (what Bun provides that we're not using)

| Tool | What it tells us | Cost |
|------|-----------------|------|
| `heapStats()` from `bun:jsc` | `objectTypeCounts`: exact count of every object type in the heap (Array, Object, Function, Promise, Map, Set, etc.) | ~1ms, zero memory overhead, safe to call every 30-60s |
| `heapStats().protectedObjectTypeCounts` | Objects that GC cannot collect (active timers, signals, pending I/O) | Same call as above |
| `writeHeapSnapshot()` from `v8` | V8-compatible `.heapsnapshot` file loadable in Chrome DevTools Memory tab | ~2x memory spike (same risk as current), but the output supports Chrome's **Comparison** view |

### The key gap

`heapStats().objectTypeCounts` is the missing piece. If we logged it every 30-60 seconds, we'd see:

```
Hour 0: { Array: 50000, Object: 80000, Function: 20000, Map: 3000 }
Hour 1: { Array: 150000, Object: 80000, Function: 20000, Map: 3000 }
```

Immediately: "Arrays tripled in an hour — something is pushing to arrays and not cleaning up." Instead of guessing for 8 hours about fragmentation vs allocation churn vs runtime bugs.

### Chrome DevTools Comparison view

The `writeHeapSnapshot()` from `v8` module (which Bun implements) produces `.heapsnapshot` files that Chrome DevTools can compare:

1. Take snapshot A at time T
2. Take snapshot B at time T+30min
3. Load both in Chrome DevTools → Memory tab → select B → click "Comparison"
4. DevTools shows a **Delta** column: which objects increased, by how many, and their retainer chains

This is orders of magnitude more useful than our current Python script that just counts class names. The Delta + retainer chain tells us exactly what's growing and what's holding it alive.

---

## Spec

### Change 1: Add `heapStats()` to SystemVitalsLogger (the main fix)

**File:** `cloud/packages/cloud/src/services/metrics/SystemVitalsLogger.ts`

Every 30 seconds, the SystemVitalsLogger already logs `system-vitals` with RSS, heap, sessions, etc. Add `objectTypeCounts` from `heapStats()` to this log entry.

```typescript
import { heapStats } from "bun:jsc";

// Inside logVitals():
const jscStats = heapStats();

// Log the top object types by count (don't log all ~400 types — just top 20)
const topTypes = Object.entries(jscStats.objectTypeCounts)
  .sort((a, b) => (b[1] as number) - (a[1] as number))
  .slice(0, 20)
  .reduce((acc, [k, v]) => { acc[k] = v; return acc; }, {} as Record<string, number>);

// Add to the existing system-vitals log entry:
{
  feature: "system-vitals",
  // ... existing fields ...
  heapObjectCount: jscStats.objectCount,
  heapProtectedObjectCount: jscStats.protectedObjectCount,
  topObjectTypes: JSON.stringify(topTypes),
  protectedTypes: JSON.stringify(jscStats.protectedObjectTypeCounts),
}
```

**Why top 20:** The full `objectTypeCounts` has ~400 types. Logging all of them every 30s would bloat our BetterStack volume. The top 20 captures the dominant types — if something is leaking, it'll be in the top 20 because it's growing fast.

**Why JSON.stringify:** BetterStack stores logs as a JSON `raw` field. Nested objects inside the log entry work, but flat stringified objects are easier to query with `JSONExtract`.

**Queryability:** After deploying, we can find what's growing:

```sql
SELECT
  toStartOfHour(dt) AS hour,
  JSONExtractString(raw, 'topObjectTypes') AS types
FROM s3Cluster(primary, t373499_mentracloud_prod_s3)
WHERE _row_type = 1
  AND JSONExtractString(raw, 'feature') = 'system-vitals'
  AND JSONExtractString(raw, 'region') = 'us-central'
  AND dt > now() - INTERVAL 6 HOUR
ORDER BY dt ASC
LIMIT 1 BY hour
```

Or via bstack:

```bash
bstack sql "SELECT dt, JSONExtractInt(raw, 'heapObjectCount') as objects FROM ..."
```

### Change 2: Add V8 heap snapshot endpoint

**File:** `cloud/packages/cloud/src/api/hono/routes/admin.routes.ts`

Add a new endpoint alongside the existing JSC one:

```typescript
import { writeHeapSnapshot } from "v8";

app.get("/memory/heap-snapshot-v8", validateAdminEmail, async (c: AppContext) => {
  try {
    const filename = `heap-${Date.now()}.heapsnapshot`;
    const filePath = path.join(os.tmpdir(), filename);

    writeHeapSnapshot(filePath);

    // Stream the file back and delete it after
    const file = Bun.file(filePath);
    const response = new Response(file, {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });

    // Clean up after response is sent
    setTimeout(() => fs.unlinkSync(filePath), 5000);

    return response;
  } catch (error) {
    logger.error(error, "Failed to generate V8 heap snapshot");
    return c.json({ error: "Failed to generate heap snapshot" }, 500);
  }
});
```

**Usage for comparison:**

```bash
# Take snapshot A
curl -H "Authorization: Bearer $JWT" \
  "https://uscentralapi.mentra.glass/api/admin/memory/heap-snapshot-v8" \
  -o snapshot-a.heapsnapshot

# Wait 30 minutes

# Take snapshot B
curl -H "Authorization: Bearer $JWT" \
  "https://uscentralapi.mentra.glass/api/admin/memory/heap-snapshot-v8" \
  -o snapshot-b.heapsnapshot

# Load both in Chrome DevTools → Memory tab → Comparison
```

**WARNING:** Same OOM risk as the current JSC snapshot — doubles memory temporarily. Only use on low-traffic regions or right after a restart when memory is low. Consider adding a memory guard:

```typescript
const rss = process.memoryUsage.rss();
if (rss > 2 * 1024 * 1024 * 1024) { // > 2GB
  return c.json({ error: "RSS too high for safe snapshot. Try after a restart." }, 503);
}
```

### Change 3: Add `heapStats` to the admin memory/now endpoint

**File:** `cloud/packages/cloud/src/api/hono/routes/admin.routes.ts`

Add `objectTypeCounts` to the existing `/api/admin/memory/now` response so `bstack session` and `analyze-heap.ts live` can show it:

```typescript
import { heapStats } from "bun:jsc";

// In getMemorySnapshot handler, add to the response:
const jscStats = heapStats();

return c.json({
  // ... existing fields ...
  jsc: {
    objectCount: jscStats.objectCount,
    protectedObjectCount: jscStats.protectedObjectCount,
    topObjectTypes: Object.entries(jscStats.objectTypeCounts)
      .sort((a, b) => (b[1] as number) - (a[1] as number))
      .slice(0, 30),
    protectedTypes: jscStats.protectedObjectTypeCounts,
  },
});
```

### Change 4: Add `bstack heap-types` command

**File:** `cloud/tools/bstack/bstack.ts`

New command that queries the `topObjectTypes` field from system-vitals over time:

```bash
bstack heap-types --region us-central --duration 2h
```

Output:

```
🧠 Heap Object Types — us-central (last 2 HOUR)

hour        │ objects   │ Array    │ Object  │ Function │ string  │ Map    │ Set
────────────┼───────────┼──────────┼─────────┼──────────┼─────────┼────────┼──────
18:00       │ 450,000   │ 85,000   │ 120,000 │ 45,000   │ 95,000  │ 8,000  │ 2,000
19:00       │ 850,000   │ 285,000  │ 120,500 │ 45,200   │ 195,000 │ 8,100  │ 2,000

  ⚠️ Array: +200,000 (+235%) — investigate what's pushing to arrays
  ⚠️ string: +100,000 (+105%) — string accumulation (logging? transcript history?)
```

The command parses the `topObjectTypes` JSON string from the logs and shows growth over time, highlighting any type that grew >50%.

---

## What This Tells Us That We Can't See Today

### Scenario A: Array/Object accumulation

If we see `Array` count climbing 10x, we know something is appending to arrays without cleanup. Cross-reference with the code: which arrays in the session code grow without bounds? The transcript history is capped at 30 min, but maybe the pruning isn't working, or maybe there's a different array.

### Scenario B: Function/closure accumulation

If `Function` count climbs, closures are being created and not released. This points to event listeners, `.bind()` calls, or `logger.child()` creating closure chains. The Bun blog specifically calls out closures and `JSLexicalScope` objects as a common leak source.

### Scenario C: Map/Set accumulation

If `Map` or `Set` counts climb, some Map or Set in the code is getting entries added but never removed. We have Maps everywhere — `AppManager.apps`, `UserSession.sessions`, subscription maps, etc.

### Scenario D: String accumulation

If `string` count climbs, we're creating and retaining strings. Template literals in hot paths, log message construction, JSON.stringify results being held somewhere.

### Scenario E: Promise accumulation

If `Promise` count climbs, we have promises that never resolve or reject. The Bun blog specifically calls this out. Our webhook retry logic, Soniox connection timeouts, and async operations could leave dangling promises.

### Scenario F: Everything proportional to sessions

If all types scale with session count and stay flat when sessions are flat — then the growth IS genuinely coming from session initialization and Bun's inability to compact. In that case, we need the Chrome DevTools comparison to find the retainer chain.

---

## Implementation Plan

### Phase 1: Add heapStats to system-vitals (highest priority)

1. Add `heapStats()` call in SystemVitalsLogger
2. Log top 20 object types + protected types every 30s
3. Deploy to one region first (US West — 0 sessions, safe)
4. Verify the data appears in BetterStack
5. Deploy to all regions
6. **Wait 2-4 hours** and query the data to see what's growing

**Effort:** 30 minutes. **Risk:** Zero — `heapStats()` is ~1ms and doesn't affect the heap.

### Phase 2: Add V8 snapshot endpoint

1. Add `/api/admin/memory/heap-snapshot-v8` endpoint with memory guard
2. Update `analyze-heap.ts` to use the V8 endpoint
3. Test on a low-traffic region

**Effort:** 30 minutes. **Risk:** Low (OOM-guarded).

### Phase 3: Add bstack heap-types command

1. Parse `topObjectTypes` from system-vitals logs
2. Show growth over time with warnings for fast-growing types

**Effort:** 1 hour.

### Phase 4: Identify and fix the leak

Once we see which types are growing, fix the specific code that's accumulating them. The fix depends entirely on what the data shows — could be a one-liner, could be an architectural change.

---

## Open Questions

| # | Question | Notes |
|---|----------|-------|
| 1 | Does `heapStats()` include objects from Soniox SDK? | It should — all JS objects on the heap regardless of which module created them. |
| 2 | Does `protectedObjectTypeCounts` overlap with `disposedSessionsPendingGC`? | No — protected objects are GC roots (timers, active I/O). `disposedSessionsPendingGC` tracks objects we've disposed but GC hasn't collected yet. Different concepts. |
| 3 | Can `writeHeapSnapshot()` from `v8` module be streamed instead of written to disk? | Not sure. If so, we could pipe directly to the HTTP response without temp file. |
| 4 | Is there a way to get retainer info without a full snapshot? | `heapStats()` doesn't provide retainers. For that we need the Chrome DevTools comparison. But knowing WHICH type is growing narrows the search to a few code files. |
| 5 | Should we log `heapStats` less frequently than system-vitals? | 30s might be too frequent if the JSON is large. Could log every 5 minutes instead, or only log the delta from the previous reading. |