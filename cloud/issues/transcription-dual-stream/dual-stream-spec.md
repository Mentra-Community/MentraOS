# Dual-Stream Transcription Bug Spec

## Overview

Multiple Soniox WebSocket connections are created for the same base language when apps subscribe with different query parameters (e.g., `transcription:en-US` vs `transcription:en-US?hints=es,fr`). This wastes resources and could cause duplicate transcripts.

## Problem

### Evidence

1. **Stream key includes query params**

   `TranscriptionManager.ts` uses the full subscription string as the Map key:

   ```typescript
   // Line 682-686
   this.streams.set(subscription, stream);  // subscription includes ?hints=...
   ```

2. **Subscription matching ignores query params (good)**

   `SubscriptionManager.getSubscribedApps()` correctly normalizes when routing:

   ```typescript
   // Line 100-109
   if (incomingParsed && isLanguageStream(sub as string)) {
     const subParsed = parseLanguageStream(sub as string);
     if (subParsed.transcribeLanguage === incomingParsed.transcribeLanguage) {
       subscribedApps.push(packageName);  // Matches by base language only
     }
   }
   ```

3. **No deduplication at stream creation**

   `TranscriptionManager.updateSubscriptions()` treats each subscription as unique:

   ```typescript
   // Line 162-165
   for (const subscription of desired) {
     if (!current.has(subscription)) {  // Uses full string with query params
       await this.startStream(subscription);
     }
   }
   ```

### Impact

| Issue | Severity |
|-------|----------|
| Extra Soniox WebSocket connections | Medium - cost/resource waste |
| Same audio fed to multiple streams | Medium - redundant processing |
| Potential duplicate transcripts | Low - routing dedupes by app |

### Reproduction

1. App A subscribes to `transcription:en-US`
2. App B (or same app after settings change) subscribes to `transcription:en-US?hints=es,fr`
3. Two Soniox streams created, both receiving the same audio
4. Both streams emit transcriptions
5. Routing correctly delivers to subscribed apps (no duplicates at app level)

## Constraints

- Query params (`hints`, `no-language-identification`) must still be passed to Soniox configuration
- Can't break existing subscription matching for apps
- Must handle case where different apps want different hints for same language

## Goals

1. **One stream per base language** - `transcription:en-US` should use same stream regardless of query params
2. **Merge hints** - If App A wants `hints=es` and App B wants `hints=fr`, stream uses `hints=es,fr`
3. **Backward compatible** - Apps don't need to change their subscription calls

## Non-Goals

- Changing how apps subscribe (SDK API stays the same)
- Changing subscription routing logic (already works correctly)
- Supporting per-app language detection settings (use global config)

## Proposed Solution

### Option A: Normalize stream key (Recommended)

Normalize the subscription to base language when using as stream key:

```typescript
// In TranscriptionManager
private getStreamKey(subscription: ExtendedStreamType): string {
  const parsed = parseLanguageStream(subscription);
  if (parsed?.type === StreamType.TRANSCRIPTION) {
    return `${parsed.type}:${parsed.transcribeLanguage}`;  // Strip query params
  }
  return subscription;
}

// Use normalized key for streams Map
const streamKey = this.getStreamKey(subscription);
if (!this.streams.has(streamKey)) {
  await this.startStream(subscription);  // Pass full subscription for config
}
this.streams.set(streamKey, stream);
```

**Pros**: Simple, minimal changes
**Cons**: Last subscription's hints win (might not be desired)

### Option B: Merge hints across subscriptions

Track all subscriptions per base language and merge hints:

```typescript
// Track: Map<baseLanguage, Set<fullSubscription>>
private subscriptionsByLanguage = new Map<string, Set<string>>();

// When creating stream, merge all hints
private getMergedHints(baseLanguage: string): string[] {
  const allHints = new Set<string>();
  for (const sub of this.subscriptionsByLanguage.get(baseLanguage) || []) {
    const parsed = parseLanguageStream(sub);
    if (parsed?.options?.hints) {
      parsed.options.hints.split(',').forEach(h => allHints.add(h));
    }
  }
  return Array.from(allHints);
}
```

**Pros**: All apps get their preferred hints
**Cons**: More complex, need to reconfigure stream when hints change

### Option C: Single stream, ignore per-app hints

Use global language hints from user settings, ignore per-subscription hints:

```typescript
// Always use settings-based hints, not subscription hints
const globalHints = await this.userSession.settings.getLanguageHints();
```

**Pros**: Simplest, predictable behavior
**Cons**: Apps can't customize hints

## Recommendation

**Option A** for initial fix - normalize stream keys. The Captions app is currently the only transcription consumer, so hint merging isn't needed. Can upgrade to Option B if multiple apps need different hints in the future.

## Open Questions

1. **Should we reconfigure existing stream if new subscription has different hints?**
   - Current thinking: No, first subscription's hints win until stream is recreated
   - Alternative: Reconfigure Soniox on new subscription (requires WebSocket message)

2. **What about `no-language-identification` flag?**
   - If any subscription disables it, should the stream disable it?
   - Current thinking: Yes, conservative approach

3. **Impact on stream lifecycle?**
   - Stream stays alive as long as any app is subscribed to that base language
   - Need to track reference count by base language, not by full subscription