# Spec: Crash Diagnostics — GC Probing, Health Timing, and Hot Path Instrumentation

## Overview

**What this doc covers:** Exact specification for adding diagnostic instrumentation to the cloud server — a GC probe that measures garbage collection pause duration, health check timing, Soniox call timing, connection counting, and session disconnect cleanup measurement. All data flows through Pino to BetterStack.
**Why this doc exists:** Cloud-prod crashes ~6-7 times/day across all regions. The 057 memory leak fixes reduced `disposedSessionsPendingGC` from 245 to 0-1 but did NOT reduce crash frequency. We have multiple theories about why pods become unresponsive (GC thrashing, Soniox blocking, event loop saturation from audio processing, MongoDB latency) but no data to distinguish between them. This spec adds the instrumentation to answer those questions definitively.
**What you need to know first:** [061 spike](./spike.md) for crash investigation findings, [057 design](../057-cloud-observability/design.md) for existing observability infrastructure.
**Who should read this:** Anyone reviewing the hotfix PR.

## The Problem in 30 Seconds

Pods crash when `/health` can't respond within the liveness probe timeout (1s × 15 consecutive failures = 75s unresponsive → SIGKILL). We don't know WHY the event loop becomes unresponsive. It could be GC pauses, Soniox WebSocket I/O, audio processing, MongoDB queries, or something else entirely. We're guessing. This spec adds timing instrumentation to every suspect so the next crash gives us the answer.

## Spec

### A1. GC Probe — periodic forced GC with timing

**File:** `packages/cloud/src/services/metrics/SystemVitalsLogger.ts`

**What:** Every 60 seconds, call `Bun.gc(true)`, measure how long it takes, log the result with memory before/after.

**Why:** `Bun.gc(true)` is synchronous — it blocks the event loop for the duration of the collection. By timing it, we know exactly how much GC contributes to event loop blocking. If pauses are <10ms, GC is not the problem. If they're >100ms and climbing, it is.

**Log format:**

```json
{
  "feature": "gc-probe",
  "level": "info",
  "gcDurationMs": 23.4,
  "heapBeforeMB": 245,
  "heapAfterMB": 198,
  "freedMB": 47,
  "rssMB": 612,
  "externalMB": 95,
  "arrayBuffersMB": 42,
  "activeSessions": 65
}
```

**Frequency:** Every 60 seconds, offset from the existing 30s vitals tick (so they don't overlap). Use a separate `setInterval`.

**Important:** Store the interval handle and clear it in a cleanup method, same pattern as the ManagedStreamingExtension fix from 057.

### A2. GC on Session Disconnect

**File:** `packages/cloud/src/services/session/UserSession.ts`

**What:** After `dispose()` completes, call `Bun.gc(true)` with timing. Log how long it took and how much was freed. Do NOT call it inside dispose — call it after dispose finishes, in a `setTimeout(0)` so it runs on the next tick after all cleanup is done.

**Why:** When a session disconnects, all its managers, WebSockets, buffers, and listeners should become garbage. If GC after disconnect frees significant memory, sessions are being properly cleaned up. If it frees nothing, the objects are still retained by something.

**Log format:**

```json
{
  "feature": "gc-after-disconnect",
  "level": "info",
  "userId": "user@example.com",
  "gcDurationMs": 15.2,
  "heapBeforeMB": 300,
  "heapAfterMB": 278,
  "freedMB": 22,
  "rssMB": 580,
  "sessionDurationSeconds": 3400
}
```

**Guard:** Only run if the session was fully initialized (has a userId). Don't GC on partial/failed sessions that never completed setup.

**Rate limit:** At most one GC-after-disconnect per 10 seconds. If multiple sessions disconnect within 10 seconds (e.g., during a crash cascade), only the first triggers GC. Otherwise we'd be forcing GC rapidly during the exact moment we need the event loop free.

### A3. Health Check Timing

**File:** `packages/cloud/src/hono-app.ts`

**What:** Wrap the entire `/health` endpoint handler in `performance.now()` timing. Log a warning if it takes >50ms.

**Why:** The liveness probe hits `/health` every 5 seconds with a 1s timeout. If the handler itself takes >50ms, something is slow (iterating sessions, computing metrics, serializing JSON). If it takes <5ms but the probe still fails, the event loop is blocked BEFORE the handler runs.

**Log format (only when slow):**

```json
{
  "feature": "health-timing",
  "level": "warn",
  "durationMs": 87.3,
  "activeSessions": 65,
  "message": "Health check slow: 87ms"
}
```

**Threshold:** Log at `warn` level when >50ms. Don't log anything when fast — this endpoint is hit every 5 seconds and we don't want to flood logs.

### A4. Soniox Call Timing

**File:** `packages/cloud/src/services/session/transcription/providers/SonioxSdkStream.ts`

**What:** Wrap the audio data send to Soniox in timing. Log a warning if any send takes >50ms.

**Why:** Soniox communication is over WebSocket. If the Soniox server is slow to accept data or if the TLS/WebSocket write blocks, this could be the thing blocking the event loop. Each session sends audio to Soniox ~50 times per second (20ms chunks), so even a brief block is amplified across 65 sessions.

**Log format (only when slow):**

```json
{
  "feature": "soniox-timing",
  "level": "warn",
  "durationMs": 120.5,
  "userId": "user@example.com",
  "message": "Soniox send slow: 120ms"
}
```

**Threshold:** Log at `warn` when >50ms. Don't log anything when fast.

**Rate limit:** At most one warning per user per 30 seconds. Soniox sends happen 50 times/second — if it's slow, we don't want 50 log lines per second per user.

### A5. Connection Count in System Vitals

**File:** `packages/cloud/src/services/metrics/SystemVitalsLogger.ts`

**What:** Add total connection counts to the existing 30-second vitals log. Count: glasses WebSockets, app WebSockets, and active Soniox streams.

**Why:** We track session count (65) but not connection count (~200-325). The crash might correlate with connection count more than session count. France crashes at 22 sessions — if each France session has more active connections (more apps, mic always on), the total connection count might be similar to US Central at crash time.

**Additional fields in existing `system-vitals` log:**

```json
{
  "feature": "system-vitals",
  "glassesWebSockets": 65,
  "appWebSockets": 130,
  "sonioxStreams": 38,
  "totalConnections": 233,
  "micActiveCount": 35
}
```

**How to count:**

- `glassesWebSockets`: iterate `UserSession.sessions`, count those with an active glasses WS
- `appWebSockets`: sum of `apps.websockets` across all sessions (already available from the session data)
- `sonioxStreams`: count sessions where transcription stream is active (mic enabled)
- `totalConnections`: sum of the above
- `micActiveCount`: count sessions with `microphone.enabled === true`

### A6. MongoDB Slow Query Detection

**What:** Enable Mongoose debug mode via an environment variable that logs queries exceeding a threshold.

**Where:** `packages/cloud/src/connections/mongodb.connection.ts`

**How:** Check for `MONGOOSE_SLOW_QUERY_MS` env var (default: not set = disabled). If set, use Mongoose's built-in profiling to log queries that exceed the threshold.

```typescript
const slowQueryMs = parseInt(process.env.MONGOOSE_SLOW_QUERY_MS || "0", 10);
if (slowQueryMs > 0) {
  mongoose.set("debug", (collectionName: string, method: string, query: any, doc: any, options: any) => {
    // Mongoose debug fires after query completes — we can't time it this way.
    // Instead, use Mongoose plugins or manual timing on key queries.
  });
}
```

**Actually:** Mongoose's `debug` mode doesn't include timing. Instead, add a simple Mongoose plugin that wraps `exec()` with `performance.now()` timing and logs slow queries through Pino.

**Log format:**

```json
{
  "feature": "slow-query",
  "level": "warn",
  "collection": "users",
  "operation": "findOne",
  "durationMs": 234,
  "message": "Slow MongoDB query: users.findOne 234ms"
}
```

**Threshold:** Configurable via `MONGOOSE_SLOW_QUERY_MS` env var. Recommended: `100` (log queries >100ms). Set to `0` or unset to disable.

**Add to Doppler:** `MONGOOSE_SLOW_QUERY_MS=100` in prod configs.

## What This Does NOT Include

| Explicitly out of scope                     | Why                                                                                                            |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Fixing any memory issues                    | This is diagnostic only — we need data before we can fix                                                       |
| Changing GC behavior or tuning              | No evidence yet that GC is the problem                                                                         |
| Changing liveness probe config              | Separate change, test independently                                                                            |
| Operation timing on audio/display hot paths | The `operationTimers` framework from 057 exists but wiring it to hot paths touches critical code. Separate PR. |
| Switching runtime to Node.js                | Major decision, needs its own investigation                                                                    |

## Decision Log

| Decision                                         | Alternatives considered                              | Why we chose this                                                                                                                                                    |
| ------------------------------------------------ | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 60s GC probe interval                            | 30s, 120s, on-demand only                            | 60s gives enough data points per crash cycle (60-120 data points over 1-2 hours) without adding excessive overhead. 30s would double the forced GC frequency.        |
| `Bun.gc(true)` (synchronous)                     | `Bun.gc(false)` (hint only)                          | We WANT to measure the worst-case pause. `false` is a hint that may not collect immediately, so we can't time it meaningfully.                                       |
| Rate-limited GC on disconnect (10s cooldown)     | GC on every disconnect, no GC on disconnect          | Every disconnect would thrash GC during crash cascades. No GC means we miss data on whether sessions are freed. 10s cooldown is a compromise.                        |
| 50ms threshold for slow warnings                 | 10ms, 100ms, 200ms                                   | 50ms is well below the 1s probe timeout but above normal operation (~1-5ms). Catches degradation early without noise.                                                |
| Soniox send timing (not receive)                 | Timing both send and receive, full round-trip        | Send is the blocking operation on our event loop. Receive is async (callback). Timing send tells us if our thread is blocked waiting for the WebSocket write buffer. |
| Log-based (Pino → BetterStack) not metrics-based | Prometheus counters, StatsD, custom metrics endpoint | We already have Pino → BetterStack flowing. Adding proper metrics requires Prometheus scrape annotations (not yet done). Logs get us data today.                     |

## Testing Plan

### On cloud-debug (before PR to main)

1. **GC probe logs appear** — search BetterStack for `feature: "gc-probe"` with server `cloud-debug`. Should appear every 60s.
2. **GC duration is reasonable** — values should be 1-50ms range on debug (low session count).
3. **Health timing doesn't flood** — with low load on debug, health check should be <5ms. No `health-timing` warnings should appear unless we artificially load it.
4. **Connect glasses, then disconnect** — search for `feature: "gc-after-disconnect"`. Should appear within a few seconds of disconnect. Check `freedMB` — should be >0 if session was properly cleaned up.
5. **Connection count appears in vitals** — search for `feature: "system-vitals"` and verify `glassesWebSockets`, `appWebSockets`, `sonioxStreams`, `totalConnections` fields are present.
6. **No performance regression** — event loop lag on debug should not increase compared to before the change.

### After PR to main (monitoring cloud-prod)

7. **GC probe at scale** — with 65 sessions, how long does `Bun.gc(true)` take? If >100ms, GC is a major contributor to event loop blocking.
8. **Correlate GC duration with crashes** — when a pod crashes, was the last GC probe showing escalating durations? (e.g., 20ms → 50ms → 150ms → crash)
9. **Health check slow before crash?** — do `health-timing` warnings appear in the minutes before a crash? If yes, the health handler itself is slow. If no warnings but the pod still dies, the event loop is blocked before the handler runs.
10. **Soniox blocking?** — do `soniox-timing` warnings appear? If they correlate with crash timing, Soniox is a contributor.
11. **MongoDB blocking?** — do `slow-query` warnings appear under load? If queries hit >100ms during peak sessions, DB I/O could be part of the problem.
12. **Connection count at crash** — what's `totalConnections` when the pod crashes? Does France crash at a similar total connection count to US Central despite fewer sessions?

### What "success" looks like

After one crash cycle (~2-3 hours) on prod, we'll know:

- Exact GC pause durations at every stage of the memory growth curve
- Whether `/health` itself is slow or the event loop is blocked before it runs
- Whether Soniox sends are blocking the event loop
- Whether MongoDB queries are slow under load
- Whether total connection count correlates with crashes more than session count

Every possible outcome gives us actionable data. There is no scenario where this instrumentation is useless.

## Implementation Notes

### Performance impact

- GC probe: one forced GC per 60 seconds. At <50ms, this is negligible. If GC is already causing problems, the forced GC is a drop in the ocean compared to the natural GC activity.
- Health timing: one `performance.now()` call per 5 seconds (probe interval). Negligible.
- Soniox timing: one `performance.now()` per audio send. `performance.now()` takes ~0.01ms. At 50 sends/second × 65 sessions = 3,250 calls/second. Total overhead: ~0.03ms/second. Negligible.
- Connection counting: one iteration over sessions map every 30 seconds. Already done for the existing vitals. Just adding more fields.
- MongoDB timing: one `performance.now()` wrapper per query. Negligible.

### Log volume

- GC probe: 1 log/60s = 1,440/day per pod. Negligible.
- GC after disconnect: at most 1 log/10s = 8,640/day per pod maximum, realistically much less.
- Health timing: only when slow (>50ms). Normally 0 logs. During degradation, maybe 1-10/minute.
- Soniox timing: only when slow (>50ms), rate-limited to 1 per user per 30s. Normally 0 logs.
- Connection count: 0 additional logs — added to existing vitals tick.
- MongoDB slow query: only when slow (>100ms). Normally 0 logs.

**Total additional volume: ~1,500 logs/day per pod** under normal conditions. Current volume is ~11M logs/day from cloud-prod. This adds 0.01%.
