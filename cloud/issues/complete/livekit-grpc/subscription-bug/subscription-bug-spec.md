# Subscription Bug Specification

## Overview

Apps subscribing to transcription streams (e.g., `transcription:en-US`) don't trigger microphone activation because SubscriptionManager fails to increment `transcriptionLikeSubscriptionCount`, leaving `hasTranscription` permanently false.

## Problem

### Issue

When apps like `com.augmentos.livecaptions` send subscription updates requesting transcription streams, the cloud receives and logs the subscription but fails to properly register it in the SubscriptionManager. This causes:

1. `transcriptionLikeSubscriptionCount` stays at 0
2. `hasTranscription` returns false
3. MicrophoneManager calculates no audio is needed
4. Microphone never enables
5. No audio flows to transcription providers
6. Soniox/Azure close connections immediately (no data)

### Evidence from Production (Porter cloud-debug)

**User**: `isaiah@mentra.glass`  
**App**: `com.augmentos.livecaptions`  
**Date**: 2025-10-15

```
# App sends subscription
[20:55:06.018] DEBUG: Received subscription update from App: com.augmentos.livecaptions
  subscriptions: ["transcription:en-US"]

# SubscriptionManager processes it but count stays 0
[20:55:06.117] DEBUG: Updated cached subscription state
  hasPCM: false
  hasTranscription: false  ← WRONG! Should be true
  hasMedia: false

# Microphone never enables
[20:55:06.117] DEBUG: Bridge health
  micEnabled: false

# Result: Transcription never starts
```

### What Works

- **Translation**: Works perfectly for same user
- **Audio pipeline**: gRPC bridge delivers audio chunks correctly when mic is on
- **Subscription parsing**: `parseLanguageStream("transcription:en-US")` returns correct object
- **Other users**: Some users have working transcription (different app or timing?)

### What Doesn't Work

- Transcription subscriptions don't increment counter
- Microphone never enables for transcription-only apps
- Soniox connects then immediately disconnects (code 1000, no audio to process)

## Root Cause Analysis

### Subscription Flow

```
App sends subscription_update
  ↓
AppWebSocketService.handleMessage()
  ↓
SubscriptionManager.updateSubscriptions()
  ↓
SubscriptionManager.applySingle()
  ↓
Should increment transcriptionLikeSubscriptionCount
  ↓
MicrophoneManager.updateCachedSubscriptionState()
  ↓
Should enable microphone
```

**Breaking at**: `applySingle()` not incrementing counter OR `updateSubscriptions()` not calling `applySingle()`

### Code Paths

**SubscriptionManager.applySingle()** (lines 470-505):

```typescript
if (isLanguageStream(sub)) {
  const langInfo = parseLanguageStream(sub as string);
  if (
    langInfo &&
    (langInfo.type === StreamType.TRANSCRIPTION ||
      langInfo.type === StreamType.TRANSLATION)
  ) {
    this.transcriptionLikeSubscriptionCount += isAdd ? 1 : -1;
  }
}
```

**Logic appears correct**, but counter not incrementing. Possible causes:

1. `applySingle()` not being called for `transcription:en-US`
2. `isLanguageStream()` returning false
3. `parseLanguageStream()` returning null or wrong type
4. Subscription array being empty/malformed before reaching this code
5. Race condition in app connection lifecycle
6. Subscription being added then immediately removed

### Constraints

- Can't break existing working cases (translation, other users with transcription)
- Must maintain backward compatibility with app subscription format
- Must not change SDK types (apps already deployed)
- Fix must work for both new connections and reconnections

## Goals

### Primary

1. **Fix subscription counting**: `transcription:en-US` subscriptions must increment `transcriptionLikeSubscriptionCount`
2. **Enable microphone**: When transcription subscribed, `hasTranscription` must be true
3. **Start transcription**: Soniox/Azure must receive audio and produce transcripts
4. **No regressions**: Translation and other working features continue working

### Success Metrics

| Metric                               | Current | Target |
| ------------------------------------ | ------- | ------ |
| Transcription subscriptions counted  | 0%      | 100%   |
| Microphone enables for transcription | No      | Yes    |
| Soniox receives audio                | No      | Yes    |
| Transcripts delivered to apps        | 0%      | 100%   |

### Secondary

- Add debug logging to track subscription registration
- Add validation/warnings for malformed subscriptions
- Improve subscription lifecycle visibility

## Investigation Steps

1. **Add debug logging** in `applySingle()` to see if it's called
2. **Check `updateSubscriptions()`** to see if it's processing the array correctly
3. **Verify `isLanguageStream()`** returns true for `transcription:en-US`
4. **Check subscription array** before parsing (is it actually `["transcription:en-US"]`?)
5. **Test app connection lifecycle** (fresh connect vs reconnect)
6. **Compare working vs broken users** (what's different?)

## Hypotheses

### Hypothesis 1: Subscription Format Mismatch

**Theory**: App sends subscription in wrong format (object instead of string?)  
**Test**: Log raw subscription array before parsing  
**Likelihood**: Medium - would explain why parser doesn't match

### Hypothesis 2: App Connection Race

**Theory**: Subscription arrives before app fully connected, gets dropped  
**Test**: Add subscription queueing during connection  
**Likelihood**: High - timing-sensitive bugs common

### Hypothesis 3: Subscription Removed Immediately

**Theory**: Code adds subscription then removes it (cleanup logic bug)  
**Test**: Log all add/remove operations with stack traces  
**Likelihood**: Medium - could be cleanup race

### Hypothesis 4: Multiple Managers

**Theory**: Wrong SubscriptionManager instance being updated  
**Test**: Check if multiple instances exist per session  
**Likelihood**: Low - should be singleton per session

## Non-Goals

- Not changing subscription format (backward compatibility)
- Not modifying SDK types
- Not fixing Soniox API issues (separate concern)
- Not redesigning subscription architecture (tactical fix only)

## Open Questions

1. **Why does translation work but transcription doesn't?**
   - Do they use different code paths?
   - Is translation subscription format different?

2. **Why do some users have working transcription?**
   - Different app version?
   - Different connection timing?
   - Different device/platform?

3. **When did this break?**
   - Was it always broken?
   - Recent regression?
   - Related to gRPC migration? (Unlikely - separate systems)

4. **Is this user-specific or app-specific?**
   - Test with different users + same app
   - Test with same user + different transcription app
