# Subscription Bug - Transcription Not Starting

Transcription subscriptions from apps not registering, causing microphone to never enable.

## Documents

- **subscription-bug-spec.md** - Problem analysis, root cause
- **subscription-bug-fix.md** - Proposed fix

## Quick Context

**Current**: Apps subscribe to `transcription:en-US` but `hasTranscription` stays false, microphone never turns on
**Issue**: `transcriptionLikeSubscriptionCount` not incrementing when apps connect

## Key Context

After fixing gRPC bridge (works perfectly), discovered transcription still doesn't work because the microphone never enables. Root cause: SubscriptionManager not properly counting transcription subscriptions from apps like `com.augmentos.livecaptions`, so MicrophoneManager thinks no audio is needed.

Translation works because it uses a different flow or gets enabled differently. The subscription parsing logic looks correct, but something in the registration/counting is broken.

## Symptoms

- Audio chunks flow correctly when mic is on ✅
- Translation works ✅
- gRPC bridge works perfectly ✅
- Apps send `subscription_update` with `["transcription:en-US"]` ✅
- But `hasTranscription` stays false ❌
- Microphone never enables for transcription ❌
- Soniox stream closes immediately (because no audio) ❌

## Evidence

From Porter logs (`isaiah@mentra.glass`):

```
[2025-10-15 20:55:06.018] DEBUG: Received subscription update from App: com.augmentos.livecaptions
  subscriptions: ["transcription:en-US"]

[2025-10-15 20:55:06.117] DEBUG: Updated cached subscription state
  hasPCM: false
  hasTranscription: false  ← Should be true!
  hasMedia: false

[2025-10-15 20:55:06.117] DEBUG: Bridge health
  micEnabled: false  ← Never turns on
```

## Key Files

- `packages/cloud/src/services/session/SubscriptionManager.ts` - Counts subscriptions
- `packages/cloud/src/services/session/MicrophoneManager.ts` - Uses counts to enable mic
- `packages/sdk/src/types/streams.ts` - Parses `transcription:en-US` format

## Status

- [x] Identified symptoms (mic never enables)
- [x] Confirmed gRPC bridge working
- [x] Traced to subscription counting
- [ ] Find why `transcriptionLikeSubscriptionCount` not incrementing
- [ ] Fix subscription registration
- [ ] Test with live captions app
- [ ] Verify transcription works end-to-end

## Related

- Fixed in same branch as `cloud/livekit-grpc`
- gRPC bridge works perfectly (separate issue, now resolved)
- Not an audio pipeline issue
- Not a Soniox API issue (it closes because no audio is flowing)
