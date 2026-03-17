# Known Issue: Mentra Live Glasses VAD → Missing FINAL Transcriptions

## Status

**Parked** — client team aware, may forward glasses VAD events in a future firmware update.

## Summary

On Mentra Live (non-display glasses), transcription finals are often missing because the device's hardware VAD stops sending audio before Soniox can emit an `endToken`. Users see their last words stuck as an interim that never commits.

## How it works today

There are two different VAD paths depending on the device:

### Mobile client (phone-based VAD) ✅ Works

```
User stops talking
  → Phone VAD detects silence
  → Phone sends explicit VAD event to cloud
  → Cloud calls TranscriptionManager.finalizePendingTokens()
  → SonioxTranscriptionStream.forceFinalizePendingTokens() fires
  → FINAL emitted with lastSentInterim text
```

### Mentra Live glasses (hardware VAD) ❌ Broken

```
User stops talking
  → Glasses hardware VAD detects silence
  → Glasses stop sending audio packets over BLE
  → Phone has no audio to forward to cloud
  → Cloud audio feed silently dries up
  → No VAD event sent to cloud
  → Soniox has pending tokens, waiting for more audio
  → No endToken arrives → no FINAL emitted
  → User's last words stuck as unfinalised interim
```

## Why it happens

The cloud's `forceFinalizePendingTokens()` mechanism depends on receiving an explicit VAD event from the mobile client. Mentra Live's hardware VAD operates at the BLE/audio layer — it simply stops transmitting packets. The cloud never receives a signal that speech ended; it only observes an absence of audio.

The cloud does have idle stream detection (`cleanupIdleStreams()`), but:

1. Its timeout is likely tuned for longer periods (stream cleanup, not speech boundary detection)
2. By the time it fires, the stream may be torn down entirely rather than gracefully finalized
3. The timing gap between device VAD and cloud idle detection creates a noticeable delay

## Relevant code

| File                                                              | What it does                                                                                 |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `SonioxTranscriptionProvider.ts` → `forceFinalizePendingTokens()` | Force-emits a FINAL from `lastSentInterim`. Works correctly when called.                     |
| `TranscriptionManager.ts` → `finalizePendingTokens()`             | Iterates active streams and calls `forceFinalizePendingTokens()`. Called on VAD stop events. |
| `TranscriptionManager.ts` → `cleanupIdleStreams()`                | Closes streams after idle timeout. May or may not finalize before closing.                   |

## Possible solutions (for later)

### Option A: Client forwards glasses VAD events (preferred)

The glasses client team said they may be able to detect and forward VAD events from the glasses hardware. This would make Mentra Live behave like the mobile VAD path — explicit event → cloud finalizes. **Cleanest fix, no cloud changes needed.**

### Option B: Cloud-side audio silence detector

If the audio feed goes quiet for N ms while `lastSentInterim` is non-empty, force-finalize proactively. This would be a cloud-side heuristic independent of the mobile VAD event path.

```
// Pseudocode — NOT implemented
if (timeSinceLastAudioChunk > SILENCE_THRESHOLD_MS && stream.lastSentInterim) {
  stream.forceFinalizePendingTokens();
}
```

Tradeoffs:

- Adds latency (must wait for threshold before deciding speech ended)
- Threshold tuning is tricky (too short → premature finals during pauses, too long → noticeable delay)
- Could conflict with device reconnection patterns (BLE hiccups look like silence)

### Option C: Soniox server-side VAD

Soniox has its own VAD capabilities. If configured, it may emit finals on its own when audio stops. Worth investigating whether this is already enabled or can be turned on without side effects.

## Decision

Wait for client team to report back on forwarding glasses VAD events (Option A). If that doesn't pan out, revisit Option B with a configurable per-device-type threshold.

## Date

2026-02-16
