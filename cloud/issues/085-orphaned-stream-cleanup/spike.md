# Spike: Orphaned Stream Cleanup

## Overview

**What this doc covers:** Streams that survive app disconnects/restarts and flood new sessions with stale status messages, eventually crashing the new session.
**Why this doc exists:** Discovered while testing managed streaming in the stream-test app (issue 083). Restarting the app left a stale stream running on the glasses. The cloud kept relaying status updates for the orphaned stream to the new session, which couldn't handle them, causing repeated disconnections.
**Who should read this:** Cloud engineers, anyone working on streaming.

## The Bug

1. App starts a direct stream (glasses → RTMP endpoint)
2. App is restarted (developer hits Ctrl+C, `bun --watch` restarts, or app crashes)
3. Nobody tells the glasses to stop streaming — the stream keeps running
4. New app session connects
5. Glasses keep sending `stream_status` for the old stream ID
6. Cloud's `UnmanagedStreamingExtension` tries to relay status to the new app session
7. Relay fails with "Connection not available for messaging" (code 1069) because the new session's WebSocket isn't fully ready (issue 084)
8. Each failed relay triggers `handleAppConnectionClosed`, disconnecting the new session
9. New session reconnects, gets flooded again, disconnects again — infinite loop
10. Stream stays "initializing" forever, app is unusable

## Evidence from Cloud Logs

```
WARN  App dev.mentra.streamtest unexpectedly disconnected (code: 1069) (reason: Connection not available for messaging)
INFO  v3 SDK: entering TRANSPORT_DOWN — subscriptions preserved, waiting for RECONNECT
WARN  Failed to send stream status to owning App dev.mentra.streamtest
DEBUG State transition: transport_down -> transport_down
```

This repeats every ~1.5 seconds, matching the glasses' stream status report interval.

## Root Causes

### 1. Streams aren't stopped when the owning app disconnects

When an app's WebSocket disconnects or the app session is stopped, any active streams owned by that app should be stopped. Currently this doesn't happen.

**Where the cleanup should be:**

`AppManager.handleAppConnectionClosed()` or `AppSession.handleDisconnect()` should call `UnmanagedStreamingExtension.stopStream()` for any streams owned by the disconnecting app.

```
AppSession disconnects
  → AppManager.handleAppConnectionClosed()
    → should check: does this app own any active streams?
    → if yes: tell UnmanagedStreamingExtension to stop them
    → UnmanagedStreamingExtension sends STOP_STREAM to glasses
```

### 2. Stale stream status messages crash new sessions

Even if cleanup is added, there's a window where the glasses may still send a few status messages for the old stream before the stop command arrives. The cloud should handle this gracefully:

- If a `stream_status` arrives for a stream ID that no running app owns, drop it silently
- Don't try to relay it to an app, don't trigger connection errors
- Log it at debug level for observability

### 3. No stream inventory on session startup

When a new app session starts, it has no knowledge of any pre-existing streams. The cloud could:

- On app connect, check if there are any orphaned streams for that package name
- Auto-stop them before the new session begins
- Or inform the new session about existing streams so it can decide to adopt or stop them

## Proposed Fix

### Phase 1: Stop streams on app disconnect (critical)

In `AppManager` or `AppSession`, when an app disconnects:

```typescript
// In handleAppConnectionClosed or similar
const activeStreams = this.userSession.unmanagedStreamingExtension
  .getStreamsForApp(packageName);

for (const stream of activeStreams) {
  await this.userSession.unmanagedStreamingExtension.stopStream(stream.streamId);
}
```

This ensures streams are always cleaned up when the owning app goes away. The glasses receive `STOP_STREAM` and stop the camera.

### Phase 2: Handle stale status messages gracefully (important)

In `UnmanagedStreamingExtension.handleStreamStatus()`:

```typescript
// If the stream ID is unknown or the owning app is disconnected, drop silently
const runtime = this.unmanagedStreams.get(statusMessage.streamId);
if (!runtime) {
  this.logger.debug({ streamId: statusMessage.streamId }, "Dropping status for unknown stream");
  return;
}

if (!this.userSession.appManager.isAppRunning(runtime.packageName)) {
  this.logger.debug({ streamId: statusMessage.streamId }, "Dropping status for disconnected app, stopping stream");
  await this.stopStream(statusMessage.streamId);
  return;
}
```

### Phase 3: Clean up on session start (nice to have)

When a new app session starts (`handleAppInit`), check for and stop any orphaned streams from previous sessions of the same package:

```typescript
// In handleAppInit, after the app is registered
const orphanedStreams = this.userSession.unmanagedStreamingExtension
  .getStreamsForApp(packageName);

if (orphanedStreams.length > 0) {
  logger.info({ count: orphanedStreams.length, packageName }, "Cleaning up orphaned streams from previous session");
  for (const stream of orphanedStreams) {
    await this.userSession.unmanagedStreamingExtension.stopStream(stream.streamId);
  }
}
```

## Impact

Without this fix:
- Any app that starts a stream and then restarts becomes unusable
- The glasses keep streaming indefinitely (draining battery, privacy concern)
- Developer experience is broken for streaming apps during development (frequent restarts)
- The stale status messages cause a reconnection storm that makes the new session unstable

## Related Issues

- **084** — "App is not running" race condition. The stale stream status relay triggers the same code path.
- **083** — Unified camera streaming API. This is how the bug was discovered.

## Next Steps

1. Implement Phase 1 (stop streams on disconnect) — this is the critical fix
2. Implement Phase 2 (drop stale status messages) — prevents the reconnection storm
3. Phase 3 can be deferred but is good defensive coding
4. Test: start stream → kill app → verify glasses stop streaming → restart app → verify clean session