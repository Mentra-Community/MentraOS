# Spike: Unified onStreamStatus Does Not Fire for Managed Stream Events

## Overview

**What this doc covers:** The v3 SDK's unified `onStreamStatus()` handler does not receive managed stream status events (stopped, error, active). This means apps using the v3 API can't detect when a managed stream stops.
**Why this doc exists:** During stream-test development, the glasses ran low on battery and killed the stream. The webview continued showing "Streaming" with a frozen player — the app never learned the stream stopped.
**Who should read this:** SDK developers.

## Background

The v3 SDK introduced a unified `session.camera.onStreamStatus()` that was supposed to replace both `onStreamStatus()` (direct streams) and `onManagedStreamStatus()` (managed streams) with a single handler. The stream-test app uses this unified handler to update its state and push to frontends via SSE.

## Findings

### 1. Two separate event emission paths in CameraManager

The v3 `CameraManager` has two status handlers registered in its constructor:

```typescript
// cloud/packages/sdk/src/session/managers/CameraManager.ts, constructor ~line 207
this.deps.messageHandlers.register(
  CloudToAppMessageType.STREAM_STATUS, (msg) => this.handleStreamStatus(msg)
);
this.deps.messageHandlers.register(
  CloudToAppMessageType.MANAGED_STREAM_STATUS, (msg) => this.handleManagedStreamStatus(msg)
);
```

Each handler emits a DIFFERENT event name:

- `handleStreamStatus()` → emits `"stream_status"` (line ~563)
- `handleManagedStreamStatus()` → emits `"managed_stream_status"` (line ~611)

### 2. `onStreamStatus()` only listens for `"stream_status"`

```typescript
// cloud/packages/sdk/src/session/managers/CameraManager.ts, line ~343
onStreamStatus(handler: StreamStatusHandler): () => void {
  this.deps.addSubscription(StreamType.STREAM_STATUS);
  this.events.on("stream_status", handler);
  // ...
}
```

It subscribes to `StreamType.STREAM_STATUS` and listens for the `"stream_status"` event. It does NOT subscribe to `StreamType.MANAGED_STREAM_STATUS` or listen for `"managed_stream_status"`.

### 3. When the cloud kills a managed stream, the app never knows

When the glasses' battery dies or the SRT connection drops, the cloud's keep-alive mechanism detects the failure:

```
ManagedStreamingExtension: Maximum missed ACKs reached; triggering timeout
ManagedStreamingExtension: Cleaning up managed stream
ManagedStreamingExtension: Sent managed stream status to app  ← sends status: "stopped"
StreamRegistry: Removed stream
```

The cloud sends `managed_stream_status` with `status: "stopped"`. The v3 CameraManager receives it in `handleManagedStreamStatus()`, emits `"managed_stream_status"`. But the app's `onStreamStatus()` handler is listening for `"stream_status"` — it never fires.

### 4. The stream-test app stays frozen

The stream-test app's `StreamManager.attachSession()` registers:

```typescript
// examples/stream-test/src/backend/session/StreamManager.ts
session.camera.onStreamStatus((status: any) => {
  // handles "active", "stopped", "error", "timeout"
  // updates state → pushState() → SSE → webview
});
```

When a managed stream stops, this handler never fires. The `StateManager` never gets updated. The SSE never pushes. The webview keeps showing "● Streaming" with a frozen video player indefinitely.

### 5. The deprecated `onManagedStreamStatus()` DOES work

```typescript
// cloud/packages/sdk/src/session/managers/CameraManager.ts, line ~464
onManagedStreamStatus(handler): () => void {
  this.deps.addSubscription(StreamType.MANAGED_STREAM_STATUS);
  this.events.on("managed_stream_status", handler);
  // ...
}
```

This deprecated method correctly subscribes to managed stream events. The Livestreamer app (v2) uses this and receives managed stream stopped events. But the v3 "unified" API doesn't.

### 6. The gap is in the SDK, not the cloud

The cloud correctly sends `managed_stream_status` for both active and stopped states. The cloud sends `stream_status` for direct streams. Both work independently. The bug is that the v3 SDK's "unified" `onStreamStatus()` only wires up the direct stream path.

### 7. `stopStream()` doesn't reset `isManagedStreaming` locally

`CameraManager.stopStream()` sends `MANAGED_STREAM_STOP` to the cloud but does NOT clear `isManagedStreaming`:

```typescript
// cloud/packages/sdk/src/session/managers/CameraManager.ts, stopStream() ~line 329
if (this.isManagedStreaming) {
  this.deps.sendMessage({
    type: AppToCloudMessageType.MANAGED_STREAM_STOP,
    packageName: this.deps.getPackageName(),
    sessionId: this.deps.getSessionId(),
    timestamp: new Date(),
  });
}
// ← isManagedStreaming is NOT set to false here
```

It relies on the cloud responding with `managed_stream_status: "stopped"`, which triggers `handleManagedStreamStatus()` to clear the flag. But if the stream was already cleaned up by the cloud (keep-alive timeout from glasses battery death), the cloud has nothing to stop and may not send a response. The flag stays `true` permanently.

**Observed behavior:** User clicks Stop (no error), then Start → throws "Already streaming. Stop the current stream before starting a new one." The stop appeared to work (StreamManager reset its own state) but the SDK's internal `isManagedStreaming` flag was never cleared.

This compounds findings #3 and #4: even if the app tries to recover by stopping and restarting, the SDK stays stuck because stop is fire-and-forget with no local state cleanup.

## Root Cause

Two related bugs in `CameraManager`:

1. `onStreamStatus()` was intended to be the single unified handler but only subscribes to `StreamType.STREAM_STATUS` and listens for the `"stream_status"` event. It does not also subscribe to `StreamType.MANAGED_STREAM_STATUS` or listen for `"managed_stream_status"`. The `handleManagedStreamStatus` method emits on a different event channel that `onStreamStatus` never hears.

2. `stopStream()` is fire-and-forget — it sends the stop message but doesn't clear `isManagedStreaming` locally. It depends on the cloud responding with `managed_stream_status: "stopped"`, but that response is delivered via the `"managed_stream_status"` event channel which `onStreamStatus` doesn't hear (bug #1), and may not arrive at all if the stream was already cleaned up by the cloud.

These two bugs form a deadlock: the app can't detect that a managed stream stopped (bug #1), and can't recover by stopping manually because the stop doesn't clear internal state (bug #2).

## Conclusions

| Finding | Impact | Fix |
|---------|--------|-----|
| `onStreamStatus()` misses managed events | Apps can't detect managed stream stop/error | SDK fix: also subscribe + listen for managed events |
| `handleManagedStreamStatus()` emits separate event | Two event channels instead of one unified channel | SDK fix: emit on `"stream_status"` too, or `onStreamStatus` listens to both |
| `stopStream()` doesn't reset `isManagedStreaming` | Can't recover by stop+start if cloud doesn't respond | SDK fix: `stopStream()` should clear `isManagedStreaming` immediately |
| Stream-test app freezes on managed stream death | Bad UX — user thinks stream is still running | Fixed by SDK fixes above |
| Workaround: register both handlers | Works but defeats the purpose of unified API | Temporary fix for stream-test app |

## Next Steps

Write spec for fixing `onStreamStatus()` to also receive managed stream events, and for making `stopStream()` clear local state immediately. Three items to evaluate:
1. `onStreamStatus()` subscribes to BOTH stream types and listens on both event names
2. `handleManagedStreamStatus()` also emits on `"stream_status"` (normalized to a common format)
3. `stopStream()` clears `isManagedStreaming = false` immediately after sending the stop message (don't wait for cloud confirmation)