# Giga Lag - Transcription Latency Issues

Umbrella issue for transcription latency bugs in Soniox transcription streams.

## Documents

- **giga-lag-spec.md** - Original problem analysis (lag metric fix)
- **improved-metrics-spec.md** - NEW: Specification for better latency metrics
- **livekit-bridge-panic/** - Sub-issue: Bridge crash on closed channel
- **session-grace-period-bug/** - Sub-issue: RESOLVED - was server switch behavior
- **zombie-stream-bug/** - Sub-issue: CLOSED - was user silence, not dead streams

## Current Status (Updated Dec 9, 2025)

### Key Finding: NOT Zombie Streams - User Silence Periods

Initial investigation suspected "zombie streams" where Soniox stopped responding. **This was incorrect.**

BetterStack analysis revealed:
- Streams with `transcriptEndMs` appearing "frozen" for 60+ minutes
- `processingDeficitMs` growing unboundedly (up to 3.6 million ms = 60 minutes)
- Appeared like dead streams

**But deeper analysis showed:**
- NO intermediate `transcriptEndMs` values between 3,997,920 ms and 7,701,360 ms
- If Soniox was processing a backlog, we'd see gradual progression
- Instead, the value JUMPED directly - indicating **user started speaking again after silence**
- Soniox correctly identified speech at the new position in the audio stream

### The Real Issue: Misleading Deficit Metric During Silence

The `processingDeficitMs` calculation is:
```
processingDeficitMs = audioSentDurationMs - transcriptEndMs
```

**Problem:** During silence periods:
- `audioSentDurationMs` keeps growing (we keep sending audio to Soniox)
- `transcriptEndMs` stays frozen (Soniox only updates this when it detects speech)
- Deficit appears HUGE even though Soniox is working correctly!

**This is NOT a bug in Soniox** - it's working as designed. The issue is that our metric is misleading.

### Evidence Timeline (User A)

| Time | transcriptEndMs | processingDeficitMs | Reality |
|------|-----------------|---------------------|---------|
| 22:12-22:26 | 3,997,920 (frozen) | 2.7M → 3.6M ms | User was SILENT |
| 22:27 | 7,701,360 | ~3.6M ms | User started speaking again |
| 22:28 | 7,714,320 | 480 ms | Healthy real-time transcription |

**Key evidence:** No intermediate values between 3,997,920 and 7,701,360 - Soniox didn't "catch up", it just detected new speech at a later position.

## Open Questions

### Why Is Audio Being Sent During Silence?

If VAD (Voice Activity Detection) is working, audio should NOT be sent to Soniox during silence. Possible issues:

1. **VAD not filtering at server** - All audio from glasses sent to Soniox regardless of VAD state
2. **VAD threshold too sensitive** - Background noise being detected as speech
3. **Streams don't close on silence** - Once created, streams stay open indefinitely
4. **Client-side VAD only** - Server doesn't respect VAD state from client

### Should We Change the Metric?

**YES - See `improved-metrics-spec.md` for full specification.**

Key changes proposed:
1. **Add `isReceivingTokens`** - Boolean: have we received tokens in last 30s?
2. **Add `realtimeLatencyMs`** - TRUE latency when tokens ARE being received
3. **Add `timeSinceLastTokenMs`** - How long since any transcription activity
4. **Add `audioSentSinceLastTokenMs`** - Audio sent during quiet period
5. **Keep `processingDeficitMs`** - For backwards compatibility only, de-emphasize in logging

This allows us to distinguish:
- "Soniox is behind" (high `realtimeLatencyMs` while `isReceivingTokens === true`)
- "User is silent" (low `isReceivingTokens`, high `audioSentSinceLastTokenMs`)

## Sub-Issues

### 1. LiveKit Bridge Panic (Critical)

The livekit-bridge Go service can crash with `panic: send on closed channel` when a session is cleaned up while audio is still flowing. This crashes the entire bridge, affecting all users.

See **livekit-bridge-panic/** folder for details.

**Status**: Root cause identified, fix proposed but not implemented

### 2. Session Grace Period Bug (Resolved)

~~When glasses disconnect and reconnect quickly, a NEW session is created instead of resuming the existing one.~~

**RESOLVED**: Investigation revealed this was due to server/environment switching (cloud-debug → cloud-dev), not a bug. Each server maintains its own sessions, so switching servers creates new sessions as expected.

See **session-grace-period-bug/** folder for details.

### 3. Lag Metric False Positives (Fixed)

Original issue: Lag detection used wall-clock time vs transcript position, causing false alarms during VAD gaps.

**Status**: ✅ Fixed - Now using `processingDeficitMs` as primary metric

See **giga-lag-spec.md** for details.

### 4. Zombie Stream Bug (Closed)

**CLOSED**: Investigation revealed the "frozen" streams were actually users being silent. Soniox was working correctly - it only reports transcription positions when speech is detected.

See **zombie-stream-bug/** folder for details.

## Recommendations

### Short Term
1. **Investigate VAD behavior** - Why is audio being sent during 60+ minute silence periods?
2. **Improve logging** - Add "time since last token received" to help distinguish silence vs issues
3. **Fix LiveKit bridge panic** - This is still a critical bug

### Medium Term
1. **Stream lifecycle review** - Should streams close after extended silence?
2. **Metric improvement** - Consider alternative metrics that aren't misleading during silence
3. **Dashboard** - Add visualization of transcript activity vs audio sent

### Long Term
1. **Cost optimization** - Sending silent audio to Soniox wastes API credits
2. **Resource management** - Keeping streams open during silence uses server resources

## Status

- [x] Root cause identified (lag metric)
- [x] Logs analyzed with correct metric
- [x] Fix lag detection to use `processingDeficitMs`
- [x] "Zombie stream" investigation (CLOSED - was user silence)
- [x] **Metric improvement spec written** (`improved-metrics-spec.md`)
- [x] **Implement improved metrics** (types.ts, SonioxTranscriptionProvider.ts, TranscriptionManager.ts)
- [ ] Fix LiveKit bridge panic
- [ ] Investigate why audio sent during silence

## Key Files

- `packages/cloud/src/services/session/transcription/TranscriptionManager.ts`
- `packages/cloud/src/services/session/transcription/providers/SonioxTranscriptionProvider.ts`
- `packages/cloud-livekit-bridge/service.go`
