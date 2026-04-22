# Spec: Device-State Storm — Cloud-Side Dedup + Mobile-Side Coalescing

## Overview

**What this doc covers:** Exact behavior changes to stop the `/api/client/device/state` amplification storm documented in [spike.md](./spike.md). Splits the fix across two independently-deployable pieces: a cloud-only equality/debounce guard that lands first and cuts the volume 60–80% without a mobile release, and a mobile-side subscription refactor that is the correct long-term fix.

**Why this doc exists:** The spike proved the mobile app's `MantleManager` POSTs device-state on every `GlassesStore` field change, with no debounce, and the cloud runs a full capability + Mongo + PostHog + broadcast cascade on every request with no dedup. Pod-wide this sustains 100–150 cascades/minute on us-central and correlates with a +420 MB RSS climb over 4 hours. We need a surgical cloud-side patch that ships in hours, plus a mobile-side fix that ships in the next release.

**What you need to know first:** [spike.md](./spike.md).

**Who should read this:** Cloud reviewers of the hotfix PR. Mobile engineers reviewing the `MantleManager` refactor. SREs watching the deploy.

---

## The Problem in 30 Seconds

Cloud runs a full heavy pipeline on every `POST /api/client/device/state` without checking whether anything changed. Mobile sends that POST on every Zustand field bump, including spurious re-emits of the same `modelName`. On us-central this means a hundred-plus full cascades per minute forever, which produces enough transient allocation pressure to ratchet V8 `heapTotal` up and never let it down. We fix this in two places: the cloud adds an equality guard + rate limit, and the mobile app stops emitting no-op updates.

---

## Spec

### Part 1 — Cloud-side dedup (ships first, deploys independently)

#### S1.1 Equality guard on `updateDeviceState`

**File:** `cloud/packages/cloud/src/services/session/DeviceManager.ts`

**Current behavior:** `updateDeviceState(payload)` always logs, always merges, always runs the downstream cascade if `payload.connected !== undefined` or `modelChanged`.

**New behavior:** Before merging, compute the effective diff between `payload` and the current `this.deviceState`. If every field in `payload` already equals the current value, return immediately with no log, no merge, no cascade, no broadcast. Increment a counter so we can observe the dedup rate.

**Required behavior:**

1. Compute `effectiveDiff`: the subset of `payload` where `payload[key] !== this.deviceState[key]`.
2. If `effectiveDiff` is empty, increment `this.dedupedUpdates` (a session-scoped counter for observability) and return without logging.
3. If `effectiveDiff` is non-empty, proceed with the existing path but **use `effectiveDiff` to drive the cascade decisions**, not the original `payload`:
   - `modelChanged` is computed from `effectiveDiff.modelName`, not `payload.modelName`.
   - The `handleGlassesConnectionState` branch only fires if `effectiveDiff.connected !== undefined`.
   - `broadcastDeviceStateToApps` is called with `effectiveDiff`, not the full `payload`, so subscribed apps only see real changes.

**Edge cases:**

- `payload.batteryLevel === -1` (sentinel "unknown"): treat as a real value for equality purposes. If it matches current, dedup. If it differs, proceed. Do not special-case.
- `payload.modelName` inference logic (setting `connected` based on a non-empty modelName) should run **after** the equality check, not before. Otherwise we synthesize a `connected` field that was never in the payload and falsely flag a diff.
- If `payload` contains keys not present in `this.deviceState` (first-ever write for a field), treat those as changes.

**Not in scope for S1.1:** recompute of capabilities, PostHog, Mongo, WS broadcast when a diff exists. Those keep firing on genuine diffs.

#### S1.2 `MicrophoneManager.forceResync` only on true connection transitions

**File:** `cloud/packages/cloud/src/services/session/MicrophoneManager.ts`

**Current behavior:** `handleConnectionStateChange(status)` always calls `forceResync()` if `status === "CONNECTED" || status === "RECONNECTED"`. This fires even when the cloud-side `connected` flag was already true and the incoming payload just re-asserted it.

**New behavior:** `forceResync()` only fires if the connection state actually changed from its last-known value. Add a `private lastKnownConnectionState` field on `MicrophoneManager` and gate the resync on transition.

**Why:** Every `forceResync()` call allocates and sends a settings broadcast. Firing it 100x per minute for sessions that never disconnected is pure waste. The original reason for `forceResync` (per the code comment: "the mobile app may have lost track of mic state during the reconnection process") only applies to a real transition, not a heartbeat.

#### S1.3 Per-session rate limit on `/api/client/device/state`

**File:** `cloud/packages/cloud/src/api/hono/client/device-state.api.ts`

**New behavior:** Reject incoming requests that exceed a per-session rate limit with HTTP 429.

**Parameters:**

- Window: 1 second
- Max requests per session per window: **10**
- Above limit: return HTTP 429 with `Retry-After: 1`, do not execute `updateDeviceState`.
- Log once per session per 60s when a session crosses the limit, including the user ID. Do not log every drop (that would become its own allocation storm).

**Why 10 per second:** the spike showed one user sustaining 30.7 per minute with spurious re-emits. A healthy phone with real BLE churn should not exceed ~5 per second even during a reconnect. 10 is a generous ceiling that protects the pod without breaking legitimate use.

**Storage:** a simple `Map<userId, { count: number; windowStart: number }>` in module scope. No Redis, no cross-pod sync. If a user is routed to two pods simultaneously (which they shouldn't be), they'd get 20/s total — acceptable.

#### S1.4 Observability counters

**File:** `cloud/packages/cloud/src/services/session/DeviceManager.ts` and `cloud/packages/cloud/src/services/metrics/SystemVitalsLogger.ts`

Expose in the vitals log and in `/api/admin/memory/now`:

- `deviceStateUpdatesTotal` — every POST received per pod per vitals tick (snapshot counter)
- `deviceStateUpdatesDeduped` — of those, how many were no-ops
- `deviceStateUpdatesRateLimited` — rejected with 429
- `deviceStateUpdatesApplied` — passed the guard and ran the cascade

All four are pod-global counters reset on the vitals tick (so they're deltas, not lifetime).

**Why:** we cannot land this fix without confirming it worked. The spike's baseline is "~3500 updates / 30m on us-central at peak" → we want to see that number drop substantially, and specifically see the deduped count pick up the slack.

#### S1.5 `bstack` command

**File:** `cloud/tools/bstack/bstack.ts`

Add `bstack device-state --region <region> --duration <window>` that reports:

- total updates per minute
- % deduped
- % rate-limited
- top 10 users by update rate
- comparison across regions

This becomes the standing SRE view for this class of problem.

### Part 2 — Mobile-side subscription refactor (ships in next mobile release)

#### S2.1 Split the `MantleManager` Zustand subscription by concern

**File:** `mobile/src/services/MantleManager.ts`

**Current:** one subscription on `getGlasesInfoPartial` (10+ fields) fires on any field change and POSTs the full diff.

**New:** three narrower subscriptions, each coalesced independently:

1. **Connection-state subscription** — watches `{connected, deviceModel, modelName}`. Fires on true transitions only. Debounced 250 ms.
2. **Battery subscription** — watches `{batteryLevel, charging, caseBatteryLevel, caseCharging}`. Debounced 2000 ms. Coalesce all four into one POST.
3. **WiFi subscription** — watches `{wifiConnected, wifiSsid}`. Debounced 1000 ms.

Each subscription maintains its own "last sent value" and skips the POST if the debounced value equals the last-sent value.

#### S2.2 Skip POST when diff is empty or only contains "unknown" sentinels

**File:** `mobile/src/services/MantleManager.ts` or a new helper

Before calling `restComms.updateGlassesState(statusObj)`:

- If `statusObj` is empty (all fields equal to previous), skip.
- If `statusObj` contains `batteryLevel: -1` or any field whose only change is "known → unknown" during a transient BLE blip, skip. Unknown is not news.

#### S2.3 Audit `shallow` equality on GlassesStore updates

**File:** `mobile/src/stores/glasses.ts` plus wherever native events flow in (`CoreModule.addListener("glasses_status", ...)`).

Zustand's `shallow` comparator should reject a no-op update where every field equals the previous. The spike showed it didn't — `modelName: "Even Realities G1"` was firing 13 times in 3 seconds with no underlying change. Hypothesis: the native bridge is allocating a new string each time, and `shallow` compares by reference for non-primitive fields. Needs verification on iOS and Android.

Fix: intern strings or explicitly compare with `===` where possible before calling `setGlassesInfo`.

#### S2.4 Remove dead `SocketComms.sendGlassesConnectionState()`

**File:** `mobile/src/services/SocketComms.ts`

The method is defined but never called (verified in the spike). Per the completed REST migration (`cloud/issues/complete/device-state/`), it should be removed. Keeps future readers from thinking it's live.

---

## Decision Log

| Decision                                                         | Alternatives considered                       | Why we chose this                                                                                                                                                                |
| ---------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ship cloud-side dedup before mobile fix                          | Ship mobile-only; ship both together          | Cloud ships in hours with no coordination. Mobile ships with the next release (days to weeks). Cloud alone drops volume 60–80% immediately.                                      |
| Use an equality guard, not a cached-response cache               | LRU of recent responses; response fingerprint | Simpler. State is already in memory (`this.deviceState`). No cache invalidation problems.                                                                                        |
| Rate limit at 10/sec per session                                 | 5/sec, 20/sec, per-IP                         | 10/sec covers legitimate BLE reconnect bursts with headroom. Per-session is the right axis because the storm is per-user, not per-IP (phones NAT through carriers).              |
| In-memory rate limit, no Redis                                   | Redis sliding window; token bucket            | Over-engineering for a single-pod mitigation. A user pinned to one pod covers the real case. Cross-pod leakage is bounded and harmless.                                          |
| Return 429 instead of silently 200                               | Silent success; 503                           | 429 is the correct HTTP semantic. Mobile clients that already handle 429 (via retry libraries) back off automatically. 200 would hide the pressure and let mobile keep spraying. |
| `forceResync` only on transitions                                | Always resync on any CONNECTED                | The comment on `forceResync` explains it exists for a real reconnect case. Heartbeats don't need it.                                                                             |
| Split mobile subscription by concern, not use a single debouncer | Global debouncer on the existing subscription | A single debouncer delays urgent changes (connection transition) while trying to slow down slow ones (battery). Splitting lets each concern pick its own latency budget.         |
| Add a `bstack device-state` command, not a one-off SQL snippet   | Ad-hoc SQL each time                          | We are going to watch this for weeks. Make it a first-class tool.                                                                                                                |

---

## Non-Goals

- Cross-pod rate limiting. Not needed; sessions are pod-sticky.
- Disk-backed rate limit persistence across restarts. Not needed; a window is 1 s.
- Replacing the REST endpoint with a WebSocket message. Out of scope. The REST endpoint itself is fine; the problem is traffic shape.
- Session-ownership reassignment on rate-limit. If we ever persistently 429 a user, they'll back off and their phone will recover; this is working as intended.
- Backpressure or queueing of deferred work. Not needed; we're dropping redundant requests, not deferring them.

---

## Testing

### Local verification (cloud)

1. Start cloud locally with one session.
2. Send `POST /api/client/device/state` with `{"modelName": "G1", "connected": true, "batteryLevel": 50}` five times in a row.
3. Expect: first request logs `Updating device state` and runs the cascade. Next four are silently deduped (counter increments, no log). `deviceStateUpdatesDeduped` = 4.
4. Send a sixth with `{"batteryLevel": 51}`. Expect the cascade for the effective diff `{batteryLevel: 51}` only — no re-broadcast of model or capabilities.
5. Send 20 requests in one second. Expect the last 10 to return HTTP 429.
6. Hit `/api/admin/memory/now`. Expect the four counters present and sensible.

### Production verification (after deploy)

1. Before deploy: record `device-state updates/min` on us-central (baseline ~100–150/min).
2. Deploy cloud-side Part 1.
3. After 1 hour: re-measure. Expect **< 40/min** with `% deduped` > 60%.
4. Watch `system-vitals` for RSS trend. Expect the ramp to flatten compared to the pre-deploy 4h window.
5. If `% deduped` < 30%, the equality check is broken (something is serializing differently between the phone and the cached cloud state). Diagnose before declaring success.

### Mobile verification (after mobile release)

1. Before release: `device-state updates/min` on us-central (post cloud-side fix baseline).
2. Release mobile.
3. After 48h (gradual rollout): re-measure. Expect updates/min to drop further. Rate-limit 429 count should drop to near zero.
4. Watch for client-side regression: 429 responses not being handled gracefully, or the debouncer dropping a real transition.

---

## Rollout

1. **Phase 1, cloud hotfix.** Branch `cloud/issues-099-device-state-storm`. Land S1.1–S1.4 in one PR. Deploy to cloud-debug first, run Part 1 local verification, then promote to prod. Monitor for 1 hour before merging to `main`.
2. **Phase 2, `bstack` command.** S1.5 as a follow-up PR on the same branch. Not deploy-blocking.
3. **Phase 3, mobile refactor.** Separate branch in the mobile repo. Ships in the next mobile release. Coordinate with mobile eng.
4. **Phase 4, post-mobile cleanup.** If the mobile refactor is successful, the cloud-side rate limit can be tightened (e.g. 5/sec) as a belt-and-suspenders measure.

---

## Key Numbers

| Metric                                   | Before  | Target (after Phase 1) | Target (after Phase 3)              |
| ---------------------------------------- | ------- | ---------------------- | ----------------------------------- |
| `device-state updates/min` on us-central | 100–150 | < 40                   | < 15                                |
| % deduped                                | 0       | > 60%                  | > 30% (mobile stopped sending them) |
| % rate-limited                           | 0       | < 5%                   | ~0                                  |
| RSS growth (MB/hour, quiet-traffic pod)  | ~100    | < 30                   | < 10                                |
| `heapTotal` ratcheting to 1 GB+          | yes     | no                     | no                                  |
| Per-user updates in 30 min               | 50–70   | < 20                   | < 5                                 |
