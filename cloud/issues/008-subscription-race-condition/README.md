# Subscription Race Condition

Async message handling causes subscription updates to be processed out of order, resulting in dropped subscriptions.

## Documents

- **subscription-race-spec.md** - Problem analysis and root cause
- **subscription-race-fix.md** - Implementation approach

## Quick Context

**Current**: Multiple subscription updates from SDK arrive quickly, cloud processes them concurrently (async handlers), last one to finish wins - often not the correct final state.

**Proposed**: Serialize subscription update processing per-app using a queue owned by `AppSession`.

## Key Context

The SDK sends subscription updates whenever handlers are added/removed. During session setup, this happens rapidly:

1. `handleMessage()` after CONNECTION_ACK sends `[]` (empty)
2. `onAudioChunk()` setup sends `[audio_chunk]`
3. `onTranscriptionForLanguage()` setup sends `[audio_chunk, transcription:en-US]`

Because the cloud's message handler is async and Bun doesn't await it, all 3 process concurrently. If message 2 finishes after message 3, final state is `[audio_chunk]` instead of `[audio_chunk, transcription:en-US]`.

## Evidence

From BetterStack logs for user `israelov+test68@mentra.glass` on `cloud-debug`:

```
06:55:53.655 - Received subscription update from App (3 times)
06:55:53.666 - Subscriptions updated: [audio_chunk, transcription:en-US] (oldCount: 0, newCount: 2)
06:55:53.667 - Empty subscription ignored (grace window)
06:55:53.668 - Subscriptions updated: [audio_chunk] (oldCount: 2, newCount: 1)  ← BUG!
```

The `[audio_chunk]` update should have been processed BEFORE `[audio_chunk, transcription:en-US]`, but async processing caused it to finish last and overwrite the correct state.

## Implementation Decision

**Queue lives in `AppSession`**, not in message handler or `SubscriptionManager`.

Why:

- Per-app state belongs in `AppSession` (the queue is inherently per-app)
- Automatic cleanup when `AppSession.dispose()` is called
- No module-level Maps or exported cleanup functions
- Handler stays stateless, `SubscriptionManager` stays focused on coordination

See `subscription-race-fix.md` for implementation details.

## Status

- [x] Root cause identified
- [x] Implementation approach decided (queue in AppSession)
- [ ] Implement `AppSession.enqueue()` method
- [ ] Update `SubscriptionManager.updateSubscriptions()` to use queue
- [ ] Revert uncommitted handler changes (no longer needed)
- [ ] Test on cloud-debug with Recorder dev
- [ ] SDK-side optimization: remove redundant `updateSubscriptions()` call
