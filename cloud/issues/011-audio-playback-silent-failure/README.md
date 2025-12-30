# Audio Playback Silent Failure

Applet audio playback fails silently after first successful query.

## Documents

- **audio-playback-silent-failure-spec.md** - Problem analysis, investigation findings
- **001-observability.md** - Sub-issue: Add logging to livekit-bridge (DONE)

## Quick Context

**Symptom**: First Q+A works with audio, subsequent queries show text response but no audio playback.

**Reproduction**: MentraAI on Mentra Live - first query plays audio, subsequent queries fail silently. MentraOS Client console shows AI is responding via display events, but audio never plays.

## Key Findings

From BetterStack log investigation (2025-12-18):

1. **Go bridge has no PlayAudio logging** - Can't see what happens during playback
2. **PlayAudio returns FAILED with empty error** - `error: ""` with `durationMs: 122`
3. **TTS endpoint returns 200 OK** - Audio file is fetched successfully
4. **Failure happens AFTER fetch** - Likely in track publishing or audio streaming

## Status

- [x] Investigate with BetterStack logs
- [x] **001-observability**: Add comprehensive logging to Go livekit-bridge
- [ ] Deploy logging changes and reproduce issue
- [ ] Analyze new logs to find root cause
- [ ] Fix the actual bug
- [ ] Verify fix with MentraAI Q+A flow

## Hypothesis

The "first works, subsequent fail" pattern suggests:

- Track state not being reset properly between plays
- WebRTC track getting into bad state after first playback
- Session/room connection issue after first audio completes

Need logs to confirm.
