# Spike: Transcription Stream Duplication & Subscription Routing Bugs

## Overview

**What this doc covers:** Investigation into why `com.mentra.captions.debug` stopped receiving transcriptions after a subscription update, plus related bugs found in stream deduplication, subscription aggregation, SDK-side event matching, and reconnect grace window handling.

**Why this doc exists:** On Feb 14 2026, captions.debug went silent on the dev server despite the user session being fully alive. The root cause is a set of interacting bugs in how `TranscriptionManager` manages streams, how `SubscriptionManager` aggregates subscriptions across apps, and how the SDK matches incoming data to registered handlers. These bugs affect all environments.

**Who should read this:** Anyone working on transcription, subscription management, or app session lifecycle in cloud or SDK.

---

## Background

### Complete end-to-end data flow

The full path from an app subscribing to transcription through to receiving data involves SDK → Cloud subscription → Soniox stream → Cloud relay → SDK event delivery. Understanding each hop is critical because bugs at different layers interact.

#### Phase 1: SDK registers a handler (app-side)

```
App calls session.events.onTranscriptionForLanguage("en-US", handler, { hints: ["ja"] })
  → EventManager.onTranscriptionForLanguage():
      cleanup previous handler via lastLanguageTranscriptioCleanupHandler()
      streamType = createTranscriptionStream("en-US", { hints: ["ja"] })
                 = "transcription:en-US?hints=ja"
      addHandler("transcription:en-US?hints=ja", handler):
        handlers.set("transcription:en-US?hints=ja", Set{handler})
        calls subscribe("transcription:en-US?hints=ja")
  → AppSession.subscribe():
      calls updateSubscriptions()
  → AppSession.updateSubscriptions():
      derivedSubscriptions = events.getRegisteredStreams()
                           = ["transcription:en-US?hints=ja", ...]
      sends SUBSCRIPTION_UPDATE message to cloud via WebSocket
```

Key files:

- `packages/sdk/src/app/session/events.ts` — `EventManager.addHandler()` (L391-400)
- `packages/sdk/src/types/streams.ts` — `createTranscriptionStream()` (L258-289) builds the subscription string with query params
- `packages/sdk/src/app/session/index.ts` — `updateSubscriptions()` (L1723-1752) derives subs from handlers (Bug 007 fix)

The subscription string **is the handler key**. The SDK matches incoming DataStream messages to handlers by exact string comparison against this key (L1363):

```
const hasHandler = this.events.getRegisteredStreams().includes(messageStreamType);
```

**Critical detail**: there is commented-out code in `handleMessage()` (L1350-1360) that would have reconstructed `messageStreamType` from `data.transcribeLanguage` instead of using `message.streamType` as-is. This code is NOT active.

#### Phase 2: Cloud processes the subscription update

```
Cloud receives SUBSCRIPTION_UPDATE
  → handleSubscriptionUpdate() [app-message-handler.ts L170]
    → subscriptionManager.updateSubscriptions(packageName, subscriptions)
      → processSubscriptionUpdate() [SubscriptionManager.ts L240]:
          converts bare "transcription" → createTranscriptionStream("en-US")
          but "transcription:en-US?hints=ja" already has prefix → passes through unchanged
          permission check (best-effort)
          appSession.updateSubscriptions(allowedProcessed):
            this._subscriptions = new Set(["transcription:en-US?hints=ja", ...])
          syncManagers()
```

Key file: `packages/cloud/src/services/session/SubscriptionManager.ts`

`syncManagers()` (L455-480) orchestrates all downstream managers:

```
syncManagers():
  transcriptionSubs = getTranscriptionSubscriptions()   // aggregates across ALL apps
  transcriptionManager.updateSubscriptions(transcriptionSubs)
  translationSubs = getTranslationSubscriptions()
  translationManager.updateSubscriptions(translationSubs)
  // then ensureStreamsExist() for both
  Promise.all([
    transcriptionManager.ensureStreamsExist(),
    translationManager.ensureStreamsExist(),
  ])
```

`getTranscriptionSubscriptions()` (L421-433) iterates ALL app sessions, collects all subs containing `"transcription"` (not `"translation"`), returns raw strings — **no dedup by base language**.

#### Phase 3: TranscriptionManager creates/manages Soniox streams

```
TranscriptionManager.updateSubscriptions(["transcription:en-US", "transcription:en-US?hints=ja"]):
  desired = new Set(validSubscriptions)       // {"transcription:en-US", "transcription:en-US?hints=ja"}
  current = new Set(this.streams.keys())      // keys of the streams Map

  // Stop streams no longer needed
  for (sub of current) if (!desired.has(sub)) → stopStream(sub)

  // Start streams that don't exist yet
  for (sub of desired) if (!current.has(sub)) → startStream(sub)

  this.activeSubscriptions = desired;
```

`startStream(subscription)` (L1068) → `createStreamInstance(subscription, provider)` (L1176):

- `languageInfo = getLanguageInfo(subscription)` parses subscription string
- For `"transcription:en-US?hints=ja"`: `{ transcribeLanguage: "en-US", options: { hints: "ja" } }`
- `provider.createTranscriptionStream("en-US", options)` — passes base language
- The Soniox stream stores `this.language = "en-US"` and `this.subscription = "transcription:en-US?hints=ja"`

`createStreamCallbacks(subscription)` (L1196) — **the closure captures `subscription`**:

```
onData: (data: any) => {
  this.relayDataToApps(subscription, data)  // subscription is closure variable
}
```

The Soniox stream config (`sendConfiguration()` at L458) parses `this.subscription` to extract hints. So `"transcription:en-US?hints=ja"` sends `language_hints: ["en", "ja"]` to Soniox.

#### Phase 4: Audio flows to all streams

`AudioManager.processAudioData()` (L581-587):

```
this.userSession.transcriptionManager.feedAudio(buf);
this.userSession.translationManager.feedAudio(buf);
```

`TranscriptionManager.feedAudioToStreams()` (L694-715) sends audio to **every stream in the Map**:

```
for (const [subscription, stream] of this.streams) {
  stream.writeAudio(normalized);
}
```

If two streams exist for the same language (one with hints, one without), audio goes to both. Double the Soniox API calls.

#### Phase 5: Soniox produces transcription data

`SonioxTranscriptionStream.processTranscriptionTokens()` (L739-749) builds `TranscriptionData`:

```
const interimData: TranscriptionData = {
  type: StreamType.TRANSCRIPTION,           // "transcription"
  transcribeLanguage: this.language,         // "en-US" — base language, NOT full subscription
  detectedLanguage: this.currentLanguage,    // actual detected language from Soniox
  text: currentInterim,
  ...
};
this.callbacks.onData?.(interimData);
```

Note: `transcribeLanguage` is always the base language code (`"en-US"`), never the full subscription string with hints.

#### Phase 6: Cloud relays data to apps

`TranscriptionManager.relayDataToApps(subscription, data)` (L1781-1901):

```
streamType = data.type = "transcription"

// Construct effective subscription from data
effectiveSubscription = "transcription:" + data.transcribeLanguage
                      = "transcription:en-US"                    // always base language, no hints

targetSubscriptions = getTargetSubscriptions(subscription, effectiveSubscription)
                    = [effectiveSubscription]                    // passthrough (dead code)

// Find apps subscribed to "transcription:en-US"
subscribedApps = subscriptionManager.getSubscribedApps("transcription:en-US")
  → for each app, checks each sub:
    → direct match: sub === "transcription:en-US"?
    → language match: parse sub → compare transcribeLanguage (ignoring query params)
    → "transcription:en-US?hints=ja" parsed → transcribeLanguage = "en-US" → MATCH ✅
  → returns BOTH recorder AND captions.debug

// Send DataStream to each matched app
DataStream = {
  type: "data_stream",
  streamType: subscription,     // ← closure value, e.g. "transcription:en-US?hints=ja"
  data: data,                   // contains transcribeLanguage: "en-US"
}
```

**Critical detail**: `DataStream.streamType` is set to the `subscription` parameter from the relay function — which comes from the `onData` callback closure. This is the **stream's own subscription string**, not what the app subscribed to.

So Stream A (subscription `"transcription:en-US"`) sends DataStream with `streamType: "transcription:en-US"`.
Stream B (subscription `"transcription:en-US?hints=ja"`) sends DataStream with `streamType: "transcription:en-US?hints=ja"`.

#### Phase 7: SDK receives and dispatches data

`AppSession.handleMessage()` (L1347-1370):

```
const messageStreamType = message.streamType;    // as-is from the message
// Commented-out code that would reconstruct from data.transcribeLanguage is NOT active

const hasHandler = this.events.getRegisteredStreams().includes(messageStreamType);
if (messageStreamType && hasHandler) {
  this.events.emit(messageStreamType, sanitizedData);
}
```

The `emit()` call in `EventManager` (L431-481) looks up handlers by exact key:

```
const handlers = this.handlers.get(event);  // event = messageStreamType
```

**This is an exact Map lookup**. `"transcription:en-US"` ≠ `"transcription:en-US?hints=ja"`.

### Interaction with VAD (Voice Activity Detection)

VAD controls stream lifecycle independently of subscription updates (`glasses-message-handler.ts` L171-205):

- **VAD speech detected** → `transcriptionManager.ensureStreamsExist()` — creates streams for all `activeSubscriptions`
- **VAD silence detected** → `transcriptionManager.cleanupIdleStreams()` — closes ALL streams immediately

When VAD silence fires, `cleanupIdleStreams()` (L221-254) closes every stream in the Map and clears it. When speech resumes, `ensureStreamsExist()` recreates streams from `activeSubscriptions`.

This means subscription updates and VAD events can interact:

1. Subscription update kills a stream and sets new `activeSubscriptions`
2. VAD silence immediately kills all remaining streams
3. VAD speech recreates streams from the new `activeSubscriptions`

This is normally fine — but during the transition, there's a window where no streams exist and any audio is silently dropped (unless VAD buffering catches it).

---

## Incident: captions.debug goes silent (Feb 14 2026, dev)

### Timeline

| Time (UTC)   | Event                                                                                                                                                                                                                 |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 20:02:34     | Dev pod restarts. Soniox providers initialized.                                                                                                                                                                       |
| 20:02:35.248 | Dashboard reconnects, sends rapid subscription updates. `syncManagers()` fires 10+ times. "No active subscriptions - all streams cleaned up" each time (apps still reconnecting).                                     |
| 20:02:35.269 | captions.debug starts: `stopped → connecting → running` (141ms).                                                                                                                                                      |
| 20:02:35.450 | **"Ignoring empty subscription update within reconnect grace window"** for captions.debug AND recorder.                                                                                                               |
| 20:02:35.480 | **Stream A created:** `transcription:en-US` (from recorder's subscription). `streamId: ...-ay1xlbo20`.                                                                                                                |
| 20:02:35.539 | captions.debug subscriptions updated.                                                                                                                                                                                 |
| 20:02:36.812 | **Stream B created:** `transcription:en-US?hints=ja` (from captions.debug's subscription). `streamId: ...-wgtn7wssu`.                                                                                                 |
| 20:02:38+    | **Both streams producing transcriptions simultaneously.** Stream A: "Testing, testing, one, two, three. We love testing." Stream B: "2023, we love testing" (garbled — Japanese hints bias Soniox on English speech). |
| 20:03:33.790 | captions.debug sends subscription update.                                                                                                                                                                             |
| 20:03:33.809 | `updateSubscriptions()`: **Stream B killed** (`en-US?hints=ja`).                                                                                                                                                      |
| 20:03:33.810 | "Started VAD audio buffering" then "All required streams already exist and are healthy" — Stream A satisfies the new `activeSubscriptions`. No new stream created.                                                    |
| 20:03:33.810 | "Language subscriptions changed for com.mentra.captions.debug"                                                                                                                                                        |
| 20:03:34.310 | Debounced transcription stream update fires → `microphoneManager.handleSubscriptionChange()`.                                                                                                                         |
| 20:03:34+    | **Only "Updated cached subscription state" logs every 5s.** No more transcription relay, no display requests. captions.debug is silent. Mic state unchanged (`hasMedia: true`).                                       |
| ~20:13       | User restarts captions.debug to fix it.                                                                                                                                                                               |

### What we know for certain

1. Two Soniox streams were created for the same base language (en-US) — **confirmed in logs**
2. Stream B was killed during subscription update — **confirmed in logs**
3. After Stream B was killed, "All required streams already exist" — meaning `activeSubscriptions` was satisfied by Stream A alone — **confirmed in logs**
4. No new stream was created — **confirmed by absence of "Creating Soniox transcription stream" log**
5. captions.debug stopped receiving transcription data — **confirmed by user**
6. Restarting captions.debug fixed it — **confirmed by user**
7. Mic remained on (`hasMedia: true` unchanged) — **confirmed by absence of state change log**

### What changed in captions.debug's subscription

"All required streams already exist" means the new `activeSubscriptions` set was `{"transcription:en-US"}` (just the one stream). This means `getTranscriptionSubscriptions()` returned only `["transcription:en-US"]` after the update.

For `"transcription:en-US?hints=ja"` to NOT be in that list, captions.debug must have changed its subscription from `"transcription:en-US?hints=ja"` to either:

- `"transcription:en-US"` (dropped hints), or
- nothing (unsubscribed from transcription entirely)

The fact that restarting fixed it suggests captions.debug re-subscribed to English transcription on restart. Combined with the "Language subscriptions changed" log, the most likely scenario is captions.debug changed its hint params.

---

## Bug Analysis

### Bug 1: Duplicate Soniox streams for the same base language (HIGH)

**Files:** `SubscriptionManager.ts` L421-433, `TranscriptionManager.ts` L125-170

**What happens:** `getTranscriptionSubscriptions()` collects raw subscription strings from all apps:

```typescript
// SubscriptionManager.ts L421-433
private getTranscriptionSubscriptions(): ExtendedStreamType[] {
  const subs: ExtendedStreamType[] = [];
  for (const [, appSession] of this.getAppSessionEntries()) {
    for (const sub of appSession.subscriptions) {
      if (typeof sub === "string" && sub.includes("transcription") && !sub.includes("translation")) {
        subs.push(sub);
      }
    }
  }
  return subs;
}
```

If recorder has `"transcription:en-US"` and captions.debug has `"transcription:en-US?hints=ja"`, these are different strings. `TranscriptionManager.updateSubscriptions()` puts them in a `Set` and creates a separate Soniox WebSocket for each:

```typescript
// TranscriptionManager.ts L143-144
const desired = new Set(validSubscriptions)
const current = new Set(this.streams.keys())
```

Both streams connect to Soniox with the same base language (`en-US`). Both receive the same audio via `feedAudioToStreams()`. Both produce transcriptions for the same speech.

**Impact:**

- 2x Soniox API cost per user with multiple English-transcription apps using different hints
- The `?hints=ja` stream produces worse English results (confirmed in logs: "Testing, testing, one, two, three" vs "2023, we love testing")
- Double bandwidth to Soniox

**Root cause:** No normalization of subscription strings to base language for stream creation.

---

### Bug 2: SDK streamType mismatch silently drops data (HIGH)

**Files:** `TranscriptionManager.ts` L1831-1837, `sdk/src/app/session/index.ts` L1347-1370

**What happens:** When a stream produces data, the `DataStream` message sent to apps carries `streamType` from the stream's **own closure** — not what the app subscribed to:

```typescript
// TranscriptionManager.ts L1831-1837 (in relayDataToApps)
const dataStream: DataStream = {
  type: CloudToAppMessageType.DATA_STREAM,
  sessionId: appSessionId,
  streamType: subscription as ExtendedStreamType, // ← stream's subscription string
  data,
  timestamp: new Date(),
}
```

The SDK matches incoming messages by exact string comparison:

```typescript
// sdk/src/app/session/index.ts L1349-1363
const messageStreamType = message.streamType as ExtendedStreamType
const hasHandler = this.events.getRegisteredStreams().includes(messageStreamType)
if (messageStreamType && hasHandler) {
  this.events.emit(messageStreamType, sanitizedData)
}
```

**Scenario that triggers data loss:**

Stream A has subscription `"transcription:en-US"`. Its onData closure sends `streamType: "transcription:en-US"`.
An app registered handler for `"transcription:en-US?hints=ja"` (because it called `onTranscriptionForLanguage("en-US", handler, { hints: ["ja"] })`).
Cloud side: `getSubscribedApps("transcription:en-US")` finds the app (language matching strips hints). ✅
Cloud side: sends DataStream with `streamType: "transcription:en-US"` to the app.
SDK side: `getRegisteredStreams()` = `["transcription:en-US?hints=ja"]`. Does it include `"transcription:en-US"`? **No.** → Data silently dropped. ❌

**In steady state with duplicate streams (Bug 1), this bug is masked:**

- Stream A (`en-US`) sends data → app with handler `"en-US?hints=ja"` → **dropped**
- Stream B (`en-US?hints=ja`) sends data → app with handler `"en-US?hints=ja"` → **matches** ✅

Each app effectively only receives from "its own" stream. The cloud wastes effort relaying to apps that will drop the data.

**When Bug 1 is fixed (only one stream per base language), Bug 2 becomes critical:**
If we deduplicate to a single stream, apps with hints subscriptions won't receive any data because the surviving stream's `streamType` won't match their handler key.

**There is commented-out code that would fix this** (L1350-1360):

```typescript
// if (message.streamType === StreamType.TRANSCRIPTION) {
//   const transcriptionData = message.data as TranscriptionData;
//   if (transcriptionData.transcribeLanguage) {
//     messageStreamType = createTranscriptionStream(transcriptionData.transcribeLanguage) as ExtendedStreamType;
//   }
// }
```

This code would reconstruct `messageStreamType` from `data.transcribeLanguage`, but it wouldn't include hints/options — so it would produce `"transcription:en-US"` for ALL transcription data, which still wouldn't match a handler for `"transcription:en-US?hints=ja"`.

**Impact:** Silent data loss when stream subscription string doesn't exactly match handler key. Masked by Bug 1's duplicate streams in steady state. Becomes the primary failure mode if Bug 1 is fixed naively.

---

### Bug 3: Stream killed, app potentially not re-routed (HIGH)

**File:** `TranscriptionManager.ts` L125-170, L281-397

**What happens:** When `updateSubscriptions()` runs after a subscription change:

1. Stream B (`en-US?hints=ja`) is stopped because it's no longer in `desired`
2. `activeSubscriptions` is set to new `desired` (e.g., `{"transcription:en-US"}`)
3. `ensureStreamsExist()` checks: does a stream exist for each active subscription? Stream A exists → "All required..."

The check is **stream-centric**: "does a stream exist for this subscription string?" It does NOT verify: "will each app's handler receive data from this stream?"

If captions.debug's new subscription is `"transcription:en-US"` (matching Stream A), then:

- Cloud relay: `getSubscribedApps("transcription:en-US")` → finds captions.debug ✅
- DataStream: `streamType: "transcription:en-US"` (from Stream A's closure) ✅
- SDK handler: registered for `"transcription:en-US"` → matches ✅

This should work. But if captions.debug's new subscription is `"transcription:en-US?hints=fr"` (changed hints):

- Cloud relay: `getSubscribedApps("transcription:en-US")` → finds captions.debug (language matching) ✅
- DataStream: `streamType: "transcription:en-US"` (from Stream A) ✅
- SDK handler: registered for `"transcription:en-US?hints=fr"` → **does NOT match** ❌

The cloud creates no new stream because `"transcription:en-US?hints=fr"` would produce a new stream in `updateSubscriptions`, BUT the logs show "All required streams already exist" meaning the new desired set was `{"transcription:en-US"}` — so either captions.debug changed to `"transcription:en-US"` exactly, or the aggregation lost the hints variant.

**Impact:** Depending on the exact subscription change, an app can end up in a state where the cloud thinks it's routing data correctly but the SDK silently drops it.

---

### Bug 4: Reconnect grace window + boot storm causes stream churn (MEDIUM)

**File:** `AppSession.ts` L565-576

**What happens:** After a pod restart, all apps reconnect. The reconnect flow:

1. App connects → `stopped → connecting → running`
2. App sends initial subscription update (often empty `[]` as a "hello")
3. App sends real subscription update with actual subs

Step 2 hits the grace window:

```typescript
// AppSession.ts L570-576
if (newSubscriptions.length === 0 && timeSinceReconnect <= SUBSCRIPTION_GRACE_MS) {
  return {applied: false, reason: "Empty subscription ignored during grace window"}
}
```

Meanwhile, dashboard (which reconnected first) sends its own subscription updates, each triggering `syncManagers()`. Between 20:02:35.222 and 20:02:35.417 — **195ms** — `syncManagers()` was called **10+ times**, each time seeing "No active subscriptions - all streams cleaned up" because only dashboard was connected and it doesn't subscribe to transcription.

Each `syncManagers()` call triggers `TranscriptionManager.updateSubscriptions()` and `ensureStreamsExist()`, churning through stream lifecycle for no reason.

**Impact:** Wasted compute during boot. Potential race conditions if a real subscription arrives mid-churn. Noisy logs.

---

### Bug 5: `getTargetSubscriptions()` is dead code (LOW)

**File:** `TranscriptionManager.ts` L1773-1779

```typescript
private getTargetSubscriptions(
  streamSubscription: ExtendedStreamType,
  effectiveSubscription: ExtendedStreamType,
): ExtendedStreamType[] {
  return [effectiveSubscription];
}
```

This used to handle routing data from one stream to multiple subscription targets (optimization mapping). Now it's a passthrough. The relay always uses `effectiveSubscription` (constructed from `data.transcribeLanguage`) for the `getSubscribedApps()` lookup, while the DataStream message uses the closure's `subscription`.

**Impact:** Code that looks meaningful but does nothing. Makes the relay flow harder to understand.

---

### Bug 6: Cloud relays data to apps that can't receive it (LOW, but wasteful)

**Files:** `TranscriptionManager.ts` L1781-1901, `SubscriptionManager.ts` L73-113

`getSubscribedApps("transcription:en-US")` matches by base language (strips query params). So it finds ALL apps subscribed to English transcription, regardless of hints. But the DataStream carries the stream's specific subscription string. Apps with a different hint variant will receive the message from the cloud (network cost, CPU cost) only to have the SDK silently drop it.

In the observed scenario with two streams:

- Stream A (`en-US`) relays to both recorder and captions.debug → recorder handles it, captions.debug drops it
- Stream B (`en-US?hints=ja`) relays to both recorder and captions.debug → captions.debug handles it, recorder drops it

**Impact:** 2x network traffic, wasted CPU on both cloud and SDK sides. Every transcription data point is sent twice to every English-subscribed app, with half being silently dropped.

---

### Bug 7: `onClosed` callback races with `stopStream` on `activeSubscriptions` (LOW, time bomb)

**File:** `TranscriptionManager.ts` L1209-1226, L1160-1174

When `stopStream(subscription)` is called from `updateSubscriptions()`:

```typescript
// stopStream (L1160-1174)
await stream.close() // triggers onClosed callback
this.streams.delete(subscription) // explicit cleanup
this.streamRetryAttempts.delete(subscription)
```

The `onClosed` callback (L1209-1226) fires during or after `stream.close()`:

```typescript
onClosed: (code?: number) => {
  this.streams.delete(subscription) // closure variable — same subscription
  const isAbnormalClose = code !== undefined && code !== 1000
  if (isAbnormalClose && this.activeSubscriptions.has(subscription)) {
    this.scheduleStreamReconnect(subscription)
  }
}
```

The race: `updateSubscriptions` sets `this.activeSubscriptions = desired` AFTER the stop/start loop. If `onClosed` fires asynchronously after `stopStream` returns but before `activeSubscriptions` is updated, it checks the OLD `activeSubscriptions` which still contains the removed subscription. With an abnormal close code, this would schedule a reconnect for a subscription that's no longer desired.

Currently benign because `stream.close()` sends a normal close (code 1000). But if the Soniox server closes with a non-1000 code during the close handshake, or if the close times out (code 1006), a phantom reconnect would be scheduled.

**Impact:** Currently benign. Potential for phantom stream reconnects if close handshake fails.

---

### Possible Bug 8: VAD + subscription update interaction (UNCERTAIN)

The log at 20:03:33.810 shows "Started VAD audio buffering" followed immediately by "All required streams already exist and are healthy". `ensureStreamsExist()` starts VAD buffering (L460-468) before checking if streams need creation:

```typescript
// Step 3: Start buffering audio for any new streams we might create
this.startVADBuffering();        // sets isBufferingForVAD = true, clears buffer

// Step 4: Create missing streams
for (...) { ... }

if (createPromises.length === 0) {
  "All required streams already exist and are healthy"
  this.flushVADBuffer();         // buffer is empty → sets isBufferingForVAD = false → returns
  return;
}
```

This is fine in isolation. But if a VAD silence event fires concurrently (from glasses message handler), `cleanupIdleStreams()` closes ALL streams. Then when VAD speech resumes, `ensureStreamsExist()` recreates from `activeSubscriptions`.

Whether this contributed to the silence is uncertain — we don't have VAD events in the log query. But the interaction between subscription updates and VAD creates a window where no streams exist.

**Impact:** Uncertain. Needs more log data to confirm or rule out.

---

## Summary

| Bug | Severity  | File(s)                                             | Description                                                                                  |
| --- | --------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | **High**  | SubscriptionManager.ts, TranscriptionManager.ts     | Duplicate Soniox streams for same base language (different hints). 2x cost.                  |
| 2   | **High**  | TranscriptionManager.ts, SDK index.ts               | DataStream `streamType` doesn't match SDK handler key. Silent data loss.                     |
| 3   | **High**  | TranscriptionManager.ts                             | Stream killed, `ensureStreamsExist` is stream-centric not app-centric. App can lose routing. |
| 4   | Medium    | AppSession.ts                                       | Reconnect grace window + rapid `syncManagers()` = stream churn during boot storm.            |
| 5   | Low       | TranscriptionManager.ts                             | `getTargetSubscriptions()` is dead code (passthrough).                                       |
| 6   | Low       | TranscriptionManager.ts, SubscriptionManager.ts     | Cloud relays to apps that can't receive (SDK drops). Wasted network/CPU.                     |
| 7   | Low       | TranscriptionManager.ts                             | `onClosed` races with `stopStream` on `activeSubscriptions`. Currently benign.               |
| 8   | Uncertain | TranscriptionManager.ts, glasses-message-handler.ts | VAD + subscription update concurrent interaction.                                            |

### Bug interaction diagram

```
Bug 1 (duplicate streams) ←── masks ──→ Bug 2 (SDK streamType mismatch)
       │                                        │
       │ fixing Bug 1 without                   │ when streams are deduped,
       │ fixing Bug 2 = apps                    │ mismatched streamType
       │ get NO data                            │ causes silent data loss
       │                                        │
       └── feeds into → Bug 6 (wasted relay) ──┘

Bug 3 (stream killed, not re-routed)
       │
       └── compounded by → Bug 4 (boot storm churn)
                                   │
                                   └── compounded by → Bug 8 (VAD interaction)
```

**Bugs 1 and 2 MUST be fixed together.** Fixing only Bug 1 (stream dedup) without Bug 2 (SDK matching) would cause all apps with hints to receive zero data. Fixing only Bug 2 (SDK matching) without Bug 1 (dedup) would reduce silent drops but not eliminate duplicate streams.

---

## TranslationManager comparison

`TranslationManager` (`packages/cloud/src/services/session/translation/TranslationManager.ts`) uses the same patterns:

- `updateSubscriptions()` uses Set comparison on raw strings (L92-150)
- `relayDataToApps(subscription, data)` uses `subscriptionManager.getSubscribedApps(subscription)` where subscription is the closure value (L805-870)
- DataStream uses `streamType: subscription` (L838)

Translation subscriptions are language-pair specific (`"translation:en-US-to-es-ES"`) so duplicate streams are less likely in practice — but the same structural bug exists. If two apps subscribe to the same translation pair with different options, duplicates would occur.

---

## Conclusions

The core issue is that **stream identity is coupled to raw subscription strings** at the stream creation layer, while **subscriber matching uses base-language comparison** at the relay layer, and **handler dispatch uses exact string matching** at the SDK layer. Three different matching semantics for the same concept.

The fix needs to align all three:

1. **Stream creation**: one stream per base language. Hints/options should be merged or the "best" config chosen.
2. **Relay routing**: DataStream `streamType` must use a canonical form that the SDK can match against any handler with the same base language.
3. **SDK dispatch**: either use language-aware matching (parse and compare base language, like the cloud's `getSubscribedApps` already does), or normalize the `streamType` in the message to match the handler key.

The simplest approach that fixes all HIGH bugs together:

- **Cloud side**: Normalize subscription strings to base language for stream creation. One Soniox stream per `"transcription:{lang}"`. Merge hints from all apps (or pick the best hint set, or ignore hints entirely — the logs show hints=ja made English transcription worse, not better).
- **Cloud side**: In `relayDataToApps`, set `DataStream.streamType` to the `effectiveSubscription` (base language form, e.g., `"transcription:en-US"`), not the stream's closure subscription.
- **SDK side**: Normalize `messageStreamType` before handler lookup. Parse the incoming `streamType`, extract base language, and match against handlers by base language (ignoring query params). OR: uncomment and fix the reconstruction code in `handleMessage()`.

The boot storm issue (Bug 4) is a symptom of `syncManagers()` being called too eagerly during reconnection, before all apps have re-established their subscriptions. A debounce or "all apps reconnected" gate on `syncManagers` would help, but it's lower priority than the data-loss bugs.

---

## Next Steps

1. Write **spec.md** with the fix design: stream dedup by base language, canonical streamType in DataStream, SDK-side matching normalization.
2. **Bugs 1 and 2 must be fixed together** in a single PR — fixing one without the other makes things worse.
3. Investigate whether the `?hints=` parameter actually improves Soniox quality enough to justify any special handling (the logs suggest it doesn't — it made English worse). If hints are not useful, the simplest fix is to strip them entirely during stream creation.
4. Verify the same patterns in `TranslationManager` and fix if needed.
5. Add logging at the SDK layer for when a DataStream message arrives but no handler matches — currently this is silent, making debugging very hard.
