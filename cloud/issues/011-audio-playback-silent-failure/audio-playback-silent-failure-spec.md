# Audio Playback Silent Failure Spec

## Overview

Applet audio playback silently fails after the first successful query. Users see text responses but hear no audio on subsequent interactions.

## Problem

**Reported behavior**: MentraAI on Mentra Live - first Q+A plays audio correctly, but subsequent queries never produce audible responses. The MentraOS Client console confirms AI is responding via display events, so the AI pipeline is working. Only audio playback is broken.

### Evidence from BetterStack Logs (2025-12-18)

Investigation of user `isaiahballah@gmail.com` around 02:10 UTC:

1. **PlayAudio requests are being made** - TypeScript side logs show requests going to Go bridge
2. **FAILED events returned with empty errors**:
   ```json
   {"type":"FAILED","requestId":"audio_req_...","durationMs":"0","positionMs":"0","error":""}
   {"type":"FAILED","requestId":"audio_req_...","durationMs":"122","positionMs":"0","error":""}
   ```
3. **TTS endpoint returns 200 OK** - HTTP request to `/api/tts?text=...` succeeds
4. **No Go bridge logs for PlayAudio** - All playback code used `log.Printf` (stdout), not BetterStack

### The Observability Gap

Before this investigation, the Go livekit-bridge had **zero visibility** in BetterStack for:

- PlayAudio requests received
- Audio file fetching
- MP3/WAV decoding
- Track creation/publishing
- Playback progress
- Playback completion/failure

This made it impossible to diagnose where the failure occurs.

## Constraints

- LiveKit WebRTC for audio transport
- Go bridge handles server-side audio playback
- TypeScript cloud orchestrates requests
- Audio flows: TTS URL → Go bridge fetches → Decode MP3/WAV → Publish to LiveKit track → Client receives

## Goals

1. **Diagnose root cause** of "first works, subsequent fail" pattern
2. **Fix the bug** so all PlayAudio requests work reliably
3. **Prevent regression** with proper logging/monitoring

## Non-Goals

- Changing the overall audio architecture (that's issue 010)
- Optimizing audio latency (separate concern)
- Supporting new audio formats

## Investigation Plan

### Phase 1: Observability (DONE)

Add comprehensive logging to Go livekit-bridge:

- [x] PlayAudio request received (URL, trackId, userId)
- [x] Audio file fetch (duration, status, content-type)
- [x] Decode progress (samples, bytes, errors)
- [x] Track creation/publishing
- [x] Playback completion/failure with details

### Phase 2: Reproduce and Capture

1. Deploy logging changes to debug environment
2. Reproduce the issue with MentraAI Q+A
3. Capture full log trace from first (working) to second (failing) query

### Phase 3: Root Cause Analysis

Hypotheses to investigate:

1. **Track state corruption** - Track not properly reset between plays
2. **Publication leak** - Old track publication blocking new one
3. **Room disconnection** - LiveKit room silently disconnects after first play
4. **Context cancellation** - Playback context cancelled prematurely
5. **Resource exhaustion** - Goroutine/channel leak after first play

### Phase 4: Fix and Verify

- Implement fix based on root cause
- Test with multiple consecutive Q+A queries
- Verify no audio regressions in other flows

## Open Questions

1. **Is this track-specific?** Does it only affect `tts` track (trackId=2) or all tracks?
2. **Is this user-specific?** Does it happen for all users or specific session states?
3. **Is this timing-related?** Does rapid-fire queries fail more than spaced ones?
4. **Does StopAudio help?** If we explicitly stop before playing, does it work?

## Related Issues

- **010-audio-manager-consolidation** - Broader audio architecture improvements
- **009-bun-time** - Cloud refactoring that may touch audio paths

## References

- Go bridge code: `cloud/packages/cloud-livekit-bridge/`
- TypeScript audio: `cloud/packages/cloud/src/services/session/livekit/`
- BetterStack source: AugmentOS (ID: 1311181)
