# Soniox Stream Initialization Hang Bug

When Soniox WebSocket closes during initialization, the stream creation promise hangs forever, blocking all future transcription attempts.

## Documents

- **README.md** - This file (problem analysis and fix)

## Quick Context

**Current**: `SonioxTranscriptionStream.initialize()` has a `checkReady()` polling loop that only handles `READY` and `ERROR` states. If WebSocket closes before stream becomes ready, state becomes `CLOSED` but the loop keeps polling forever.

**Result**: `streamCreationPromises` map holds a never-resolving promise, blocking all subsequent stream creation attempts with "Stream creation already in progress, waiting for existing creation".

## Evidence from Logs

```
23:32:05.013 | Creating Soniox transcription stream
23:32:05.013 | Connecting to Soniox WebSocket
23:32:05.402 | Soniox WebSocket connected
23:32:05.402 | Sent Soniox configuration
23:32:05.544 | Stream creation already in progress, waiting   ← Others waiting on promise

23:32:25.613 | Soniox WebSocket closed                        ← WebSocket dies
23:32:25.613 | Stream closed by provider                      ← State = CLOSED

23:37:46.816 | Stream creation already in progress, waiting   ← STILL waiting (5 min later!)
23:38:51.426 | Stream creation already in progress, waiting   ← Promise never resolved
```

## Root Cause

In `SonioxTranscriptionProvider.ts`, the `checkReady()` loop only checks for two states:

```typescript
const checkReady = () => {
  if (this.state === StreamState.READY) {
    resolve()
  } else if (this.state === StreamState.ERROR) {
    reject(this.lastError || new Error("Stream initialization failed"))
  } else {
    setTimeout(checkReady, 100) // ← Polls forever if state is CLOSED!
  }
}
```

When WebSocket closes:

1. `closeHandler` sets `this.state = StreamState.CLOSED`
2. `checkReady()` doesn't recognize `CLOSED` state
3. Loop continues forever: `setTimeout(checkReady, 100)`
4. `initialize()` promise never resolves or rejects
5. All callers waiting on `streamCreationPromises` hang indefinitely

## The Bug Flow

```
1. startStream() called
2. Creates promise, stores in streamCreationPromises
3. Calls _performStreamCreation() → createStreamInstance() → initialize()
4. initialize() starts checkReady() polling loop
5. WebSocket connects, sends config
6. WebSocket closes unexpectedly (network issue, API error, etc.)
7. State becomes CLOSED
8. checkReady() keeps polling (doesn't handle CLOSED)
9. initialize() never returns
10. streamCreationPromises never cleared
11. All future startStream() calls wait on hung promise forever
```

## Fix Applied

```typescript
const checkReady = () => {
  if (this.state === StreamState.READY) {
    resolve()
  } else if (this.state === StreamState.ERROR) {
    reject(this.lastError || new Error("Stream initialization failed"))
  } else if (this.state === StreamState.CLOSED || this.state === StreamState.CLOSING) {
    // NEW: Handle CLOSED state to prevent infinite polling loop
    reject(new Error("Stream closed before becoming ready"))
  } else {
    setTimeout(checkReady, 100)
  }
}
```

## Files Changed

| File                                                                                         | Change                                              |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `packages/cloud/src/services/session/transcription/providers/SonioxTranscriptionProvider.ts` | Added CLOSED/CLOSING state handling in checkReady() |

## Why Only Soniox?

Other providers (Azure, Alibaba) use different initialization patterns:

- Azure: Sets READY state directly in event handler, no polling loop
- Alibaba: Similar direct state transition on WebSocket open

Only Soniox uses the `checkReady()` polling pattern with a 1-second delay before marking READY.

## Status

- [x] Root cause identified (missing CLOSED state in checkReady loop)
- [x] Fix applied to SonioxTranscriptionProvider.ts
- [ ] Test fix in production
- [ ] Consider adding timeout to checkReady loop as safety net

## Related Issues

- Soniox WebSocket closing after 20 seconds may indicate a separate issue (API key? No audio sent?)
- The TranscriptionManager's `streamCreationPromises` pattern is fragile - a never-resolving promise blocks everything
