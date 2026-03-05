# Spec: Transcription Stream Dedup & Subscription Routing Fix

## Overview

**What this doc covers:** The specification for fixing duplicate Soniox streams, silent data loss from streamType mismatches, and wasted relay traffic — the 3 HIGH severity bugs from the spike.

**Why this doc exists:** Bugs 1 and 2 are co-dependent. Fixing stream dedup without fixing SDK matching makes things worse (apps get zero data). This spec defines the minimal set of changes that fix all three HIGH bugs together in one PR.

**What you need to know first:** Read `spike.md` in this folder. Specifically the end-to-end data flow trace and the bug interaction diagram.

**Who should read this:** Anyone reviewing or implementing this fix across cloud and SDK.

---

## The Problem in 30 Seconds

Three layers of the system use three different matching semantics for transcription subscriptions:

| Layer                                    | Matching                            | Example                                                  |
| ---------------------------------------- | ----------------------------------- | -------------------------------------------------------- |
| Stream creation (`TranscriptionManager`) | Exact string                        | `"en-US"` ≠ `"en-US?hints=ja"` → **two Soniox streams**  |
| Subscriber lookup (`getSubscribedApps`)  | Base language (strips query params) | Both match → **sends data to both apps**                 |
| SDK handler dispatch (`EventManager`)    | Exact string                        | `"en-US"` ≠ `"en-US?hints=ja"` → **silently drops data** |

Result: duplicate streams (2x Soniox cost), each app only receives from "its own" stream by accident, and if a subscription update kills one stream, the surviving stream's data doesn't match the other app's handler key. App goes deaf.

---

## Spec

### Principle: Decouple stream identity from per-app options

A subscription string like `"transcription:en-US?hints=ja"` currently serves two purposes:

1. **Stream identity** — "which Soniox WebSocket do I need?"
2. **Stream configuration** — "what `language_hints` do I send to Soniox?"

These must be decoupled. Stream identity should be base language only (`"transcription:en-US"`). Configuration should be derived from the union of all subscribers' options.

### Change 1: Normalize stream identity to base language (Cloud)

**File:** `packages/cloud/src/services/session/transcription/TranscriptionManager.ts`

`updateSubscriptions()` currently uses raw subscription strings as Map keys and Set entries. After this change, it normalizes all subscription strings to base language form before comparing or storing.

**New helper** (in `TranscriptionManager` or a shared utility):

```
normalizeToBaseLanguage(subscription: ExtendedStreamType): ExtendedStreamType
```

Takes `"transcription:en-US?hints=ja"` → returns `"transcription:en-US"`.
Takes `"transcription:auto?no-language-identification=true"` → returns `"transcription:auto"`.
Takes `"transcription:en-US"` → returns `"transcription:en-US"` (no-op).

Uses `parseLanguageStream()` internally — already available in `@mentra/sdk/types/streams`. Strips everything after `?`. Returns the input unchanged if it's not a language stream.

**Updated `updateSubscriptions()`:**

```
async updateSubscriptions(subscriptions: ExtendedStreamType[]): Promise<void> {
  await this.ensureInitialized();

  // Filter translations
  const validSubscriptions = subscriptions.filter(/* existing logic */);

  // Normalize to base language for stream identity
  const normalizedDesired = new Set(validSubscriptions.map(normalizeToBaseLanguage));
  const current = new Set(this.streams.keys());

  // Stop removed
  for (const sub of current) {
    if (!normalizedDesired.has(sub)) await this.stopStream(sub);
  }

  // Start new
  for (const sub of normalizedDesired) {
    if (!current.has(sub)) await this.startStream(sub);
  }

  this.activeSubscriptions = normalizedDesired;

  // Update Soniox config on existing streams if options changed
  this.updateStreamConfigurations(validSubscriptions);
}
```

The `streams` Map is now keyed by base language form. One entry per language, one Soniox WebSocket per language.

**`updateStreamConfigurations(rawSubscriptions)`** is a new private method that:

1. Groups raw subscriptions by base language
2. For each language, merges options across all subscriptions:
   - `hints`: union of all hint arrays, deduplicated
   - `no-language-identification`: `false` (enabled) unless ALL subscriptions for that language want it disabled
3. If the merged config differs from what the current stream was initialized with, either:
   - (a) Reconfigure the stream in-place if the provider supports it, or
   - (b) Mark the stream for recreation on next `ensureStreamsExist()` call

For the initial implementation, option (b) is simpler and safer — just track "desired config" alongside the stream and let `ensureStreamsExist()` replace streams whose config is stale.

**However**, in practice, config changes are rare (they happen when an app adds/removes a hint). The common case is the initial stream creation, where we already have all subscriptions available. So the initial implementation can simply merge hints during `createStreamInstance()`:

**Updated `createStreamInstance()`:**

```
private async createStreamInstance(
  normalizedSubscription: ExtendedStreamType,  // base language form
  provider: TranscriptionProvider,
): Promise<StreamInstance> {
  const languageInfo = getLanguageInfo(normalizedSubscription)!;
  const streamId = this.generateStreamId(normalizedSubscription);

  // Merge options from all raw subscriptions for this base language
  const mergedOptions = this.getMergedOptionsForLanguage(normalizedSubscription);

  const callbacks = this.createStreamCallbacks(normalizedSubscription);

  const options = {
    streamId,
    userSession: this.userSession,
    subscription: this.buildSubscriptionWithOptions(normalizedSubscription, mergedOptions),
    callbacks,
  };

  return await provider.createTranscriptionStream(languageInfo.transcribeLanguage, options);
}
```

`getMergedOptionsForLanguage()` inspects all raw subscriptions that normalize to this base language and unions their options. `buildSubscriptionWithOptions()` reconstructs a subscription string with merged query params — this is what the Soniox stream uses in `sendConfiguration()` to extract hints.

### Change 2: Per-app streamType routing in DataStream (Cloud)

**File:** `packages/cloud/src/services/session/transcription/TranscriptionManager.ts`

In `relayDataToApps()`, the DataStream is currently constructed with:

```
streamType: subscription as ExtendedStreamType  // closure value from createStreamCallbacks
```

After Change 1, the closure value is the base language form (`"transcription:en-US"`). But old SDK apps have handlers registered with the full subscription string including query params (`"transcription:en-US?hints=ja"`). Old SDKs do exact string matching — `"transcription:en-US"` ≠ `"transcription:en-US?hints=ja"` — and silently drop the data.

**To maintain backward compatibility with old SDK versions**, the cloud must send each app its **own subscription string** as `streamType`, not the stream's normalized key. This way the old SDK's exact match succeeds because the `streamType` is literally what the app subscribed with.

**Updated `relayDataToApps()`** — when constructing the DataStream for each app, look up the app's own transcription subscription:

```
for (const packageName of subscribedApps) {
  const appSessionId = `${this.userSession.sessionId}-${packageName}`;

  // Find this app's actual subscription for this base language
  // so old SDKs can exact-match their handler key
  const appSubscription = this.findAppTranscriptionSubscription(
    packageName, data.transcribeLanguage
  );

  const dataStream: DataStream = {
    type: CloudToAppMessageType.DATA_STREAM,
    sessionId: appSessionId,
    streamType: (appSubscription || effectiveSubscription) as ExtendedStreamType,
    data,
    timestamp: new Date(),
  };
  // send...
}
```

**New private method `findAppTranscriptionSubscription()`:**

```
private findAppTranscriptionSubscription(
  packageName: string,
  transcribeLanguage: string,
): ExtendedStreamType | null {
  const appSubs = this.userSession.subscriptionManager.getAppSubscriptions(packageName);
  for (const sub of appSubs) {
    if (!isLanguageStream(sub as string)) continue;
    const parsed = parseLanguageStream(sub as ExtendedStreamType);
    if (parsed?.type === StreamType.TRANSCRIPTION &&
        parsed?.transcribeLanguage === transcribeLanguage) {
      return sub;
    }
  }
  return null;
}
```

**What this achieves:**

- recorder subscribed to `"transcription:en-US"` → gets `streamType: "transcription:en-US"` → old SDK exact match ✅
- captions subscribed to `"transcription:en-US?hints=ja"` → gets `streamType: "transcription:en-US?hints=ja"` → old SDK exact match ✅
- New SDK with `findMatchingStream()` → works with any `streamType` ✅

**Performance**: `getAppSubscriptions()` is an O(1) Map lookup returning the app's subscription Set. The linear scan of the Set is O(k) where k ≈ 3-8 (typical app subscription count). This runs once per app per data relay event (~5-20 Hz × 1-5 apps = 5-100 calls/sec). Negligible.

### Change 3: Language-aware handler matching in the SDK

**File:** `packages/sdk/src/app/session/index.ts`

In `handleMessage()`, the current code:

```typescript
const messageStreamType = message.streamType as ExtendedStreamType
const hasHandler = this.events.getRegisteredStreams().includes(messageStreamType)
if (messageStreamType && hasHandler) {
  const sanitizedData = this.sanitizeEventData(messageStreamType, message.data)
  this.events.emit(messageStreamType, sanitizedData)
}
```

After Changes 1+2, `messageStreamType` will be `"transcription:en-US"` (base language form). But the app's handler was registered with `"transcription:en-US?hints=ja"` (full subscription string). The exact `.includes()` check fails.

**New method on EventManager:**

```
findMatchingStream(incoming: ExtendedStreamType): ExtendedStreamType | null
```

For non-language streams: exact match (existing behavior).
For language streams: parse `incoming`, then iterate handler keys, parse each, compare `type` + `transcribeLanguage` (+ `translateLanguage` for translations). Return the first match. This mirrors what `getSubscribedApps()` already does on the cloud side.

**Updated `handleMessage()`:**

```typescript
} else if (isDataStream(message)) {
  const messageStreamType = message.streamType as ExtendedStreamType;
  const matchedStreamType = this.events.findMatchingStream(messageStreamType);
  if (matchedStreamType) {
    const sanitizedData = this.sanitizeEventData(matchedStreamType, message.data);
    this.events.emit(matchedStreamType, sanitizedData);
  }
}
```

This handles the case where the cloud sends `"transcription:en-US"` but the handler is registered for `"transcription:en-US?hints=ja"`. The `findMatchingStream` method finds the handler key by base language comparison, and `emit()` fires the correct handler.

**Note:** `findMatchingStream` should be O(n) where n = number of registered streams (typically 1–5). This is called per incoming DataStream message (interim transcriptions arrive at ~5–20 Hz). A linear scan of 1–5 entries is negligible.

### Change 4: Normalize getTranscriptionSubscriptions() output (Cloud)

**File:** `packages/cloud/src/services/session/SubscriptionManager.ts`

`getTranscriptionSubscriptions()` currently returns raw subscription strings from all apps. Two apps subscribing to `"transcription:en-US"` and `"transcription:en-US?hints=ja"` produce both strings, leading to two streams.

This method now deduplicates by base language but **preserves the full subscription strings** for option merging:

```
private getTranscriptionSubscriptions(): ExtendedStreamType[] {
  const subs: ExtendedStreamType[] = [];
  for (const [, appSession] of this.getAppSessionEntries()) {
    for (const sub of appSession.subscriptions) {
      if (typeof sub === "string" && sub.includes("transcription") && !sub.includes("translation")) {
        subs.push(sub);
      }
    }
  }
  return subs;  // Still returns ALL raw strings — dedup happens in TranscriptionManager
}
```

Actually, this method stays the same. The dedup happens in `TranscriptionManager.updateSubscriptions()` (Change 1), which receives the raw list and normalizes it. `TranscriptionManager` needs both the normalized keys (for stream identity) and the raw strings (for option merging).

So: **no change needed here**. `getTranscriptionSubscriptions()` returns raw strings. `TranscriptionManager` handles normalization internally.

### Change 5: Add SDK-side logging for unmatched DataStream messages

**File:** `packages/sdk/src/app/session/index.ts`

Currently when a DataStream arrives and no handler matches, it's silently ignored. Add a debug log:

```typescript
} else if (isDataStream(message)) {
  const messageStreamType = message.streamType as ExtendedStreamType;
  const matchedStreamType = this.events.findMatchingStream(messageStreamType);
  if (matchedStreamType) {
    const sanitizedData = this.sanitizeEventData(matchedStreamType, message.data);
    this.events.emit(matchedStreamType, sanitizedData);
  } else {
    this.logger.debug(
      {
        streamType: messageStreamType,
        registeredStreams: this.events.getRegisteredStreams(),
      },
      `[AppSession] Received DataStream with no matching handler: ${messageStreamType}`,
    );
  }
}
```

This makes future debugging much easier. Previously this was a black hole.

### Change 6: Remove dead code `getTargetSubscriptions()` (Cloud)

**File:** `packages/cloud/src/services/session/transcription/TranscriptionManager.ts`

Delete `getTargetSubscriptions()` and inline the single line it returns:

```typescript
// Before:
const targetSubscriptions = this.getTargetSubscriptions(subscription, effectiveSubscription)
const allSubscribedApps = new Set<string>()
for (const targetSub of targetSubscriptions) {
  const subscribedApps = this.userSession.subscriptionManager.getSubscribedApps(targetSub)
  subscribedApps.forEach((app) => allSubscribedApps.add(app))
}

// After:
const subscribedApps = this.userSession.subscriptionManager.getSubscribedApps(effectiveSubscription)
```

One fewer indirection. The loop over `targetSubscriptions` was always a single iteration.

---

## Behaviors

### Steady state: two apps, same base language, different hints

**Before:**

- recorder subscribes `"transcription:en-US"`, captions subscribes `"transcription:en-US?hints=ja"`
- Two Soniox streams created. Both receive audio. 2x cost.
- Each app only receives from "its own" stream (by accident via SDK exact matching)

**After:**

- One Soniox stream: `"transcription:en-US"` with merged config `language_hints: ["en", "ja"]`
- One audio feed. 1x cost.
- Both apps receive from the same stream.
- recorder gets DataStream with `streamType: "transcription:en-US"` (its own sub) → old and new SDK ✅
- captions gets DataStream with `streamType: "transcription:en-US?hints=ja"` (its own sub) → old SDK exact match ✅, new SDK `findMatchingStream` ✅

### Subscription update: app changes hints

**Before:**

- captions changes from `hints=ja` to `hints=fr`
- Stream B killed, Stream C created — or Stream B killed and "all required exist" (depends on timing)
- captions goes deaf if streamType doesn't match new handler key

**After:**

- captions changes from `hints=ja` to `hints=fr`
- Cloud receives new subscription: `"transcription:en-US?hints=fr"`
- `updateSubscriptions()` normalizes: `"transcription:en-US"` — same as before
- No stream killed, no stream created. `activeSubscriptions` unchanged.
- Merged hints updated: `["en", "ja"]` → `["en", "fr"]` (assuming recorder still has no hints: `["en", "fr"]`)
- If config changed, stream is reconfigured or recreated
- DataStream carries each app's own subscription string. Old and new SDKs both match. ✅

### Subscription update: app unsubscribes from transcription

**Before:**

- captions unsubscribes from transcription
- Stream B killed. Stream A survives. "All required exist."
- Depending on timing, captions may or may not have been receiving from Stream A anyway

**After:**

- captions unsubscribes
- `getTranscriptionSubscriptions()` returns only `["transcription:en-US"]` (from recorder)
- `updateSubscriptions()` normalizes: `{"transcription:en-US"}` — same as before
- No stream change. Merged hints recalculated (drops captions' hints).
- Relay: `getSubscribedApps("transcription:en-US")` no longer returns captions. ✅

### Boot storm: pod restart, apps reconnecting

**Before:**

- `syncManagers()` fires 10+ times as dashboard reconnects
- Each time: "No active subscriptions - all streams cleaned up"
- Streams churned as apps trickle in

**After:**

- Same behavior (this spec doesn't address boot storm directly — it's Bug 4, medium severity)
- But the impact is reduced: no duplicate streams created during the churn, so less wasted Soniox connections
- Future improvement: debounce `syncManagers()` during boot (separate issue)

### VAD interaction

**Before:**

- VAD silence: `cleanupIdleStreams()` closes all streams
- VAD speech: `ensureStreamsExist()` recreates from `activeSubscriptions`
- If duplicate streams existed, both are closed and both recreated

**After:**

- Same VAD lifecycle, but only one stream per language exists
- Recreated stream uses merged config from current subscribers
- No change in VAD behavior, just fewer streams to manage

### `onTranscription()` convenience method (no language specified)

The SDK has `onTranscription(handler)` which calls `createTranscriptionStream("en-US")` → `"transcription:en-US"`. This produces a handler key of `"transcription:en-US"` (no query params).

**Before and after:** Works the same. The base language form is the identity. No change needed.

### Translation streams

Translation subscriptions use a different format: `"translation:en-US-to-es-ES"`. They can also have `?no-language-identification=true`.

The same structural bug exists but is lower risk because translation subscriptions are language-pair-specific (less likely to collide across apps). **This spec does not change TranslationManager.** The same fix pattern can be applied later if needed.

However, Change 3 (SDK `findMatchingStream`) should handle translation streams too — `parseLanguageStream()` already handles both formats and compares `transcribeLanguage` + `translateLanguage`. So the SDK fix is forward-compatible.

---

## What explicitly does NOT change

1. **`SubscriptionManager.getSubscribedApps()`** — already does language-aware matching. No change.
2. **`SubscriptionManager.getTranscriptionSubscriptions()`** — still returns raw strings. Dedup is TranscriptionManager's job.
3. **`AppSession._subscriptions`** — still stores the full subscription string from the SDK. Apps retain their per-app options.
4. **`createTranscriptionStream()` in SDK** — still builds the full string with hints. Options are still communicated to cloud.
5. **`EventManager.addHandler()` / `removeHandler()` / handler Map keys** — still use the full subscription string. Only the _lookup_ changes (new `findMatchingStream`).
6. **`getRegisteredStreams()`** — still returns full strings (including hints). The subscription payload sent to cloud still carries options.
7. **Boot storm debounce** — separate issue, not addressed here.
8. **TranslationManager** — same structural bug but lower risk. Fix later.

---

## Decision Log

| Decision                                       | Alternatives considered                                                                                                               | Why we chose this                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Normalize stream identity to base language     | (a) Keep separate streams, fix only routing. (b) Strip options entirely.                                                              | (a) doesn't fix 2x cost. (b) loses hints for Soniox which may help multilingual users. Normalizing identity while merging options gets both.                                                                                                                                                                                                                                                            |
| Merge hints from all subscribers               | (a) Use first subscriber's hints. (b) Ignore hints entirely. (c) Let each app choose hints independently (separate streams).          | Union is the safest default. Soniox deduplicates hints internally. If a user has apps wanting `["ja"]` and `["fr"]` hints, sending `["en", "ja", "fr"]` covers both use cases.                                                                                                                                                                                                                          |
| Per-app `streamType` in DataStream             | (a) Always send base language form. (b) Send the stream's closure subscription.                                                       | (a) breaks old SDK apps that use hints or `disableLanguageIdentification` — their exact-match handler lookup fails. (b) is the current behavior, works by accident with duplicate streams but breaks when deduped. Per-app routing sends each app its OWN subscription string, so old SDKs exact-match correctly and new SDKs also work via `findMatchingStream`. Zero regressions for any SDK version. |
| Language-aware matching in SDK `handleMessage` | (a) Normalize handler keys to base language. (b) Always rely on per-app streamType from cloud. (c) Uncomment the reconstruction code. | (a) would break `getRegisteredStreams()` which is used for subscription payloads — options would be lost. (b) works for new cloud but not old cloud (old cloud sends stream's closure subscription, not per-app). (c) that code reconstructs without options, still doesn't match handler key. `findMatchingStream()` is a safety net that makes new SDK work with BOTH old and new cloud.              |
| Don't change `getTranscriptionSubscriptions()` | Dedup there instead of in TranscriptionManager.                                                                                       | TranscriptionManager needs both raw strings (for option merging) and normalized keys (for stream identity). Deduping in SubscriptionManager would lose the raw strings.                                                                                                                                                                                                                                 |
| Don't fix TranslationManager in this PR        | Fix it too.                                                                                                                           | Lower risk (translation subs are pair-specific), and we want a small, reviewable PR. Same pattern can be applied later.                                                                                                                                                                                                                                                                                 |
| `findMatchingStream` is O(n) linear scan       | Build a secondary index (Map from base language to handler key).                                                                      | n ≤ 5 in practice. A Map would need to be kept in sync with the handlers Map on every add/remove. Not worth the complexity.                                                                                                                                                                                                                                                                             |

---

## Edge Cases

### App subscribes to `"transcription:auto"` and another to `"transcription:en-US"`

These are different base languages (`auto` vs `en-US`). Two streams. `auto` is a special Soniox mode with no specific language set. No dedup — correct behavior.

### App subscribes to `"transcription:en-US?hints=ja"` then immediately to `"transcription:en-US?hints=fr"`

The SDK's `onTranscriptionForLanguage` calls `lastLanguageTranscriptioCleanupHandler()` before registering the new handler. So the old handler is removed first, then the new one is added. `updateSubscriptions()` fires once with the new subscription. Cloud normalizes to same base language. Stream persists, config may be updated (hints change from `ja` to `fr`). No stream churn.

### Two apps subscribe to the same language with conflicting `no-language-identification`

App A: `"transcription:en-US?no-language-identification=true"`
App B: `"transcription:en-US"`

Merged config: `enable_language_identification = true` (any app that wants it gets it). This is the safe default — language identification provides more information, and disabling it is an optimization that should only apply if ALL subscribers agree.

### App subscribes to transcription with ALL/WILDCARD stream type

`getSubscribedApps()` already handles `StreamType.ALL` and `StreamType.WILDCARD` as catch-alls. The DataStream `streamType` is the normalized base language. The catch-all match works regardless of the value. No change needed.

### Soniox stream needs recreation after config change

When merged options change (e.g., an app adds/removes hints), the current Soniox stream was initialized with the old config. Soniox doesn't support reconfiguring a live stream — the WebSocket config is sent once on connect.

Two approaches:

- **(a) Recreate the stream**: close the old Soniox WebSocket, create new one with updated config. Brief gap in transcription (~1-2s).
- **(b) Ignore config changes until next natural recreation**: VAD silence → cleanup → VAD speech → recreate with new config. No gap, but stale hints until next silence.

**Choose (b) for initial implementation.** Hints are an optimization, not critical for correctness. The stream will pick up new config on next VAD cycle (typically seconds to minutes). If we later find that config changes need to be immediate, we can add (a) behind a flag.

Track the "desired merged config" so that `ensureStreamsExist()` and VAD recreation use the latest config.

---

## Testing

### Unit tests

1. **`normalizeToBaseLanguage()`**: test with various inputs:
   - `"transcription:en-US"` → `"transcription:en-US"`
   - `"transcription:en-US?hints=ja"` → `"transcription:en-US"`
   - `"transcription:en-US?hints=ja,fr&no-language-identification=true"` → `"transcription:en-US"`
   - `"transcription:auto"` → `"transcription:auto"`
   - `"translation:en-US-to-es-ES?no-language-identification=true"` → `"translation:en-US-to-es-ES"`
   - `"audio_chunk"` → `"audio_chunk"` (non-language stream, no-op)

2. **`getMergedOptionsForLanguage()`**: test hint merging:
   - `["transcription:en-US", "transcription:en-US?hints=ja"]` → `{ hints: ["ja"] }`
   - `["transcription:en-US?hints=ja", "transcription:en-US?hints=fr,de"]` → `{ hints: ["ja", "fr", "de"] }`
   - `["transcription:en-US?no-language-identification=true", "transcription:en-US"]` → `{ noLanguageIdentification: false }`
   - `["transcription:en-US?no-language-identification=true"]` → `{ noLanguageIdentification: true }`

3. **`EventManager.findMatchingStream()`**:
   - `incoming: "transcription:en-US"`, handlers: `{"transcription:en-US?hints=ja"}` → returns `"transcription:en-US?hints=ja"`
   - `incoming: "transcription:en-US"`, handlers: `{"transcription:en-US"}` → returns `"transcription:en-US"`
   - `incoming: "transcription:en-US"`, handlers: `{"transcription:ja-JP"}` → returns `null`
   - `incoming: "transcription:en-US"`, handlers: `{"translation:en-US-to-es-ES"}` → returns `null`
   - `incoming: "translation:en-US-to-es-ES"`, handlers: `{"translation:en-US-to-es-ES?no-language-identification=true"}` → returns match
   - `incoming: "audio_chunk"`, handlers: `{"audio_chunk"}` → returns `"audio_chunk"` (exact match, non-language)
   - `incoming: "touch_event"`, handlers: `{}` → returns `null`

4. **`TranscriptionManager.updateSubscriptions()` dedup**:
   - Input: `["transcription:en-US", "transcription:en-US?hints=ja"]`
   - Result: `activeSubscriptions = {"transcription:en-US"}`, `streams.size === 1`
   - Input: `["transcription:en-US", "transcription:ja-JP"]`
   - Result: `activeSubscriptions = {"transcription:en-US", "transcription:ja-JP"}`, `streams.size === 2`

### Integration tests (manual or e2e)

1. **Two apps, same language, different hints**: Start recorder (en-US) and captions (en-US?hints=ja). Verify only one Soniox stream is created. Verify both apps receive transcription data. Verify Soniox config includes merged hints.

2. **Subscription change**: Start captions with hints=ja, then change to hints=fr. Verify no stream is killed or created. Verify captions continues receiving data without interruption.

3. **Subscription removal**: Start both apps, then stop captions. Verify stream survives. Verify recorder still receives data. Verify merged hints update (captions' hints removed on next stream recreation).

4. **Pod restart (boot storm)**: Restart the pod. Verify only one stream per language is created (not two). Verify all apps receive data after reconnection.

5. **SDK unmatched message logging**: Subscribe captions to a language, then manually send a DataStream with a non-matching streamType. Verify debug log appears.

---

## Rollout

### Order

1. **Cloud changes first** (Changes 1, 2, 4, 6): Deploy to debug. Verify only one Soniox stream per language in logs. Verify each app receives DataStream with its own subscription string as streamType. Old SDK apps should continue working immediately.

2. **SDK change** (Changes 3, 5): Deploy apps using updated SDK to debug. Verify `findMatchingStream` works as a safety net. Verify unmatched DataStream debug logging.

3. **Verify on dev**, then staging, then prod — standard progression.

### Backward compatibility

**New cloud → old SDK**: Cloud sends each app its **own subscription string** as `streamType` (Change 2). Old SDK does exact match against handler key. Since `streamType` equals the app's own subscription, the exact match succeeds. **Zero regressions for any old SDK app**, regardless of whether they use hints, `disableLanguageIdentification`, or plain subscriptions.

**New cloud → new SDK**: Cloud sends per-app `streamType`. New SDK's `findMatchingStream` matches (either exact or by base language). Works. ✅

**New SDK → old cloud**: Old cloud sends `streamType` from the stream's closure subscription (e.g., `"transcription:en-US?hints=ja"`). New SDK uses `findMatchingStream` which matches by base language → handler fires even if the app subscribed with different hints. **Strictly better than today.** ✅

**Old cloud → old SDK**: No change. Same as today. ✅

**Conclusion**: Cloud change is safe to deploy first and fixes old mini-apps immediately. SDK change is a safety net that improves behavior against both old and new cloud. Either can be deployed independently. Together they provide full coverage.

### Rollback

If issues are discovered:

- **Cloud rollback**: Revert to raw-string stream identity. Duplicate streams return (2x cost) but no data loss — apps go back to receiving from "their own" stream via the accidental exact-match routing.
- **SDK rollback**: Revert to exact match. Apps still work because new cloud sends per-app streamType. If cloud is also rolled back, behavior is same as today.

Both rollbacks are safe and independent. No data migration, no state to clean up.
