# Spike: Memory Leaks & Crash Audit — What's Actually Killing Cloud-Prod?

## Overview

**What this doc covers:** Complete audit of every cloud-prod crash in the past 8 days (75 restarts), identification of two distinct crash patterns, and three confirmed memory leak paths found via code audit.
**Why this doc exists:** Issue 055 confirmed crashes are liveness probe failures. Issue 056 investigated CPU as the cause but benchmarking ruled out WASM decode. This spike follows the actual evidence trail — BetterStack logs, MemoryLeakDetector warnings, and `TranscriptionManager` "High memory usage" alerts — to the real leak sources.
**Who should read this:** Cloud engineers, anyone working on cloud-prod stability.

**Depends on:**

- [055-cloud-prod-oom-crashes/spike.md](../055-cloud-prod-oom-crashes/spike.md) — liveness probe failure confirmation
- [056-cpu-spike-before-kill/spike.md](./spike.md) — WASM decode ruled out via benchmark

---

## Background

Cloud-prod has been crashing continuously since at least March 18 (when BetterStack logging began). The pod runs image `dcbc9662` (v2.8, HEAD of `main`), deployed March 19. We have no visibility before March 18 — BetterStack data starts that day.

From the prior spikes, we know:

- Crashes are liveness probe failures (exit code 137 = SIGKILL)
- Probe config: `GET /health`, timeout=1s, period=5s, failureThreshold=15 → 75s to kill
- CPU spikes to 5.02 cores before kill (event loop + GC/JIT background threads)
- Memory at crash was 924MB RSS (limit 4096MB) — originally ruled out OOM
- LC3 WASM decode uses 0.7% of CPU at 40 sessions — **ruled out**
- Incident JSON processing at realistic sizes is ~2ms — **ruled out**

What we didn't know: what's actually blocking the event loop for 75+ seconds.

---

## Crash Census: 75 Restarts in 8 Days

Every restart timestamp for cloud-prod, derived from BetterStack "UDP Audio Server started successfully" logs:

| Day        | Restarts | Times (UTC)                                                                                             |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------- |
| Mar 18     | 2        | 23:36, 23:41                                                                                            |
| Mar 19     | 11       | 01:57, 02:00 (×2), 03:16, 04:27, 04:28, 04:29, 09:33, 18:01 (×2), 21:01                                 |
| Mar 20     | 7        | 00:04, 00:22, 03:08, 07:39, 14:40, 18:30, 19:04, 20:33                                                  |
| Mar 21     | 7        | 00:07, 00:41, 04:39, 07:06, 18:24, 21:51, 22:33                                                         |
| Mar 22     | 10       | 00:32, 00:36, 01:25, 05:24, 14:39, 17:42, 17:43, 18:52, 20:26, 21:46, 23:31                             |
| Mar 23     | 13       | 03:19, 07:51, 11:12, 11:32, 11:57, 18:23, 19:59, 21:27, 22:00, 22:06, 22:31, 22:33, 22:34               |
| Mar 24     | 7        | 06:30, 12:19, 12:22, 12:44, 15:09, 20:43, 22:54                                                         |
| **Mar 25** | **15**   | 03:55, 05:17, 06:20, 06:32, 08:09, 12:38, 15:06, 15:24, 16:01, 16:47, 17:20, 18:02, 18:35, 19:04, 20:40 |
| **Total**  | **75**   |                                                                                                         |

Observations:

- Crashes happen 24/7 — not just during peak hours
- Many are cascading (e.g., Mar 19 04:27→04:28→04:29 = 3 restarts in 2 minutes)
- **Mar 25 was the worst day** with 15 restarts — correlates with the 7 bug reports filed
- Average uptime between crashes: ~2.5 hours (but varies from 1 minute to 11 hours)

---

## Two Distinct Crash Patterns

We correlated every restart with BetterStack error/warning counts in the surrounding 30-minute windows. Two clear patterns emerged:

### 🔴 Pattern A: High Heap Pressure (daytime, ~60% of crashes)

**When:** Primarily 12:00–22:00 UTC (peak usage hours)
**Signature:** `TranscriptionManager` "High memory usage detected" warnings present in the 30-minute window

| Window       | High Memory Warnings | Leak Warnings | Restarts |
| ------------ | -------------------- | ------------- | -------- |
| Mar 25 12:30 | 58                   | 1             | 1        |
| Mar 25 15:00 | 30                   | 9             | 2        |
| Mar 25 16:00 | 27                   | 8             | 1        |
| Mar 25 16:30 | 22                   | 15            | 1        |
| Mar 25 17:00 | 31                   | 14            | 1        |
| Mar 25 18:00 | 16                   | 1             | 1        |
| Mar 25 18:30 | 29                   | 15            | 1        |
| Mar 25 19:00 | 10                   | 10            | 1        |
| Mar 25 20:30 | 49                   | 3             | 1        |

**What's happening:**

1. V8 `heapUsed` exceeds 512MB (the `TranscriptionManager` threshold)
2. `checkResourceLimits()` fires, logs "High memory usage detected", calls `cleanupIdleStreams()`
3. `cleanupIdleStreams()` destroys ALL transcription streams for that session
4. Soniox `onClosed` callbacks fire → `scheduleStreamReconnect()` recreates streams
5. New stream creation calls `checkResourceLimits()` again → memory still high → loop
6. GC under pressure from leaked objects + churn from DashboardManager spam (645K warn logs/day)
7. Event loop starvation → `/health` can't respond in 1s → 15 consecutive failures → SIGKILL

**Pre-crash error audit (sampled from Mar 20 14:40, Mar 22 17:42, Mar 25 18:02):**

- "High memory usage detected" appears within 10 seconds of every sampled crash
- DashboardManager "DisplayManager is not ready" flood: 60+ warnings in the final 10 seconds
- MicrophoneManager "WebSocket not open" at ~20ms intervals from stuck clients
- Soniox SDK stream errors cascading
- HTTP 503 flood (sessions lost)
- Zero `fatal` logs — process dies silently (external SIGKILL, not unhandled exception)

### 🔵 Pattern B: Event Loop Stall Without Heap Pressure (overnight, ~40% of crashes)

**When:** 00:00–09:00 UTC (low usage hours)
**Signature:** Zero "High memory usage" warnings, but `MemoryLeakDetector` "Potential leak" warnings present. Response times degraded to 500–1300ms for simple endpoints.

| Window       | High Memory Warnings | Leak Warnings | Restarts |
| ------------ | -------------------- | ------------- | -------- |
| Mar 25 03:30 | **0**                | 12            | 1        |
| Mar 25 05:00 | **0**                | 6             | 1        |
| Mar 25 06:00 | **0**                | 3             | 1        |
| Mar 25 06:30 | **0**                | 3             | 1        |
| Mar 25 08:00 | **0**                | 3             | 1        |

**What's happening:**

1. Heap is under 512MB — the TranscriptionManager threshold is NOT hit
2. But the MemoryLeakDetector IS firing — disposed UserSessions are not being GC'd
3. Response times for `/api/client/user/settings` climb to 500–1300ms (should be <50ms)
4. The event loop is degraded but not from heap pressure — something else is stalling it
5. Eventually the degradation crosses the 75-second liveness threshold → SIGKILL

**Pre-crash error audit (sampled from Mar 25 03:55, Mar 25 06:20):**

- Zero "High memory" warnings — heap is fine
- Response times 500–1300ms on simple MongoDB endpoints — event loop is sluggish
- DashboardManager spam still running (all connected sessions generating 4 display requests/sec)
- Leak warnings present (disposed sessions not GC'd)
- 503 flood from clients whose sessions don't exist (post-previous-crash reconnection still failing)
- Zero `fatal` logs — same silent SIGKILL pattern

**This is NOT the same as Pattern A.** The heap isn't the bottleneck. Something is accumulating that degrades event loop responsiveness even at low session counts. The leaked `ManagedStreamingExtension` intervals (see below) are the strongest candidate — they fire forever on disposed sessions, and the accumulated GC scanning overhead of orphaned object graphs could explain the degradation.

---

## What "High memory usage detected" Actually Measures

```
// TranscriptionManager.ts L1664-1681
private async checkResourceLimits(): Promise<void> {
    const memoryUsage = process.memoryUsage();
    const memoryThreshold = this.config.performance.maxMemoryUsageMB * 1024 * 1024;
    if (memoryUsage.heapUsed > memoryThreshold) {
      this.logger.warn({ memoryUsage }, "High memory usage detected");
      await this.cleanupIdleStreams();
    }
}
```

- **Measures:** `process.memoryUsage().heapUsed` — the V8 JavaScript heap only
- **Threshold:** 512 MB (`maxMemoryUsageMB` default in `types.ts` L359)
- **Action:** `cleanupIdleStreams()` → destroys ALL streams for that session → `this.streams.clear()`
- **Fired 7,949 times on March 25** — heap is consistently above 512MB during active hours
- **Called from:** `_performStreamCreationForStartStream()` — every stream creation attempt checks this

The original spike 055 said "Not OOM — 924MB RSS, limit 4096MB." That's true for the container — Kubernetes isn't OOM-killing the pod. But the V8 heap being over 512MB is causing heavy GC pressure, which blocks the event loop, which causes liveness probe failures. The container has plenty of memory; the V8 heap is the bottleneck.

## What the MemoryLeakDetector Is Flagging

```
// MemoryLeakDetector.ts — 67 lines total
// Uses FinalizationRegistry to track UserSession objects after dispose()
// If GC doesn't collect a disposed session within 60 seconds → warns

register(object, tag)      // Called in UserSession constructor
markDisposed(tag)          // Called in UserSession.dispose()
// After 60s: if not finalized → "Potential leak: object not GC-finalized"
```

- **Tracks:** `UserSession` objects specifically
- **245 warnings on March 25** — 245 UserSessions were `.dispose()`'d but GC couldn't collect them after 60 seconds
- **Implication:** Something holds a strong reference to each disposed session, preventing collection

---

## Three Confirmed Memory Leak Paths

### 🔴 Leak #1: `ManagedStreamingExtension` — Unkillable Interval Pins Every Disposed Session

**File:** `services/streaming/ManagedStreamingExtension.ts` L53
**Confidence:** Very High — the code is unambiguous

```
// In the constructor — called for every new UserSession
constructor(logger: Logger, streamRegistry: StreamRegistry) {
    // ...
    setInterval(() => {
      this.performCleanup();
    }, 60 * 60 * 1000);  // Hourly
}
```

The return value of `setInterval` is **never stored**. The `dispose()` method of `ManagedStreamingExtension` **never clears it**. `UserSession.dispose()` calls `this.managedStreamingExtension.dispose()` but that method has no way to clear this interval because the handle was thrown away.

**Effect:** Every UserSession that is created and then disposed leaves behind a live `setInterval` callback. The callback captures `this` (the extension), which references `StreamRegistry` and `Logger` (child of UserSession.logger → UserSession). The **entire UserSession object graph** (19 managers, audio buffers, WebSocket references, transcription streams) is pinned in memory forever.

With 65 active sessions and crashes every 1–3 hours, each crash cycle disposes ~65 sessions and creates ~65 new ones. The old 65 are pinned. After 5 crash cycles, there are ~325 leaked UserSession shells with live intervals, all accumulating heap pressure.

**Fix:** One line — store the interval handle, clear it in dispose:

```
private cleanupInterval?: NodeJS.Timeout;

constructor(...) {
    this.cleanupInterval = setInterval(() => this.performCleanup(), 60 * 60 * 1000);
}

dispose(): void {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    // ...existing cleanup
}
```

### 🔴 Leak #2: SonioxSdkStream Event Listeners Never Removed

**File:** `services/session/transcription/providers/SonioxSdkStream.ts` L200–210
**Confidence:** High

```
// In initialize() — registers 7 event listeners
this.session.on("result", (result) => this.handleResult(result));
this.session.on("endpoint", () => this.handleEndpoint());
this.session.on("finalized", () => this.handleFinalized());
this.session.on("finished", () => this.handleFinished());
this.session.on("error", (error) => this.handleError(error));
this.session.on("disconnected", (reason) => this.handleDisconnected(reason));
this.session.on("connected", () => { ... });
```

In `close()` (L372–415): `this.session.finish()` or `this.session.close()` is called, but **none of the 7 `.on()` listeners are `.off()`'d**. Each listener closure captures `this` (the SonioxSdkStream), which holds `callbacks` → TranscriptionManager → UserSession.

As long as the Soniox SDK's `RealtimeSttSession` object retains its listener array (which EventEmitters do until explicitly cleaned), the entire chain is pinned.

Additionally, `tryDifferentProvider()` and `trySpecificProvider()` call `this.streams.set(subscription, newStream)` without first closing the old stream for that key — the old stream becomes orphaned with open WebSocket and active listeners.

**Fix:** Add `.removeAllListeners()` or targeted `.off()` calls in `close()`:

```
// In close():
this.session.removeAllListeners();  // Before finish/close
```

### 🔴 Leak #3: Four Managers Never Disposed in UserSession.dispose()

**File:** `services/session/UserSession.ts` L722–806
**Confidence:** High

`UserSession.dispose()` calls `.dispose()` on 13 managers but **misses 4:**

| Manager               | Initialized at | Disposed?      |
| --------------------- | -------------- | -------------- |
| `calendarManager`     | L181           | ❌ **Missing** |
| `deviceManager`       | L187           | ❌ **Missing** |
| `userSettingsManager` | L186           | ❌ **Missing** |
| `streamRegistry`      | L184           | ❌ **Missing** |

If any of these hold timers, DB watchers, or event listeners, the UserSession can't be collected. `userSettingsManager` fires a MongoDB query in its constructor (`this.loadPromise = this.load()`) — if the query's Promise chain holds a reference back to the manager, it could prevent GC.

Additionally, `dispose()` never nulls any manager references (`this.appManager`, `this.audioManager`, etc.) — while V8's GC handles reference cycles, this makes the leaked object graph unnecessarily large.

**Fix:** Add the missing dispose calls + null out references:

```
// In dispose():
if (this.calendarManager) this.calendarManager.dispose?.();
if (this.deviceManager) this.deviceManager.dispose?.();
if (this.userSettingsManager) this.userSettingsManager.dispose?.();
if (this.streamRegistry) this.streamRegistry.dispose?.();
```

---

## Contributing Factors (Not Root Causes)

### Untracked `setTimeout`s in TranscriptionManager/TranslationManager

`scheduleStreamReconnect()` (L1472) and `scheduleStreamRetry()` (L1551) create `setTimeout` callbacks that capture `this` but are **never stored and never cancellable**. After `dispose()`, these fire on dead managers and attempt `startStream()`, potentially creating zombie streams.

Same pattern in `TranslationManager.scheduleStreamRetry()` (L952).

### The `dispose()` identity-blind map delete (known bug from 055)

```
// UserSession.ts L793
UserSession.sessions.delete(this.userId);  // No identity check
```

If a stale session's `dispose()` fires after a new session for the same userId was created (reconnect race), it deletes the **new** session's map entry. The new session becomes orphaned — alive, referenced by timers and managers, but unreachable from the static map. It can never be disposed.

### DashboardManager spam amplifies GC pressure

645,227 warnings/day = ~7.5/second sustained. Each warning:

- Builds a full Layout object (`generateMainLayout()`)
- Creates a `DisplayRequest` with `new Date()`
- Serializes the **entire displayRequest** into the pino log event: `{ displayRequest }`
- Runs `ConnectionValidator.validateForHardwareRequest()` creating more objects

Conservative estimate: ~5–6 million short-lived objects/day from this path alone. This is not a leak (they're collected), but the constant GC churn compounds with the actual leaks above, keeping GC busy and the event loop stressed.

**Note:** A fix for DashboardManager spam is already pending on a separate branch.

---

## How the Leaks Cause Both Crash Patterns

### Pattern A (daytime, high heap):

```
1. ~65 active sessions, each streaming audio + transcription
2. Previous crash cycles left leaked sessions (Leak #1, #2, #3)
3. Leaked objects accumulate heap → heapUsed crosses 512MB
4. TranscriptionManager cleanup → stream recreation → cleanup loop (CPU churn)
5. DashboardManager spam adds 5M+ throwaway objects/day → GC can't keep up
6. GC pauses + event loop saturation → /health fails for 75s → SIGKILL
```

### Pattern B (overnight, low heap):

```
1. ~15-20 active sessions, low load
2. Leaked objects from prior crash cycles still in memory (pinned by intervals)
3. Heap stays under 512MB — TranscriptionManager threshold NOT hit
4. But: accumulated ManagedStreamingExtension intervals fire hourly per leaked session
5. GC scanning overhead grows with number of leaked object graphs
6. Event loop degrades gradually — response times climb to 500-1300ms
7. Eventually crosses the 75-second liveness threshold → SIGKILL
8. Note: exact mechanism for Pattern B is less certain than Pattern A
```

---

## What We Know vs. What We Suspect

| Finding                                                         | Confidence    | Evidence                                                                                                         |
| --------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------- |
| 75 restarts in 8 days, all via liveness probe SIGKILL           | **Confirmed** | BetterStack restart logs + kubectl describe                                                                      |
| Two distinct crash patterns (high heap vs. low heap)            | **Confirmed** | Correlated restart times with "High memory" warning presence/absence                                             |
| Pattern A correlates with heapUsed > 512MB                      | **Confirmed** | TranscriptionManager warnings present in same 30-min window for ~60% of crashes                                  |
| Pattern B has no heap pressure but degraded response times      | **Confirmed** | Zero "High memory" warnings + 500-1300ms response times for simple endpoints                                     |
| `ManagedStreamingExtension` interval is never cleared (Leak #1) | **Confirmed** | Code audit — `setInterval` return value discarded, no `clearInterval` anywhere                                   |
| `SonioxSdkStream` event listeners never removed (Leak #2)       | **Confirmed** | Code audit — 7 `.on()` calls, zero `.off()` calls in `close()`                                                   |
| 4 managers not disposed (Leak #3)                               | **Confirmed** | Code audit — `calendarManager`, `deviceManager`, `userSettingsManager`, `streamRegistry` absent from `dispose()` |
| 245 UserSessions failed to GC after dispose on Mar 25           | **Confirmed** | MemoryLeakDetector "Potential leak" warnings                                                                     |
| Leak #1 is the primary cause of sessions not being GC'd         | **High**      | Only known path that creates an unkillable strong reference to disposed sessions                                 |
| Leaked sessions from Leak #1 cause Pattern B crashes            | **Medium**    | Plausible (accumulated GC scanning overhead), but not directly measured                                          |
| The cleanup→recreate→cleanup loop amplifies Pattern A           | **Medium**    | Code path confirmed, but no direct measurement of its CPU impact                                                 |
| V8 GC pauses are what blocks the event loop for 75s             | **Medium**    | Consistent with symptoms (5-core CPU = main thread + GC threads), but no GC telemetry to confirm duration        |

---

## Next Steps

### P0 — Fix the confirmed leaks

1. **Fix Leak #1:** Store and clear `ManagedStreamingExtension` interval in dispose. One line change.

2. **Fix Leak #2:** Add `this.session.removeAllListeners()` in `SonioxSdkStream.close()`.

3. **Fix Leak #3:** Add missing dispose calls for `calendarManager`, `deviceManager`, `userSettingsManager`, `streamRegistry` in `UserSession.dispose()`.

4. **Fix the identity-blind map delete:** Add `if (UserSession.sessions.get(this.userId) === this)` before `sessions.delete()`.

5. **Fix the email case mismatch:** Add `.toLowerCase()` to `bun-websocket.ts` L90.

### P1 — Add observability to validate

6. **Add event loop lag metric** — `setInterval` drift measurement, log when lag > 100ms. This tells us whether the leaks were actually causing the event loop degradation.

7. **Enable `MEMORY_TELEMETRY_ENABLED=true`** — periodic snapshots of per-session memory. Zero code change, just Porter env var.

8. **Add GC telemetry** — Bun/V8 exposes GC pause duration via `--expose-gc` or performance hooks. Log when GC pauses exceed 100ms. This would confirm or deny whether GC is the mechanism blocking the event loop.

9. **Add `heapUsed` to the `/health` endpoint response** — lets us see heap growth over time via Kubernetes probe responses.

### P2 — Harden

10. **Add `disposed` guards to scheduled reconnect callbacks** — `scheduleStreamReconnect()` and `scheduleStreamRetry()` should check `if (this.disposed) return` at the top of their setTimeout callbacks.

11. **Add a lightweight `/livez` endpoint** — `app.get("/livez", (c) => c.text("ok"))` with zero computation. Point liveness probe here instead of `/health`.

12. **Add explicit probe config to Porter YAML** — version-control the liveness probe settings.

13. **Add reconnection rate limiting** — after a crash, throttle session creation to prevent thundering herd.

### Open Questions

- **Does fixing Leak #1 alone stop the crashes?** It should dramatically reduce them since it's the only path that permanently pins disposed sessions. But Leak #2 and #3 should be fixed too.
- **What's the exact mechanism for Pattern B crashes?** The leaked intervals + GC overhead theory is plausible but unproven. Event loop lag monitoring (P1 #6) would answer this.
- **Were crashes happening before v2.8 (March 19)?** We have no BetterStack data before March 18. The `ManagedStreamingExtension` has existed since before v2.7 and has never had its interval cleared, so this leak has likely been present for a long time — possibly masked by lower session counts.
- **How many leaked sessions accumulate before a crash?** We know 245 leaked on March 25, but that's across all crashes that day. Per-cycle measurement would help size the problem.
