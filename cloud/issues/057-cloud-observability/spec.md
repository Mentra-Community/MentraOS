# Spec: Cloud Stability Hotfix — Memory Leak Fixes + Observability

## Overview

**What this doc covers:** Exact specification for the `hotfix/cloud-observability` branch — 5 memory leak / correctness fixes, 3 observability additions, and the deploy workflow change to test on `cloud-debug` before merging to `main`.
**Why this doc exists:** Cloud-prod has crashed 75 times in 8 days (69 incidents caught by BetterStack Uptime since Feb 18). The spike investigation (055/056) found 3 confirmed memory leaks and 2 correctness bugs. This spec defines the surgical fixes and the minimum observability needed to verify they work.
**What you need to know first:** [057 spike](./spike.md), [056 memory leak spike](../056-cpu-spike-before-kill/memory-leak-spike.md)
**Who should read this:** Anyone reviewing the hotfix PR.

## The Problem in 30 Seconds

Every disposed `UserSession` is pinned in memory forever because `ManagedStreamingExtension` creates a `setInterval` that is never stored or cleared. Additionally, `SonioxSdkStream` registers 7 event listeners that are never removed, and 4 managers are never disposed. Combined with an identity-blind `sessions.delete()` that can orphan newer sessions, these leaks accumulate across crash cycles (each crash disposes ~65 sessions, none get GC'd). The heap grows, GC pressure increases, the event loop degrades, `/health` can't respond within 1 second 15 times in a row, and Kubernetes kills the pod.

We have no runtime metrics to observe this happening — no event loop lag, no heap tracking, no structured alerting. The only signal is BetterStack Uptime firing "Status 503" or "Timeout" alerts that we learned to ignore because deploys produce the same alerts.

## Spec

### Part A: Memory Leak Fixes

#### A1. ManagedStreamingExtension — store and clear the interval

**File:** `packages/cloud/src/services/streaming/ManagedStreamingExtension.ts`

**Before (L53–57):**

```ts
setInterval(
  () => {
    this.performCleanup()
  },
  60 * 60 * 1000,
)
```

**After:**

```ts
this.cleanupInterval = setInterval(
  () => {
    this.performCleanup()
  },
  60 * 60 * 1000,
)
```

Add the field declaration near the top of the class:

```ts
  private cleanupInterval?: NodeJS.Timeout;
```

Add to `dispose()` (L1313), before existing cleanup:

```ts
if (this.cleanupInterval) {
  clearInterval(this.cleanupInterval)
  this.cleanupInterval = undefined
}
```

**Why:** Without this, every disposed UserSession is pinned in memory forever. The interval callback captures `this`, which references the StreamRegistry and Logger (child of UserSession.logger), which references the UserSession. GC can never collect it.

#### A2. SonioxSdkStream — remove event listeners on close

**File:** `packages/cloud/src/services/session/transcription/providers/SonioxSdkStream.ts`

**Before (`close()` at L372):**

```ts
  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.state = StreamState.CLOSING;
    this.stopGapDetection();
    try {
      const sessionState = this.session.state;
      // ... finish/close logic
```

**After — add `removeAllListeners()` before finish/close:**

```ts
  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.state = StreamState.CLOSING;
    this.stopGapDetection();

    // Remove all event listeners to prevent leaking references to this stream
    // (and transitively to TranscriptionManager → UserSession) via the session emitter.
    // Must happen before finish/close since those may emit events we no longer want.
    try {
      this.session.removeAllListeners();
    } catch {
      // Swallow — some session states may not support this
    }

    try {
      const sessionState = this.session.state;
      // ... rest unchanged
```

**Why:** 7 `.on()` listeners are registered in `initialize()` (L200–206). Each closure captures `this` (the SonioxSdkStream), which holds `callbacks` → TranscriptionManager → UserSession. Without removal, the entire object graph is pinned until the Soniox SDK session object is collected.

#### A3. UserSession.dispose() — add 4 missing manager dispose calls

**File:** `packages/cloud/src/services/session/UserSession.ts`

**Before (L770–773, after the existing dispose calls):**

```ts
if (this.managedStreamingExtension) this.managedStreamingExtension.dispose()
if (this.appAudioStreamManager) this.appAudioStreamManager.dispose()

// Persist location to DB cold cache and clean up
if (this.locationManager) await this.locationManager.dispose()
```

**After — add the 4 missing managers before locationManager:**

```ts
if (this.managedStreamingExtension) this.managedStreamingExtension.dispose()
if (this.appAudioStreamManager) this.appAudioStreamManager.dispose()

// These 4 were missing from dispose — calendarManager, deviceManager,
// userSettingsManager, and streamRegistry. If any hold timers, DB watchers,
// or event listeners, the UserSession can't be GC'd.
if (this.calendarManager) (this.calendarManager as any).dispose?.()
if (this.deviceManager) (this.deviceManager as any).dispose?.()
if (this.userSettingsManager) (this.userSettingsManager as any).dispose?.()
if (this.streamRegistry) (this.streamRegistry as any).dispose?.()

// Persist location to DB cold cache and clean up
if (this.locationManager) await this.locationManager.dispose()
```

**Note:** Using `as any` + `.dispose?.()` because some of these may not have a `dispose()` method. The optional chaining makes this safe — if they don't have it, it's a no-op. If they do, it's called. No risk of runtime error.

#### A4. UserSession.dispose() — identity check before map delete

**File:** `packages/cloud/src/services/session/UserSession.ts`

**Before (L793):**

```ts
UserSession.sessions.delete(this.userId)
```

**After:**

```ts
// Only delete from map if this session is still the registered one.
// A stale session's dispose() must not delete a newer session's entry.
if (UserSession.sessions.get(this.userId) === this) {
  UserSession.sessions.delete(this.userId)
}
```

**Why:** Without the identity check, a reconnect race can cause a stale session's `dispose()` to delete the newer session from the map. The newer session becomes orphaned — alive in memory, holding all managers and timers, but unreachable from the static map and therefore never disposable.

#### A5. bun-websocket.ts — email case normalization

**File:** `packages/cloud/src/services/websocket/bun-websocket.ts`

**Before (L90):**

```ts
const userId = payload.email
```

**After:**

```ts
const userId = payload.email?.toLowerCase()
```

**Why:** REST middleware uses `decoded.email.toLowerCase()`. If a JWT has mixed-case email (e.g., `User@Example.com`), the WebSocket creates a session keyed by `User@Example.com` while REST looks up `user@example.com`. The session is invisible to REST paths, and duplicate sessions can be created for the same user.

---

### Part B: Observability

#### B1. Event loop lag — log warnings to BetterStack

**File:** `packages/cloud/src/services/metrics/MetricsService.ts`

The `sampleEventLoopLag()` method (L126–135) already measures lag every 2 seconds via `setTimeout(0)` drift. It stores the value in `_eventLoopLagCurrent` and a rolling window. But it **never logs anything** — the data is invisible to BetterStack.

**Change:** Add a warning log when lag exceeds a threshold. Inside the `setTimeout` callback in `sampleEventLoopLag()`, after updating `_eventLoopLagCurrent`:

```ts
// Log to BetterStack when event loop is degraded
if (this._eventLoopLagCurrent > 100) {
  const memUsage = process.memoryUsage()
  logger.warn(
    {
      lagMs: this._eventLoopLagCurrent,
      heapUsedMB: Math.round(memUsage.heapUsed / 1048576),
      rssMB: Math.round(memUsage.rss / 1048576),
      feature: "event-loop-lag",
    },
    `Event loop lag: ${Math.round(this._eventLoopLagCurrent)}ms`,
  )
}
```

**Threshold:** 100ms. This is well above normal (~2–5ms) but below the 1-second health probe timeout. It will fire when the event loop is degraded but before the pod is killed — catching the degradation curve.

**Volume concern:** At 2-second sampling, even sustained degradation produces at most 1 log every 2 seconds — not a flood. Under normal conditions (lag < 100ms), it logs nothing.

#### B2. /health — add heap and lag fields

**File:** `packages/cloud/src/hono-app.ts`

**Before (L188–192):**

```ts
return c.json({
  status: "ok",
  timestamp: new Date().toISOString(),
  ...metricsService.toJSON(),
})
```

**After:**

```ts
const memUsage = process.memoryUsage()
return c.json({
  status: "ok",
  timestamp: new Date().toISOString(),
  heapUsedMB: Math.round(memUsage.heapUsed / 1048576),
  heapTotalMB: Math.round(memUsage.heapTotal / 1048576),
  rssMB: Math.round(memUsage.rss / 1048576),
  eventLoopLagMs: metricsService.getCurrentLag(),
  ...metricsService.toJSON(),
})
```

**Why:** Every Kubernetes probe (5s) and BetterStack check (60s) becomes a data point. When reviewing crashes, we can see the heap growth and lag degradation curve from the `/health` response logs.

**Note:** `getCurrentLag()` should already exist on MetricsService (it exposes `_eventLoopLagCurrent`). If it doesn't, add a getter.

#### B3. /livez — lightweight liveness endpoint

**File:** `packages/cloud/src/hono-app.ts`

Add before the `/health` route:

```ts
// Lightweight liveness probe — zero computation.
// Kubernetes liveness should target this instead of /health.
// If the event loop can return 2 bytes, the process is alive.
app.get("/livez", (c) => c.text("ok"))
```

**Why:** The current `/health` endpoint iterates all sessions, counts WebSockets, updates metrics gauges, and serializes JSON on every call. That's unnecessary work for "is the process alive?" — and it competes for event loop time during the exact moments the loop is saturated.

**Note on probe config:** We are NOT changing the Porter YAML probe configuration in this hotfix. `/livez` is being added so it's available when we do update the probe config. Changing the probe target is a separate change that should be tested independently.

#### B4. Enable MEMORY_TELEMETRY_ENABLED

**Where:** Porter environment configuration for `cloud-debug` (and later `cloud-prod`).

Set `MEMORY_TELEMETRY_ENABLED=true`. This enables `MemoryTelemetryService` which already exists and logs per-session memory breakdowns (audio buffers, VAD state, transcript segments, mic state, running apps) every 10 minutes to BetterStack. Zero code change — just the env var.

---

### Part C: Deploy Workflow

#### C1. Update porter-debug.yml to deploy from hotfix branch

**File:** `.github/workflows/porter-debug.yml`

**Before (branches):**

```yaml
branches:
  - cloud/issues-044
  - new-context-soniox
  - cloud/044-ci-build-audit
```

**After:**

```yaml
branches:
  - cloud/issues-044
  - new-context-soniox
  - cloud/044-ci-build-audit
  - hotfix/cloud-observability
```

**Why:** Pushing to `hotfix/cloud-observability` deploys to `cloud-debug` for testing. Once verified, a manual PR to `main` triggers the prod deploy.

---

## What This Does NOT Include

| Explicitly out of scope                                   | Why                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Changing the Kubernetes liveness probe target to `/livez` | Probe config change should be tested separately. `/livez` is added but not wired to K8s yet.                                                                                                                                                                                                                                                  |
| Changing liveness probe timeout from 1s to 3s             | Same — probe config is a separate change.                                                                                                                                                                                                                                                                                                     |
| DashboardManager spam fix                                 | Already pending on a separate branch. Deploy independently.                                                                                                                                                                                                                                                                                   |
| Prometheus scraping of `/metrics`                         | Phase 2 work. This hotfix adds the data; scraping comes later.                                                                                                                                                                                                                                                                                |
| BetterStack dashboard charts                              | Requires application-level metrics to be emitted first. The dashboard built during investigation queries the logs table directly — BetterStack's dashboard `{{source}}` resolves to the metrics table which doesn't have `raw`. Once B1/B2 are deployed and producing structured log fields, we can build proper dashboard charts from those. |
| Deploy alert noise fix (Slack annotations)                | Phase 2 work. Useful but not blocking.                                                                                                                                                                                                                                                                                                        |
| Continuous profiler                                       | Phase 4 work. Only needed if crashes persist after these fixes.                                                                                                                                                                                                                                                                               |

## Decision Log

| Decision                                                       | Alternatives considered                                                 | Why we chose this                                                                                                                                                                                                          |
| -------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch off `main`, not `dev`                                   | Branch off `dev`                                                        | `dev` has unmerged work (SDK v3, incident fixes, etc.) that isn't in prod. The hotfix must be based on what's actually running in prod (v2.8, `dcbc96624`).                                                                |
| Use `as any` + `.dispose?.()` for the 4 missing managers       | Add `dispose()` to each manager class, or check if it exists at runtime | Safest approach — no risk of runtime error if the method doesn't exist. If a manager has `dispose()`, it's called. If not, it's a no-op. We're not going to audit 4 manager classes for this hotfix.                       |
| `removeAllListeners()` instead of targeted `.off()` for Soniox | Remove each listener individually                                       | The stream is being closed — we want ALL listeners gone. `removeAllListeners()` is simpler and covers any listeners we might have missed. The Soniox session is per-stream, not shared, so removing all listeners is safe. |
| Log event loop lag at >100ms threshold                         | 50ms, 200ms, 500ms                                                      | 100ms is above normal noise (~2–5ms) but well below the 1s probe timeout. It catches degradation early without flooding logs.                                                                                              |
| Don't change probe config in this hotfix                       | Change probe to `/livez` + increase timeout to 3s                       | Probe config changes affect how Kubernetes manages the pod lifecycle. Mixing that with code fixes makes it harder to attribute improvements. Add `/livez` now, change the probe target in a follow-up.                     |
| Test on `cloud-debug` before `main`                            | Deploy directly to prod                                                 | We've never deployed these specific fixes. Testing on debug gives us a few hours of observation before touching prod.                                                                                                      |

## Testing Plan

### On cloud-debug (before PR to main)

1. **Pod starts cleanly** — no crash loop, no new errors in BetterStack
2. **`/livez` returns `ok`** — `curl https://debug.augmentos.cloud/livez`
3. **`/health` includes new fields** — `curl https://debug.augmentos.cloud/health` returns `heapUsedMB`, `rssMB`, `eventLoopLagMs`
4. **Event loop lag logs appear in BetterStack** — search for `feature: "event-loop-lag"` with server `cloud-debug`. Should appear only when lag > 100ms.
5. **Connect a test session** — glasses WebSocket + a few apps. Verify audio, transcription, display all work. Disconnect and reconnect. Verify session is properly disposed (check MemoryLeakDetector — should see "Object finalized by GC" within 60s, NOT "Potential leak").
6. **Memory telemetry appears** — if `MEMORY_TELEMETRY_ENABLED=true` is set, check BetterStack for periodic memory snapshots from `cloud-debug`.

### After PR to main (monitoring cloud-prod)

7. **Crash frequency** — monitor BetterStack Uptime for `prod.augmentos.cloud/health`. Target: crashes drop from ~8/day to <2/day within 48 hours.
8. **MemoryLeakDetector warnings** — search BetterStack for "Potential leak" from `cloud-prod`. Target: near-zero (vs 245 on March 25).
9. **High memory warnings** — search for "High memory usage" from `cloud-prod`. Target: significant reduction (vs 7,949 on March 25).
10. **Heap stability** — check `/health` response `heapUsedMB` over time. Should stabilize instead of growing to 512MB+.

### What "success" looks like

- Crash frequency drops from ~8/day to <2/day → memory leaks were the primary cause
- Crash frequency drops but doesn't reach zero → leaks were a factor but something else remains. The event loop lag logs (B1) will show what's happening during remaining crashes.
- Crash frequency doesn't change → leaks were not the cause. Event loop lag logs + heap data from B1/B2 are now available for the next investigation round.

All three outcomes give us more information than we have today. There is no downside to deploying these fixes.
