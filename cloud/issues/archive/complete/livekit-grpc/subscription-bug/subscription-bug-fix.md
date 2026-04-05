# Subscription Bug Fix

## Root Cause

SubscriptionManager maintains a global counter for transcription subscriptions across all apps, but when an app disconnects/reconnects, the counter gets decremented even if OTHER apps still have the same subscription active.

## The Bug

**Current broken logic:**

```typescript
private transcriptionLikeSubscriptionCount = 0; // Global counter
private subscriptions = new Map<packageName, Set<ExtendedStreamType>>();

// When app updates subscriptions:
applyDelta(packageName, oldSet, newSet) {
  for (const sub of oldSet) {
    if (!newSet.has(sub)) {
      this.applySingle(sub, false);  // Decrements global count
    }
  }
}
```

**What happens:**

1. `com.augmentos.livecaptions` subscribes to `transcription:en-US` → count = 1 ✅
2. `com.mentra.merge` subscribes to `transcription:en-US` → count = 2 ✅
3. User stops `com.mentra.merge` → it removes `transcription:en-US` → count = 1 ✅
4. `com.augmentos.livecaptions` reconnects (empty subs during reconnect) → removes `transcription:en-US` → **count = 0** ❌
5. Microphone turns off because count is 0 ❌
6. `com.augmentos.livecaptions` finishes reconnecting → adds `transcription:en-US` → count = 1 ✅
7. But during step 4-6, transcription was off!

**Evidence from logs:**

```
22:31:10 - com.augmentos.livecaptions adds ["transcription:en-US"] → count: 0→1
22:31:25 - com.mentra.merge removes ["transcription:en-US"] → count: 2→1 (why was it 2? other user?)
22:31:35 - com.augmentos.livecaptions removes ["transcription:en-US"] → count: 1→0 (GOES TO ZERO!)
22:31:38 - com.augmentos.livecaptions adds ["transcription:en-US"] → count: 0→1
```

## The Fix

**Option 1: Count unique apps, not increments** (Recommended)

Replace simple counter with a map tracking which apps need transcription:

```typescript
// Instead of:
private transcriptionLikeSubscriptionCount = 0;

// Use:
private appsWithTranscription = new Set<string>(); // packageNames
private appsWithPCM = new Set<string>();

hasPCMTranscriptionSubscriptions(): {
  hasMedia: boolean;
  hasPCM: boolean;
  hasTranscription: boolean;
} {
  const hasPCM = this.appsWithPCM.size > 0;
  const hasTranscription = this.appsWithTranscription.size > 0;
  const hasMedia = hasPCM || hasTranscription;
  return { hasMedia, hasPCM, hasTranscription };
}

private applyDelta(
  packageName: string,
  oldSet: Set<ExtendedStreamType>,
  newSet: Set<ExtendedStreamType>,
): void {
  // Determine if this app needs transcription/PCM
  const oldHasTranscription = this.hasTranscriptionLike(oldSet);
  const newHasTranscription = this.hasTranscriptionLike(newSet);
  const oldHasPCM = oldSet.has(StreamType.AUDIO_CHUNK);
  const newHasPCM = newSet.has(StreamType.AUDIO_CHUNK);

  // Update sets
  if (oldHasTranscription && !newHasTranscription) {
    this.appsWithTranscription.delete(packageName);
  } else if (!oldHasTranscription && newHasTranscription) {
    this.appsWithTranscription.add(packageName);
  }

  if (oldHasPCM && !newHasPCM) {
    this.appsWithPCM.delete(packageName);
  } else if (!oldHasPCM && newHasPCM) {
    this.appsWithPCM.add(packageName);
  }

  // Still update language stream counts for other purposes
  for (const sub of oldSet) {
    if (!newSet.has(sub)) {
      this.updateLanguageStreamCount(sub, false);
    }
  }
  for (const sub of newSet) {
    if (!oldSet.has(sub)) {
      this.updateLanguageStreamCount(sub, true);
    }
  }
}

private hasTranscriptionLike(subs: Set<ExtendedStreamType>): boolean {
  for (const sub of subs) {
    if (sub === StreamType.TRANSCRIPTION || sub === StreamType.TRANSLATION) {
      return true;
    }
    if (isLanguageStream(sub)) {
      const info = parseLanguageStream(sub as string);
      if (info && (info.type === StreamType.TRANSCRIPTION ||
                   info.type === StreamType.TRANSLATION)) {
        return true;
      }
    }
  }
  return false;
}
```

**Option 2: Recount from scratch** (Simpler but less efficient)

Instead of maintaining counters, recalculate on demand:

```typescript
hasPCMTranscriptionSubscriptions(): {
  hasMedia: boolean;
  hasPCM: boolean;
  hasTranscription: boolean;
} {
  let hasPCM = false;
  let hasTranscription = false;

  // Check all active app subscriptions
  for (const [packageName, subs] of this.subscriptions.entries()) {
    for (const sub of subs) {
      if (sub === StreamType.AUDIO_CHUNK) {
        hasPCM = true;
      }
      if (sub === StreamType.TRANSCRIPTION || sub === StreamType.TRANSLATION) {
        hasTranscription = true;
      }
      if (isLanguageStream(sub)) {
        const info = parseLanguageStream(sub as string);
        if (info && (info.type === StreamType.TRANSCRIPTION ||
                     info.type === StreamType.TRANSLATION)) {
          hasTranscription = true;
        }
      }
    }
  }

  const hasMedia = hasPCM || hasTranscription;
  return { hasMedia, hasPCM, hasTranscription };
}
```

## Recommendation

**Use Option 1** (Set-based tracking):

- More efficient (O(1) lookups vs O(n) scanning)
- Explicit tracking of which apps need what
- Easier to debug (can see which apps have transcription active)
- Matches the per-app subscription model

## Implementation Steps

1. Replace `transcriptionLikeSubscriptionCount` with `appsWithTranscription: Set<string>`
2. Replace `pcmSubscriptionCount` with `appsWithPCM: Set<string>`
3. Update `applyDelta()` to add/remove packageNames from sets instead of incrementing counters
4. Update `hasPCMTranscriptionSubscriptions()` to check set sizes
5. Remove `applySingle()` method (no longer needed for this counting)
6. Keep `languageStreamCounts` map for other purposes (unchanged)
7. Add cleanup when app disconnects via `removeSubscriptions()`

## Testing

1. Start one transcription app → mic should turn on
2. Start second transcription app → mic stays on
3. Stop first app → mic stays on (second app still needs it)
4. Stop second app → mic turns off
5. App reconnect (empty subs during handshake) → mic should NOT flicker off/on

## Additional Improvements

1. Add `getActiveSubscribers(subscription: string): string[]` method to see which apps have a subscription
2. Log when mic state changes due to subscription changes
3. Add metric for subscription churn rate (how often count changes)
