# Spike: Glasses Connection State Storm — The Mobile App Hammers `/api/client/device/state`

## Overview

**What this doc covers:** A newly-discovered class of cloud memory and CPU pressure that was hiding in plain sight. The mobile app's `MantleManager` subscribes to the Zustand `GlassesStore` and, on every field change, sends a partial device-state update to the cloud via `POST /api/client/device/state`. In production this fires tens of times per second per user during BLE-noisy periods, and several times per second even for stable connections. Each update triggers a full cloud-side cascade: model + capability recalculation, `stopIncompatibleApps` loop, `sendCapabilitiesUpdateToApps` broadcast, PostHog event, Mongo `User.findOrCreateUser`, and `MicrophoneManager.forceResync`. There is no dedup, no rate limit, no "did anything actually change" guard. This is the reconnection storm, and it is pod-global: 100+ updates per minute sustained on us-central.

**Why this doc exists:** Cloud memory growth on us-central between 17:00 and 21:00 UTC on April 17, 2026 (RSS 733 MB → 1153 MB, session count flat) was being blamed on the France-style Soniox leak and the 078 ownership census. But the 078 census attributes only 0.08% of heap. The real allocation pressure is coming from a cascade that fires ~100 times per minute and allocates fresh objects for log statements, PostHog events, Mongo promises, capability objects, and WebSocket messages to subscribed apps. This is not one bug in one user's session. It is a pod-global firehose.

**Who should read this:** Cloud engineers, mobile engineers, anyone investigating cloud memory growth, anyone who has been debugging BLE stability on the mobile side. This is a joint mobile + cloud issue.

**Depends on:**

- [078-memory-ownership-census](../078-memory-ownership-census/) — the census that proved the leak is not in session-scoped structures
- [079-client-liveness-reconnect-gap](../079-client-liveness-reconnect-gap/) — related but different failure mode (client dying vs client overcommunicating)
- [075 hot-path fragmentation](../../issues/complete/) — same class of "allocation on every event" root cause
- [034-ws-liveness](../034-ws-liveness/) — client state-machine context

---

## The Problem In One Sentence

The mobile app sends `POST /api/client/device/state` on every Zustand `GlassesStore` field change, with no debounce and no "value actually changed" check, and the cloud runs a full capability-recompute + Mongo + PostHog + app-broadcast cascade on every request — which means a BLE-jittery phone or an overly chatty subscription can generate a hundred-plus full pipeline runs per minute per pod.

---

## Background

### Mobile side

`mobile/src/services/MantleManager.ts` sets up a Zustand subscription:

```typescript
useGlassesStore.subscribe(
  getGlasesInfoPartial,
  (state, previousState) => {
    const statusObj = {}
    for (const key in state) {
      if (state[key] !== previousState[key]) {
        statusObj[key] = state[key]
      }
    }
    restComms.updateGlassesState(statusObj)
  },
  {equalityFn: shallow},
)
```

`getGlasesInfoPartial` returns a 10+ field projection of the GlassesStore:

```typescript
{
  batteryLevel, charging, caseBatteryLevel, caseCharging,
  connected, wifiConnected, wifiSsid, deviceModel, modelName, ...
}
```

Any of these changing fires `restComms.updateGlassesState(statusObj)`, which POSTs the diff to `/api/client/device/state`.

`WebSocketManager.onConnect()` independently calls `restComms.updateGlassesState(getGlasesInfoPartial(...))` with the **full** state on every WebSocket reconnect. So WS reconnects also feed the firehose.

Separately, `SocketComms.sendGlassesConnectionState()` (the legacy WS message of the same name) still exists in the mobile codebase but is not actually called anywhere — dead code from before the REST migration documented in `cloud/issues/complete/device-state/`.

### Cloud side

`POST /api/client/device/state` → `DeviceManager.updateDeviceState(payload)`:

```typescript
async updateDeviceState(payload) {
  this.logger.info({...}, "Updating device state");  // always logs

  // infer connected from modelName if undefined
  // merge payload into this.deviceState

  if (payload.connected !== undefined) {
    await this.handleGlassesConnectionState(...)   // heavy cascade
    this.userSession.microphoneManager?.handleConnectionStateChange(...)
  } else if (modelChanged && payload.modelName) {
    await this.updateModelAndCapabilities(payload.modelName)
  }

  this.logger.info({...}, "Device state updated successfully");
  this.broadcastDeviceStateToApps(payload);  // WS broadcast to every subscribed app
}
```

And `handleGlassesConnectionState`:

```typescript
async handleGlassesConnectionState(modelName, status) {
  this.logger.info({...}, "Handling GLASSES_CONNECTION_STATE");   // always
  this.userSession.microphoneManager?.handleConnectionStateChange(status);
  //   → MicrophoneManager logs "Glasses CONNECTED, forcing mic state resync"
  //   → MicrophoneManager.forceResync() — always on CONNECTED/RECONNECTED

  if (isConnected && model) {
    await this.updateModelAndCapabilities(model);        // rebuild capabilities
    this.sendCapabilitiesUpdateToApps();                 // WS broadcast to all subscribed apps
    await this.stopIncompatibleApps(...);                // loop every running app

    const user = await User.findOrCreateUser(...);       // Mongo round-trip
    await user.addGlassesModel(model);                   // Mongo write (no-op if already present)
    await PosthogService.setPersonProperties(...);       // PostHog API call
    if (isNewModel) await PosthogService.trackEvent(...);// PostHog API call
  }
  await PosthogService.trackEvent(...);                  // PostHog API call (always)
}
```

There is **no short-circuit** comparing the incoming payload to the current state. Every request runs the entire pipeline.

---

## Production Evidence

All evidence below from BetterStack prod logs on April 17, 2026.

### 1. One user sending the same payload 5 times per second

User `<redacted>` over 3 seconds on us-central at 23:21:54–23:21:57 UTC:

```text
23:21:54.086  Updating device state  {"modelName":"Even Realities G1"}
23:21:54.121  Updating device state  {"modelName":"Even Realities G1"}
23:21:54.170  Updating device state  {"modelName":"Even Realities G1"}
23:21:54.187  Updating device state  {"modelName":"Even Realities G1"}
23:21:54.227  Updating device state  {"modelName":"Even Realities G1"}
23:21:54.512  Updating device state  {"batteryLevel":-1,"caseBatteryLevel":-1,"caseCharging":false,"charging":false,"connected":true,"deviceModel":"Even Realities G1","modelName":"Even Realities G1","wifiConnected":false,"wifiSsid":""}
23:21:55.476  Updating device state  {"modelName":"Even Realities G1"}
23:21:55.492  Updating device state  {"modelName":"Even Realities G1"}
23:21:55.528  Updating device state  {"modelName":"Even Realities G1"}
23:21:55.563  Updating device state  {"modelName":"Even Realities G1"}
23:21:55.590  Updating device state  {"batteryLevel":26}
23:21:56.897  Updating device state  {"modelName":"Even Realities G1"}
23:21:56.939  Updating device state  {"modelName":"Even Realities G1"}
23:21:56.974  Updating device state  {"modelName":"Even Realities G1"}
23:21:57.023  Updating device state  {"modelName":"Even Realities G1"}
```

**15 updates in 3 seconds.** 13 of them are the _same single-field payload_ `{"modelName": "Even Realities G1"}` — identical to the current cloud state. Every one of them runs the full cascade. This is not BLE churn; this is the mobile Zustand subscription firing for some internal re-render and the cloud has no guard.

### 2. Double-cascade from a single real event

User `<redacted>` at 23:05:55 UTC:

```text
23:05:55.028  Updating device state          {"modelName":"Even Realities G1"}
23:05:55.028  Handling GLASSES_CONNECTION_STATE         (no args — CONNECTED inferred from modelName)
23:05:55.042  Device state updated successfully
23:05:55.095  Updating device state          {"modelName":"Even Realities G1", "connected":false, "batteryLevel":-1, ...}
23:05:55.095  Handling GLASSES_CONNECTION_STATE         (this time DISCONNECTED)
23:05:55.095  Device state updated successfully
```

A single underlying connect/disconnect event on the phone became **two cloud-side cascades 67 ms apart**, one of which inferred `connected: true` from a stale partial and the other declared `connected: false`. The cloud cannot tell which was the correct final state without more context. Meanwhile it fully executed both pipelines: Mongo, PostHog, capability rebuild, app broadcast, `MicrophoneManager.forceResync`. Twice. For one physical event.

### 3. Pod-global firehose

`device-state` updates per 30 minutes, last 8 hours on us-central:

```text
15:30 UTC   1024 updates / 45 users /  22.8 per user
16:00 UTC   1617 updates / 54 users /  29.9 per user
16:30 UTC   4299 updates / 56 users /  76.8 per user  ← jump starts
17:00 UTC   4413 updates / 65 users /  67.9 per user
18:30 UTC   3239 updates / 63 users /  51.4 per user
19:00 UTC   3926 updates / 67 users /  58.6 per user
20:30 UTC   3934 updates / 56 users /  70.2 per user
21:30 UTC   3472 updates / 60 users /  57.9 per user
22:30 UTC   3524 updates / 68 users /  51.8 per user
23:00 UTC   2384 updates / 52 users /  45.8 per user
```

**Sustained 100–150 updates per minute pod-wide**, with ~50–70 updates per user per 30 minutes — i.e. roughly one update every 25–40 seconds per user under a "stable" connection.

This is ~3x France's per-user rate (France in the same window saw ~8 per user per 30m with 4 affected users, vs us-central's ~55 per user with 48 affected users).

### 4. Correlation with cloud memory growth

us-central RSS on the same day, same pod (19 h uptime, no restarts):

```text
13:15 UTC   669 MB RSS / 378 MB heap / 50 sess
15:45 UTC   725 MB RSS / 234 MB heap / 50 sess     ← healthy, GC sawtooth working
17:00 UTC   733 MB RSS / 318 MB heap / 58 sess
19:00 UTC   948 MB RSS / 611 MB heap / 58 sess     ← ramp starts
21:00 UTC  1131 MB RSS / 788 MB heap / 66 sess     ← +418 MB over 4h, sess ~flat
21:20 UTC  1153 MB RSS / 760 MB heap / 64 sess
```

The ramp starts around 16:30 UTC — the same window where device-state updates jumped from ~30 per user per 30m to ~77 per user per 30m. us-central's heap climbed +420 MB over 4 hours while session count stayed essentially flat (58 → 64). The 078 ownership census attributes **0.08 % of heap** to anything it knows about, so the growth is not in session-owned structures. It is in transient allocation pressure: log objects, PostHog payloads, promise chains, WS frames, capability objects — exactly what the device-state cascade produces on every request.

GC freed **0 MB** on consecutive probes during the climb. That signature (GC running but reclaiming nothing) indicates the allocated objects are becoming reachable long enough to survive young-gen and then get reused, forcing V8 to grow `heapTotal` and never shrink it.

### 5. It's not one user — it's a systemic client-side pattern

Top emitters on us-central in the last 30 minutes:

```text
user-A          920 updates  30.7 / min
user-B         520 updates  17.3 / min
user-C              342 updates  11.4 / min
user-D            234 updates   7.8 / min
user-E     43 updates   1.4 / min
```

Five users in one 30-minute window firing anywhere from 1.4 to 30.7 updates/min, all on the same pod. Anonymized below, but the top offender was sustaining ~30 updates per minute for a full half hour without a visible BLE-level disruption — the `modelName` was never changing.

---

## Why the Phone Is Doing This

Short answer: the mobile `MantleManager` Zustand subscription is too broad.

`getGlasesInfoPartial` projects **10+ fields** from `GlassesStore`. The subscription's equality is `shallow` — which is correct for detecting changes — but the individual fields are updated from many independent native sources:

- Battery level polling (bumps `batteryLevel`)
- Charging state observer (bumps `charging`)
- Case battery/charging observers
- WiFi state observer (bumps `wifiConnected`, `wifiSsid`)
- BLE connection callbacks (bump `connected`, `deviceModel`, `modelName`)
- OTA progress, fully-booted, etc.

Every one of those native state changes triggers the subscription. The mobile side sends only the diff (good), but the cloud side executes the full pipeline regardless of whether the diff semantically means anything for device-state.

Even without BLE churn, normal phone activity produces several updates per minute per user:

- battery polling → 1 update every 30–60 s
- charging state flip → 1 update
- wifi state flip → 1 update
- plus whatever the native G1 / Live layer emits

Add BLE churn, case open/close, wifi connecting/disconnecting, and you get 30+/min.

### The specific "modelName hammering" bug

The 13-identical-`modelName` bursts (Finding 1) are separate from battery/wifi. Looking at the Zustand wiring, this almost certainly is the Zustand `CoreModule.addListener("glasses_status", ...)` fanout: when the native side emits a status update, `useGlassesStore.getState().setGlassesInfo(changed)` fires, which re-runs the selector, which — if `shallow` returns `false` for any reason (new object reference for an unchanged string, for instance) — fires the subscription. This is a client-side bug where the phone is emitting spurious state updates that don't represent a real change.

Without fixing the phone, the cloud can at minimum stop executing the pipeline when nothing actually changed.

---

## What Should Happen (And Doesn't)

On the cloud side, `updateDeviceState(payload)` should:

1. **Compare payload to `this.deviceState`.** If every field in `payload` already matches, return immediately. No log, no broadcast, no Mongo, no PostHog.
2. **For remaining fields, detect which actually changed.** Only fire cascades for the changed subset.
3. **Coalesce rapid updates.** If a user is firing >1 update/sec, debounce by 500 ms–1 s and process the last value.
4. **Rate-limit per-session.** If a user is sustaining >5 updates/sec for >10 s, log once and drop subsequent updates until they slow down.
5. **Make `MicrophoneManager.forceResync` a no-op** when the connection state did not change. Today it always fires on CONNECTED / RECONNECTED.

On the mobile side, `MantleManager`'s subscription should:

1. **Split the subscription** by concern (battery separate from connection, etc.), so a battery tick does not trigger a `/device/state` POST that includes stale connection fields.
2. **Coalesce rapid changes** in JS-side with a short debounce before POSTing, especially during BLE reconnect.
3. **Skip POSTs where the diff is empty or only contains currently-unknown sentinels** (e.g. `batteryLevel: -1` when battery is transiently unknown during BLE settlement).
4. **Audit whether `shallow` comparison is actually working**; the 13-identical-modelName bursts suggest it isn't, possibly because upstream event sources are allocating new string references for the same value.

---

## Findings

| Finding                                                                                                                                                                                    | Confidence                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Mobile sends `POST /api/client/device/state` on every `GlassesStore` field change, with no cloud-side debounce                                                                             | **High** (mobile code in `MantleManager.ts`, cloud code in `DeviceManager.ts`) |
| The same single-field payload (`{"modelName": "..."}`) can be sent 5+ times per second from one phone with no underlying state change                                                      | **Confirmed in prod** (Finding 1)                                              |
| A single physical disconnect produces two opposing cascades (CONNECTED then DISCONNECTED) 67 ms apart because the mobile side sends a `modelName`-only partial followed by a full snapshot | **Confirmed in prod** (Finding 2)                                              |
| The cloud-side cascade is heavy: Mongo, PostHog, capability rebuild, `stopIncompatibleApps`, `MicrophoneManager.forceResync`, `broadcastDeviceStateToApps`                                 | **Confirmed from code**                                                        |
| us-central runs 100–150 updates/min sustained, ~50–70 per user per 30 min, even without BLE disruption                                                                                     | **Confirmed in prod** (Finding 3)                                              |
| The rate of updates correlates with a +420 MB RSS climb in 4 hours on us-central with no session-count change                                                                              | **Strong correlation** (Finding 4)                                             |
| The 078 memory census cannot see this because the allocations are transient (garbage-collected) but create enough churn to force V8 `heapTotal` growth that never shrinks back             | **High** (matches France pattern from earlier investigation)                   |
| This is systemic, not one user: five users in the last 30 min on us-central emitting 1.4–30.7 updates/min                                                                                  | **Confirmed in prod** (Finding 5)                                              |

---

## Why This Is A Separate Issue

It is not the Soniox translation leak (issue 078 / 098) — that is a retained-structure bug in `utterancesByLanguage`.
It is not the client-liveness reconnect gap (issue 079) — that is the client _failing to reconnect_. This is the client _reconnecting too aggressively_ and the cloud servicing every ping as if it were new information.
It is not 075 hot-path fragmentation — that was the audio/log loop; this is the device-state loop.

All three produce similar cloud-side symptoms (heap growth, `heapTotal` ratchet, GC freeing nothing) because they all share the same underlying mechanism: **transient allocation pressure from hot-path handlers**. But the triggers are different and so are the fixes.

---

## Conclusions

| Conclusion                                                                                                                | Confidence              |
| ------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| The mobile app is sending far more `/api/client/device/state` updates than the cloud is designed to absorb                | **High**                |
| The cloud has no dedup / debounce / rate-limit / "did anything change" guard on this endpoint                             | **Confirmed from code** |
| This is the dominant allocation-pressure source currently visible on us-central, and correlates with the 420 MB RSS climb | **Strong**              |
| Both sides need fixes. Cloud side is the cheaper, faster fix; mobile side is the correct fix                              | **High**                |
| This issue is independent of 078 (transcript history), 079 (client liveness), and 075 (hot-path fragmentation)            | **High**                |

---

## Recommended Language For Team Discussion

> We have a new memory-pressure root cause. The mobile app's `MantleManager` subscribes to the `GlassesStore` and sends `POST /api/client/device/state` on every field change, with no debounce. The cloud runs a full capability-recompute + Mongo + PostHog + app-broadcast pipeline on every request, with no "did anything actually change" guard. Production data shows a single user can send the same `modelName` payload 5+ times per second, and a busy pod processes 100+ of these cascades per minute sustained for hours. The resulting allocation pressure drives `heapTotal` to grow and never shrink back. The 078 census can't see this because the allocations are transient, not retained.

Short version:

> Mobile sends a device-state update per `GlassesStore` field change with no debounce. Cloud runs a full heavy cascade on every request with no dedup. 100+/min sustained on us-central. Fixes needed on both sides.

---

## Next Steps

1. **`spec.md` for this issue** — specifies:
   - cloud-side: equality guard on `updateDeviceState`, debounce, rate-limit per session, `MicrophoneManager.forceResync` only on true state transitions
   - mobile-side: split the `MantleManager` subscription, add a client-side coalescer, investigate why `shallow` is not deduping identical `modelName` values
2. **`design.md` for this issue** — file-by-file diff, rollout order, verification plan
3. **Immediate cloud-only mitigation** — one small PR that adds the "payload fields already match current state → return early" guard. This is safe, reversible, and will drop us-central device-state volume by an estimated 60–80% without any mobile deploy.
4. Instrument `/api/client/device/state` with a counter (per user, per pod) and a histogram of payload-vs-current-state delta size. Add to the 078 / bstack CLI so we can confirm the fix lands.
5. Coordinate with mobile to investigate the `MantleManager` Zustand subscription and the spurious `modelName` events. Likely a separate mobile PR.
6. When both are deployed, re-run the comparison on us-central. Expected result: device-state updates/min drop below 20, RSS ramp stops, `heapTotal` begins shrinking during idle periods again.

---

## Appendix: Files Involved

**Mobile:**

- `mobile/src/services/MantleManager.ts` — `setupSubscriptions()` attaches the Zustand subscription at L183
- `mobile/src/services/RestComms.ts` — `updateGlassesState()` at L253, POSTs to `/api/client/device/state`
- `mobile/src/services/WebSocketManager.ts` — `onConnect()` at L66 re-sends the full state on every WS reconnect
- `mobile/src/stores/glasses.ts` — `getGlasesInfoPartial()` at L26, the projection that the subscription uses
- `mobile/src/services/SocketComms.ts` — legacy `sendGlassesConnectionState()` at L102, unused dead code

**Cloud:**

- `cloud/packages/cloud/src/api/hono/client/device-state.api.ts` — REST endpoint
- `cloud/packages/cloud/src/services/session/DeviceManager.ts`:
  - `updateDeviceState()` at L110 — entry point, no dedup
  - `handleGlassesConnectionState()` at L235 — heavy cascade
  - `broadcastDeviceStateToApps()` — broadcasts to every subscribed app
- `cloud/packages/cloud/src/services/session/MicrophoneManager.ts` — `handleConnectionStateChange()` at L295, always calls `forceResync()` on CONNECTED
- `cloud/packages/cloud/src/services/session/UserSettingsManager.ts` — `applyDefaultWearable()` at L269, triggered from REST settings updates and recursively calls `DeviceManager.setCurrentModel`
