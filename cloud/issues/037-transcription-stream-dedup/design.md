# Design: Transcription Stream Dedup & Subscription Routing Fix

## Overview

**What this doc covers:** Implementation plan for the 6 changes in `spec.md` — which files change, what the code looks like before and after, and the rollout order.

**Why this doc exists:** The spec defines _what_ we're building. This doc defines _how_ — line-level changes, new functions, import additions, and test strategy.

**What you need to know first:** Read `spike.md` (bug analysis) and `spec.md` (behavioral spec, decision log, backward compat matrix) in this folder.

**Who should read this:** The implementer and reviewer of this PR.

---

## Changes Summary

| #   | Component | File                      | What changes                                                                                                                                                                       |
| --- | --------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Cloud     | `TranscriptionManager.ts` | `updateSubscriptions()` normalizes to base language. New `normalizeToBaseLanguage()`, `getMergedOptionsForLanguage()`, `buildSubscriptionWithOptions()`, `rawSubscriptions` field. |
| 2   | Cloud     | `TranscriptionManager.ts` | `relayDataToApps()` uses per-app subscription string as `DataStream.streamType`. New `findAppTranscriptionSubscription()`.                                                         |
| 3   | SDK       | `events.ts`               | New `findMatchingStream()` method on `EventManager`.                                                                                                                               |
| 4   | SDK       | `index.ts`                | `handleMessage()` uses `findMatchingStream()` instead of exact `.includes()`.                                                                                                      |
| 5   | SDK       | `index.ts`                | Debug log when DataStream arrives with no matching handler.                                                                                                                        |
| 6   | Cloud     | `TranscriptionManager.ts` | Delete `getTargetSubscriptions()`, inline in `relayDataToApps()`.                                                                                                                  |

---

## Change 1: Normalize stream identity to base language

### File: `packages/cloud/src/services/session/transcription/TranscriptionManager.ts`

#### 1a. New import

Add `isLanguageStream`, `parseLanguageStream` to the existing `@mentra/sdk` import (L7-15):

```diff
 import {
   ExtendedStreamType,
   getLanguageInfo,
+  isLanguageStream,
+  parseLanguageStream,
   StreamType,
   CloudToAppMessageType,
   DataStream,
   TranscriptSegment,
   LocalTranscription,
 } from "@mentra/sdk";
```

#### 1b. New field: `rawSubscriptions`

Add a field to track the raw (un-normalized) subscription strings from all apps. This is needed for option merging (hints, no-language-identification). Add alongside the existing `activeSubscriptions` field (L53-54):

**Before:**

```typescript
// Stream Management
private streams = new Map<string, StreamInstance>();
private activeSubscriptions = new Set<ExtendedStreamType>();
```

**After:**

```typescript
// Stream Management
private streams = new Map<string, StreamInstance>();
private activeSubscriptions = new Set<ExtendedStreamType>();
private rawSubscriptions: ExtendedStreamType[] = []; // un-normalized, for option merging
```

#### 1c. New helper: `normalizeToBaseLanguage()`

Add as a private method on `TranscriptionManager`. Place after `generateStreamId()` (~L1767):

```typescript
/**
 * Normalize a subscription string to its base language form.
 * Strips query parameters (hints, no-language-identification) so that
 * stream identity is based solely on language code.
 *
 * "transcription:en-US?hints=ja" → "transcription:en-US"
 * "transcription:auto"           → "transcription:auto"
 * "audio_chunk"                  → "audio_chunk" (non-language, no-op)
 */
private normalizeToBaseLanguage(subscription: ExtendedStreamType): ExtendedStreamType {
  if (typeof subscription !== "string") return subscription;

  const parsed = parseLanguageStream(subscription);
  if (!parsed) return subscription; // not a language stream

  if (parsed.type === StreamType.TRANSCRIPTION) {
    return `${StreamType.TRANSCRIPTION}:${parsed.transcribeLanguage}` as ExtendedStreamType;
  }
  if (parsed.type === StreamType.TRANSLATION && parsed.translateLanguage) {
    return `${StreamType.TRANSLATION}:${parsed.transcribeLanguage}-to-${parsed.translateLanguage}` as ExtendedStreamType;
  }

  return subscription;
}
```

#### 1d. New helper: `getMergedOptionsForLanguage()`

Add after `normalizeToBaseLanguage()`:

```typescript
/**
 * Merge options (hints, no-language-identification) from all raw subscriptions
 * that normalize to the given base language.
 *
 * Hints: union of all hint arrays, deduplicated.
 * no-language-identification: false (enabled) unless ALL subscribers disable it.
 */
private getMergedOptionsForLanguage(
  normalizedSubscription: ExtendedStreamType,
): { hints: string[]; disableLanguageIdentification: boolean } {
  const allHints = new Set<string>();
  let allDisable = true; // assume disabled until proven otherwise
  let hasAnySubscriber = false;

  for (const raw of this.rawSubscriptions) {
    if (this.normalizeToBaseLanguage(raw) !== normalizedSubscription) continue;
    hasAnySubscriber = true;

    const parsed = parseLanguageStream(raw);
    if (!parsed) continue;

    // Collect hints
    const hintsParam = parsed.options?.hints;
    if (hintsParam) {
      const hints = (hintsParam as string).split(",").map((h) => h.trim());
      hints.forEach((h) => allHints.add(h));
    }

    // Track language identification preference
    const disableParam = parsed.options?.["no-language-identification"];
    if (disableParam !== true && disableParam !== "true") {
      allDisable = false; // at least one subscriber wants it enabled
    }
  }

  return {
    hints: Array.from(allHints),
    disableLanguageIdentification: hasAnySubscriber ? allDisable : false,
  };
}
```

#### 1e. New helper: `buildSubscriptionWithOptions()`

Add after `getMergedOptionsForLanguage()`:

```typescript
/**
 * Reconstruct a subscription string with merged options.
 * Used so the Soniox stream's sendConfiguration() can extract hints.
 */
private buildSubscriptionWithOptions(
  normalizedSubscription: ExtendedStreamType,
  options: { hints: string[]; disableLanguageIdentification: boolean },
): string {
  let result = normalizedSubscription as string;
  const params = new URLSearchParams();

  if (options.hints.length > 0) {
    params.set("hints", options.hints.join(","));
  }
  if (options.disableLanguageIdentification) {
    params.set("no-language-identification", "true");
  }

  const qs = params.toString();
  return qs ? `${result}?${qs}` : result;
}
```

#### 1f. Update `updateSubscriptions()`

**Before (L125-170):**

```typescript
async updateSubscriptions(subscriptions: ExtendedStreamType[]): Promise<void> {
  await this.ensureInitialized();

  const validSubscriptions = subscriptions.filter((sub) => {
    if (typeof sub === "string" && sub.startsWith("translation:")) {
      this.logger.debug({ subscription: sub }, "Filtering out translation subscription - handled by TranslationManager");
      return false;
    }
    return true;
  });

  const desired = new Set(validSubscriptions);
  const current = new Set(this.streams.keys());

  this.logger.debug(
    {
      desired: Array.from(desired),
      current: Array.from(current),
      filtered: subscriptions.filter((s) => !validSubscriptions.includes(s)),
    },
    "Updating transcription subscriptions",
  );

  // Stop removed streams
  for (const subscription of current) {
    if (!desired.has(subscription)) {
      await this.stopStream(subscription);
    }
  }

  // Start new streams
  for (const subscription of desired) {
    if (!current.has(subscription)) {
      await this.startStream(subscription);
    }
  }

  this.activeSubscriptions = desired;
}
```

**After:**

```typescript
async updateSubscriptions(subscriptions: ExtendedStreamType[]): Promise<void> {
  await this.ensureInitialized();

  // Filter out translation subscriptions - handled by TranslationManager
  const validSubscriptions = subscriptions.filter((sub) => {
    if (typeof sub === "string" && sub.startsWith("translation:")) {
      this.logger.debug({ subscription: sub }, "Filtering out translation subscription - handled by TranslationManager");
      return false;
    }
    return true;
  });

  // Store raw subscriptions for option merging (hints, no-language-identification)
  this.rawSubscriptions = validSubscriptions;

  // Normalize to base language for stream identity
  // "transcription:en-US?hints=ja" → "transcription:en-US"
  const normalizedDesired = new Set(validSubscriptions.map((s) => this.normalizeToBaseLanguage(s)));
  const current = new Set(this.streams.keys());

  this.logger.debug(
    {
      raw: validSubscriptions,
      normalized: Array.from(normalizedDesired),
      current: Array.from(current),
    },
    "Updating transcription subscriptions (normalized)",
  );

  // Stop streams whose base language is no longer needed
  for (const subscription of current) {
    if (!normalizedDesired.has(subscription)) {
      await this.stopStream(subscription);
    }
  }

  // Start streams for new base languages
  for (const subscription of normalizedDesired) {
    if (!current.has(subscription)) {
      await this.startStream(subscription);
    }
  }

  this.activeSubscriptions = normalizedDesired;
}
```

#### 1g. Update `createStreamInstance()`

**Before (L1176-1194):**

```typescript
private async createStreamInstance(
  subscription: ExtendedStreamType,
  provider: TranscriptionProvider,
): Promise<StreamInstance> {
  const languageInfo = getLanguageInfo(subscription)!;
  const streamId = this.generateStreamId(subscription);

  const callbacks = this.createStreamCallbacks(subscription);

  const options = {
    streamId,
    userSession: this.userSession,
    subscription,
    callbacks,
  };

  return await provider.createTranscriptionStream(languageInfo.transcribeLanguage, options);
}
```

**After:**

```typescript
private async createStreamInstance(
  subscription: ExtendedStreamType,
  provider: TranscriptionProvider,
): Promise<StreamInstance> {
  const languageInfo = getLanguageInfo(subscription)!;
  const streamId = this.generateStreamId(subscription);

  // Merge options (hints, language ID) from all apps subscribing to this base language
  const mergedOptions = this.getMergedOptionsForLanguage(subscription);
  const subscriptionWithOptions = this.buildSubscriptionWithOptions(subscription, mergedOptions);

  this.logger.debug(
    {
      normalizedSubscription: subscription,
      mergedHints: mergedOptions.hints,
      disableLanguageIdentification: mergedOptions.disableLanguageIdentification,
      subscriptionWithOptions,
    },
    "Creating stream with merged options from all subscribers",
  );

  const callbacks = this.createStreamCallbacks(subscription);

  const options = {
    streamId,
    userSession: this.userSession,
    subscription: subscriptionWithOptions, // Soniox reads hints from this
    callbacks,
  };

  return await provider.createTranscriptionStream(languageInfo.transcribeLanguage, options);
}
```

Key detail: `callbacks` are still created with `subscription` (the normalized base language). This means the `onData` closure captures the base language form. But we override `options.subscription` with the merged-options version so Soniox gets the right `language_hints` config. The stream's `this.subscription` field (used in `sendConfiguration()`) will have the merged hints.

#### 1h. Update `ensureStreamsExist()` — normalize in stream health check

In `ensureStreamsExist()` (L281-397), the loop that checks existing streams uses `this.activeSubscriptions` which is now normalized. The `this.streams` Map keys are also normalized (from Change 1f). So `this.streams.get(subscription)` works correctly. **No change needed** to `ensureStreamsExist()` — it already compares normalized keys to normalized keys.

However, when `ensureStreamsExist()` calls `this.startStreamFast(subscription)` (L341), it passes the normalized subscription. `startStreamFast` calls `startStreamWithTimeout` which calls `startStream`, which calls `createStreamInstance` — now updated in Change 1g to merge options. ✅

---

## Change 2: Per-app streamType routing in DataStream

### File: `packages/cloud/src/services/session/transcription/TranscriptionManager.ts`

#### 2a. New helper: `findAppTranscriptionSubscription()`

Add after `buildSubscriptionWithOptions()`:

```typescript
/**
 * Find the app's own transcription subscription for a given base language.
 * Used to set DataStream.streamType to the app's exact subscription string,
 * so old SDKs (which do exact string matching) can match their handler key.
 */
private findAppTranscriptionSubscription(
  packageName: string,
  transcribeLanguage: string,
): ExtendedStreamType | null {
  const appSubs = this.userSession.subscriptionManager.getAppSubscriptions(packageName);
  for (const sub of appSubs) {
    if (!isLanguageStream(sub as string)) continue;
    const parsed = parseLanguageStream(sub as ExtendedStreamType);
    if (
      parsed &&
      parsed.type === StreamType.TRANSCRIPTION &&
      parsed.transcribeLanguage === transcribeLanguage
    ) {
      return sub;
    }
  }
  return null;
}
```

#### 2b. Update `relayDataToApps()` — per-app streamType

In `relayDataToApps()` (L1781-1901), update the per-app DataStream construction.

**Before (L1825-1841):**

```typescript
for (const packageName of subscribedApps) {
  const appSessionId = `${this.userSession.sessionId}-${packageName}`;

  const dataStream: DataStream = {
    type: CloudToAppMessageType.DATA_STREAM,
    sessionId: appSessionId,
    streamType: subscription as ExtendedStreamType, // Base type remains the same in the message
    data, // The data now may contain language info
    timestamp: new Date(),
  };

  try {
    const result = await this.userSession.appManager.sendMessageToApp(packageName, dataStream);
```

**After:**

```typescript
for (const packageName of subscribedApps) {
  const appSessionId = `${this.userSession.sessionId}-${packageName}`;

  // Use the app's own subscription string as streamType so old SDKs
  // can exact-match their handler key. Falls back to effectiveSubscription
  // if the app doesn't have a matching transcription subscription
  // (e.g., WILDCARD or ALL subscribers).
  const appSubscription = data.transcribeLanguage
    ? this.findAppTranscriptionSubscription(packageName, data.transcribeLanguage)
    : null;

  const dataStream: DataStream = {
    type: CloudToAppMessageType.DATA_STREAM,
    sessionId: appSessionId,
    streamType: (appSubscription || effectiveSubscription) as ExtendedStreamType,
    data,
    timestamp: new Date(),
  };

  try {
    const result = await this.userSession.appManager.sendMessageToApp(packageName, dataStream);
```

Also update the debug log at the end of the loop to include the per-app streamType:

**In the debug log block (~L1870-1895), add `appStreamType`:**

```diff
       this.logger.debug(
         {
           subscription,
           effectiveSubscription,
+          appStreamType: appSubscription || effectiveSubscription,
           provider: data.provider || "unknown",
           ...
         },
```

---

## Change 3: Language-aware handler matching in the SDK

### File: `packages/sdk/src/app/session/events.ts`

#### 3a. New import

Add `isLanguageStream` and `parseLanguageStream` to the existing import from `../../types` (L5-37):

```diff
 import {
   StreamType,
   ExtendedStreamType,
   ...
   createTranscriptionStream,
   isValidLanguageCode,
   createTranslationStream,
+  isLanguageStream,
+  parseLanguageStream,
   CustomMessage,
   ...
 } from "../../types";
```

#### 3b. New method: `findMatchingStream()`

Add after `getRegisteredStreams()` (L424-426):

```typescript
/**
 * 🔍 Find a registered stream that matches the incoming stream type.
 *
 * For non-language streams: exact match (existing behavior).
 * For language streams: compare base type + transcribeLanguage
 * (+ translateLanguage for translations), ignoring query params like ?hints=.
 *
 * This allows the SDK to receive data from a cloud stream whose subscription
 * string doesn't include the same query params as the handler's subscription.
 * For example, incoming "transcription:en-US" matches handler "transcription:en-US?hints=ja".
 */
findMatchingStream(incoming: ExtendedStreamType): ExtendedStreamType | null {
  // Fast path: exact match
  if (this.handlers.has(incoming)) {
    return incoming;
  }

  // For language streams, try base-language matching
  if (isLanguageStream(incoming as string)) {
    const incomingParsed = parseLanguageStream(incoming);
    if (!incomingParsed) return null;

    for (const key of this.handlers.keys()) {
      if (!isLanguageStream(key as string)) continue;

      const keyParsed = parseLanguageStream(key as ExtendedStreamType);
      if (!keyParsed) continue;

      // Compare base type
      if (keyParsed.type !== incomingParsed.type) continue;

      // Compare transcribe language
      if (keyParsed.transcribeLanguage !== incomingParsed.transcribeLanguage) continue;

      // For translations, also compare target language
      if (incomingParsed.translateLanguage || keyParsed.translateLanguage) {
        if (keyParsed.translateLanguage !== incomingParsed.translateLanguage) continue;
      }

      return key as ExtendedStreamType;
    }
  }

  return null;
}
```

---

## Change 4: Update `handleMessage()` to use `findMatchingStream()`

### File: `packages/sdk/src/app/session/index.ts`

#### 4a. Update DataStream handling

**Before (L1347-1370):**

```typescript
} else if (isDataStream(message)) {
  // Ensure streamType exists before emitting the event
  const messageStreamType = message.streamType as ExtendedStreamType;
  // if (message.streamType === StreamType.TRANSCRIPTION) {
  //   const transcriptionData = message.data as TranscriptionData;
  //   if (transcriptionData.transcribeLanguage) {
  //     messageStreamType = createTranscriptionStream(transcriptionData.transcribeLanguage) as ExtendedStreamType;
  //   }
  // } else if (message.streamType === StreamType.TRANSLATION) {
  //   const translationData = message.data as TranslationData;
  //   if (translationData.transcribeLanguage && translationData.translateLanguage) {
  //     messageStreamType = createTranslationStream(translationData.transcribeLanguage, translationData.translateLanguage) as ExtendedStreamType;
  //   }
  // }

  // Check if we have a handler registered for this stream type (derived from handlers)
  const hasHandler = this.events.getRegisteredStreams().includes(messageStreamType);
  if (messageStreamType && hasHandler) {
    const sanitizedData = this.sanitizeEventData(messageStreamType, message.data) as EventData<
      typeof messageStreamType
    >;
    this.events.emit(messageStreamType, sanitizedData);
  }
```

**After:**

```typescript
} else if (isDataStream(message)) {
  const messageStreamType = message.streamType as ExtendedStreamType;

  // Use language-aware matching: "transcription:en-US" matches handler
  // for "transcription:en-US?hints=ja" (same base language, different options).
  // This ensures apps receive data after stream dedup normalizes streamType
  // to base language form, AND maintains backward compat when cloud sends
  // the app's own subscription string (which includes options).
  const matchedStreamType = this.events.findMatchingStream(messageStreamType);

  if (matchedStreamType) {
    const sanitizedData = this.sanitizeEventData(matchedStreamType, message.data) as EventData<
      typeof matchedStreamType
    >;
    this.events.emit(matchedStreamType, sanitizedData);
  } else if (messageStreamType) {
    // Change 5: Log unmatched DataStream for debugging (previously a silent black hole)
    this.logger.debug(
      {
        streamType: messageStreamType,
        registeredStreams: this.events.getRegisteredStreams(),
      },
      `[AppSession] Received DataStream with no matching handler: ${messageStreamType}`,
    );
  }
```

This combines Changes 4 and 5 (unmatched DataStream logging) into one edit. The commented-out reconstruction code can be deleted since `findMatchingStream()` supersedes it entirely.

---

## Change 5: SDK-side logging for unmatched DataStream

Implemented as part of Change 4 above (the `else if` branch). No separate edit needed.

---

## Change 6: Remove dead code `getTargetSubscriptions()`

### File: `packages/cloud/src/services/session/transcription/TranscriptionManager.ts`

#### 6a. Delete `getTargetSubscriptions()` (L1773-1779)

```diff
-  /**
-   * Get the target subscriptions for routing data
-   * Now simplified since there's no optimization mapping
-   */
-  private getTargetSubscriptions(
-    streamSubscription: ExtendedStreamType,
-    effectiveSubscription: ExtendedStreamType,
-  ): ExtendedStreamType[] {
-    // Simply return the effective subscription
-    return [effectiveSubscription];
-  }
```

#### 6b. Inline in `relayDataToApps()`

**Before (~L1803-1812):**

```typescript
// Handle optimized subscription routing
const targetSubscriptions = this.getTargetSubscriptions(subscription, effectiveSubscription)
const allSubscribedApps = new Set<string>()

// Get subscribed apps for all target subscriptions
for (const targetSub of targetSubscriptions) {
  const subscribedApps = this.userSession.subscriptionManager.getSubscribedApps(targetSub)
  subscribedApps.forEach((app) => allSubscribedApps.add(app))
}

const subscribedApps = Array.from(allSubscribedApps)
```

**After:**

```typescript
// Get all apps subscribed to this base language
const subscribedApps = this.userSession.subscriptionManager.getSubscribedApps(effectiveSubscription)
```

---

## Testing

### Unit tests to add

#### Test file: `packages/cloud/src/services/session/transcription/__tests__/TranscriptionManager.dedup.test.ts` (new file)

```
describe("TranscriptionManager stream dedup", () => {

  describe("normalizeToBaseLanguage", () => {
    test cases:
    - "transcription:en-US" → "transcription:en-US"
    - "transcription:en-US?hints=ja" → "transcription:en-US"
    - "transcription:en-US?hints=ja,fr&no-language-identification=true" → "transcription:en-US"
    - "transcription:auto" → "transcription:auto"
    - "translation:en-US-to-es-ES?no-language-identification=true" → "translation:en-US-to-es-ES"
    - "audio_chunk" → "audio_chunk"
  })

  describe("getMergedOptionsForLanguage", () => {
    test cases:
    - single sub without options → { hints: [], disableLanguageIdentification: false }
    - ["transcription:en-US", "transcription:en-US?hints=ja"] → { hints: ["ja"], disable: false }
    - ["transcription:en-US?hints=ja", "transcription:en-US?hints=fr,de"] → { hints: ["ja","fr","de"], disable: false }
    - ["transcription:en-US?no-language-identification=true"] → { hints: [], disable: true }
    - ["transcription:en-US?no-language-identification=true", "transcription:en-US"] → { hints: [], disable: false }
  })

  describe("buildSubscriptionWithOptions", () => {
    test cases:
    - no options → "transcription:en-US"
    - hints only → "transcription:en-US?hints=ja%2Cfr"
    - disable only → "transcription:en-US?no-language-identification=true"
    - both → includes both params
  })

  describe("updateSubscriptions dedup", () => {
    test cases:
    - ["transcription:en-US", "transcription:en-US?hints=ja"] → 1 stream, activeSubscriptions size 1
    - ["transcription:en-US", "transcription:ja-JP"] → 2 streams
    - ["transcription:en-US?hints=ja"] then ["transcription:en-US?hints=fr"] → still 1 stream, no stop/start
    - ["transcription:en-US?hints=ja"] then ["transcription:ja-JP"] → stop en-US, start ja-JP
  })

  describe("findAppTranscriptionSubscription", () => {
    test cases:
    - app has "transcription:en-US?hints=ja", query for "en-US" → returns "transcription:en-US?hints=ja"
    - app has "transcription:en-US", query for "en-US" → returns "transcription:en-US"
    - app has "transcription:ja-JP", query for "en-US" → returns null
    - app has no transcription subs → returns null
  })

})
```

#### Test file: `packages/sdk/src/app/session/__tests__/events.findMatchingStream.test.ts` (new file)

```
describe("EventManager.findMatchingStream", () => {
  test cases:
  - exact match: incoming "transcription:en-US", handler "transcription:en-US" → match
  - base language match: incoming "transcription:en-US", handler "transcription:en-US?hints=ja" → match
  - different language: incoming "transcription:en-US", handler "transcription:ja-JP" → null
  - different type: incoming "transcription:en-US", handler "translation:en-US-to-es-ES" → null
  - translation match: incoming "translation:en-US-to-es-ES", handler "translation:en-US-to-es-ES?no-language-identification=true" → match
  - translation mismatch: incoming "translation:en-US-to-es-ES", handler "translation:en-US-to-fr-FR" → null
  - non-language exact: incoming "audio_chunk", handler "audio_chunk" → match
  - non-language miss: incoming "audio_chunk", handler "button_press" → null
  - empty handlers: incoming anything → null
  - handler for "transcription:en-US" and "transcription:en-US?hints=ja" both exist:
    exact match wins (returns "transcription:en-US" if that's the incoming)
)
```

### Manual integration tests

1. **Two apps, same language, different hints:**
   - Start recorder (`onTranscription(handler)` → `"transcription:en-US"`)
   - Start captions (`onTranscriptionForLanguage("en-US", handler, { hints: ["ja"] })` → `"transcription:en-US?hints=ja"`)
   - Verify logs: only ONE "🚀 STREAM CREATED" for `"transcription:en-US"`
   - Verify logs: Soniox config includes `language_hints: ["en", "ja"]`
   - Verify: both apps receive transcription data
   - Verify logs: recorder DataStream has `streamType: "transcription:en-US"`, captions has `streamType: "transcription:en-US?hints=ja"`

2. **Subscription change (hints change):**
   - Start captions with `hints=ja`
   - Change captions to `hints=fr`
   - Verify logs: no "Stopping stream", no "🚀 STREAM CREATED" — stream persists
   - Verify: `rawSubscriptions` updated, merged hints change (picked up on next VAD cycle)
   - Verify: captions continues receiving data without interruption

3. **Old SDK backward compatibility:**
   - Deploy cloud changes only (no SDK update)
   - Start an app on old SDK with `onTranscriptionForLanguage("en-US", handler, { hints: ["ja"] })`
   - Verify: app receives data (cloud sends `streamType: "transcription:en-US?hints=ja"` per-app)

4. **Boot storm:**
   - Restart pod
   - Verify: only 1 stream per base language created (not 2+)
   - Verify: all apps receive data after reconnection completes

---

## Rollout

### Phase 1: Cloud to debug

Deploy the cloud changes (Changes 1, 2, 6) to the **debug** environment.

**Verification checklist:**

- [ ] Logs show only one `"🚀 STREAM CREATED"` per base language (not two)
- [ ] Logs show `"Updating transcription subscriptions (normalized)"` with correct raw vs normalized
- [ ] Logs show `"Creating stream with merged options from all subscribers"` with merged hints
- [ ] Each app's DataStream relay log shows its own subscription string as `appStreamType`
- [ ] Old SDK apps (recorder, captions.debug, merge, notes) all receive transcription data
- [ ] No increase in "Stream closed by provider" or error logs
- [ ] Soniox API usage drops (fewer concurrent streams per user)

### Phase 2: SDK to debug

Deploy updated SDK (Changes 3, 4, 5) to debug apps.

**Verification checklist:**

- [ ] Apps still receive transcription data (findMatchingStream works)
- [ ] Debug log appears for genuinely unmatched DataStream messages (not for transcription data)
- [ ] No regressions in subscription/unsubscription lifecycle

### Phase 3: dev → staging → prod

Standard promotion. Verify at each stage:

- [ ] Stream count per user matches expected (1 per base language)
- [ ] No app reports silent transcription failure
- [ ] Soniox billing shows reduced concurrent stream usage

### Rollback

Either side can be rolled back independently:

- **Cloud rollback:** Revert `updateSubscriptions()` to raw-string identity. Duplicate streams return. Old SDK apps still work (they get their own stream again via the accidental exact-match routing).
- **SDK rollback:** Revert `findMatchingStream()` to exact match. Apps still work because new cloud sends per-app `streamType`. If cloud is also rolled back, behavior is identical to pre-fix.

No data migration, no state to clean up, no database changes.

---

## File change checklist

| File                                                                                             | Lines changed (approx) | Type     |
| ------------------------------------------------------------------------------------------------ | ---------------------- | -------- |
| `packages/cloud/src/services/session/transcription/TranscriptionManager.ts`                      | ~120                   | Modified |
| `packages/sdk/src/app/session/events.ts`                                                         | ~45                    | Modified |
| `packages/sdk/src/app/session/index.ts`                                                          | ~20                    | Modified |
| `packages/cloud/src/services/session/transcription/__tests__/TranscriptionManager.dedup.test.ts` | ~100                   | New      |
| `packages/sdk/src/app/session/__tests__/events.findMatchingStream.test.ts`                       | ~80                    | New      |

**Total: ~365 lines across 5 files (3 modified, 2 new test files).**
