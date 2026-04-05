# Spike: Stream Lifecycle Across Session Disruptions

## Overview

**What this doc covers:** How streams (both managed and direct) should behave across WebSocket blips, app crashes, resurrections, and fresh restarts. Covers both the user experience (the person wearing glasses) and the developer experience (the person writing the mini app).
**Why this doc exists:** Testing the stream-test app (issue 083) revealed that streams become orphaned when the mini app restarts. The glasses keep streaming but nobody controls the stream. Status messages flood the new session and crash it. The current system has no design for stream persistence across session disruptions.
**Who should read this:** Cloud engineers, SDK developers, anyone working on streaming.

## The User's Expectation

A user starts a livestream through a mini app. They don't know or care about WebSockets, cloud instances, or session state. Their expectation is simple:

- **The stream keeps going** unless they explicitly stop it or close the app on their phone
- **Brief network issues are invisible** — the stream doesn't stop because a WebSocket had a hiccup
- **If the app restarts, the stream should survive** — or at minimum, restart automatically without the user doing anything

## The Developer's Expectation

A developer builds a streaming mini app. Their expectation:

- **Starting a stream is simple** — `session.camera.startStream()`
- **If my server restarts, I can resume control** — I get told "hey, there's an active stream" and I can adopt it or stop it
- **I don't lose the viewer URLs** — if I started a managed stream and my server restarts, the HLS/WebRTC URLs should still be valid
- **Status events work across reconnections** — I don't miss status updates during a blip

## Scenarios

### Scenario 1: Transport Blip (WebSocket drops, SDK reconnects within grace period)

**What happens:** Network hiccup, cloud deploy, brief connectivity loss. The mini app process is still alive. The SDK reconnects within milliseconds to seconds. The user doesn't notice.

**Current behavior:**
- Stream keeps running on the glasses (correct)
- Cloud enters TRANSPORT_DOWN for the app session (correct)
- Stream status messages from glasses can't be relayed to the app (broken — causes "Connection not available for messaging" error, triggers disconnect cascade)
- After reconnection, stream status events start flowing again but may have been missed during the gap

**Correct behavior:**
- Stream keeps running (no change)
- Stream status messages that arrive while the app is in TRANSPORT_DOWN should be queued or silently dropped, NOT trigger a connection error
- After reconnection, the app should receive the current stream state so it can sync its UI
- No stream interruption, no cleanup, no user-visible impact

### Scenario 2: Resurrection (grace period expires, cloud restarts the app session)

**What happens:** The mini app's WebSocket drops and doesn't reconnect within the 5-second grace period. The cloud fires the stop webhook and then a new start webhook. The mini app's `onSession` fires again. The process is still alive but the SDK creates a fresh session context.

**Current behavior:**
- Stream keeps running on the glasses (the glasses don't know the app session restarted)
- New app session has no knowledge of the existing stream
- Stream status messages arrive for the new session but reference an unknown stream ID
- Status relay fails, causes reconnection storm (the bug we hit)

**Correct behavior:**
- Stream keeps running on the glasses (correct — don't interrupt the user)
- On resurrection, the cloud should inform the new session about any active streams owned by the app's previous session
- The new session should receive stream info (stream ID, type, URL, status) either in the CONNECTION_ACK or as an immediate message after connection
- The SDK should surface this to the developer via a callback or property: `session.camera.getActiveStreams()` or `session.camera.onExistingStream(handler)`
- The developer can then decide: adopt the stream (update their UI to show it's live) or stop it

### Scenario 3: Mini App Process Crash and Restart

**What happens:** The mini app server process dies (OOM, unhandled error, developer Ctrl+C) and restarts. All in-memory state is lost. A new WebSocket connection is established. From the cloud's perspective this looks identical to Scenario 2 (resurrection or fresh start).

**Current behavior:** Same as Scenario 2 — orphaned stream, reconnection storm.

**Correct behavior:** Same as Scenario 2 — inform the new session about active streams.

### Scenario 4: Developer Restarts During Development

**What happens:** Developer hits Ctrl+C, `bun --watch` restarts the process. This is Scenario 3 but happens dozens of times per day during development.

**Current behavior:** Each restart leaves an orphaned stream. The glasses keep streaming. The developer has to restart the glasses to clear the stale stream.

**Correct behavior:** Same as Scenario 2/3. Additionally, if the developer's new code doesn't explicitly adopt the existing stream, it should be auto-stopped after a timeout (e.g. 30 seconds of no adoption = stop the stream). This prevents battery drain from forgotten streams during development.

### Scenario 5: User Stops the App

**What happens:** The user closes the mini app from the Mentra phone app.

**Current behavior:** The app's stop webhook fires. Stream may or may not be stopped depending on whether the mini app handles `onStop` correctly.

**Correct behavior:**
- The cloud should stop ALL streams (managed and direct) owned by the stopping app
- This is the one scenario where cleanup is always correct — the user explicitly ended the app
- The glasses should receive STOP_STREAM and turn off the camera
- The flash/LED should turn off (privacy indicator)

## What Needs to Change

### 1. Don't crash on status messages for TRANSPORT_DOWN apps

**Where:** `UnmanagedStreamingExtension.handleStreamStatus()` and the relay path in `UserSession`

When the cloud tries to relay a stream status message to an app that's in TRANSPORT_DOWN, it should queue or drop the message instead of triggering `handleAppConnectionClosed`. The current code treats "can't send to app" as "app disconnected" which is wrong when the app is already known to be in TRANSPORT_DOWN.

```
if app is in TRANSPORT_DOWN:
  queue the status message (deliver on reconnect)
  DO NOT trigger handleAppConnectionClosed
  DO NOT close the WebSocket
```

### 2. Inform new sessions about existing streams

**Where:** `AppManager.handleAppInit()` or the CONNECTION_ACK message

When a new app session connects (fresh or resurrected), check if there are active streams for that package name:

```
on app connect:
  activeStreams = unmanagedStreamingExtension.getStreamsForApp(packageName)
  managedStreams = managedStreamingExtension.getStreamsForApp(packageName)

  if streams exist:
    send EXISTING_STREAMS message to the app with stream details
    (or include in CONNECTION_ACK)
```

The SDK receives this and surfaces it to the developer:

```typescript
app.onSession((session) => {
  // Check for streams from a previous session
  const existing = session.camera.getActiveStreams();
  if (existing.length > 0) {
    console.log("Resuming stream:", existing[0].streamId);
    // UI: show "streaming" state
  }
});
```

### 3. Stop streams on explicit app stop

**Where:** `AppManager.stopApp()` or the stop webhook handler

When the cloud processes a stop for an app (user closed it, not a transport blip):

```
on app stop (not disconnect, not transport blip — actual stop):
  unmanagedStreamingExtension.stopStreamsForApp(packageName)
  managedStreamingExtension.stopStreamsForApp(packageName)
  send STOP_STREAM to glasses
```

### 4. Auto-stop orphaned streams after timeout

**Where:** `UnmanagedStreamingExtension`

If a stream exists but the owning app hasn't connected (or reconnected) within a configurable timeout (e.g. 30 seconds), auto-stop the stream. This prevents indefinite streaming from crashed apps.

```
stream has no connected owner for 30 seconds:
  stop the stream
  send STOP_STREAM to glasses
  log: "Auto-stopped orphaned stream {streamId} for {packageName}"
```

This timeout should be longer than the resurrection grace period (5s) to give the app time to reconnect and adopt the stream.

## Managed vs Direct Streams

Both stream types need the same lifecycle handling, but with different details:

| Aspect | Direct Stream | Managed Stream |
|--------|--------------|----------------|
| Who receives the video | Developer's endpoint (RTMP/SRT URL) | MentraOS cloud relay |
| Viewer URLs | None | HLS, DASH, WebRTC |
| Survives app blip? | Should: yes | Should: yes (relay keeps running) |
| Survives app restart? | Should: adoptable | Should: adoptable (viewer URLs still valid) |
| Cleanup on app stop | Send STOP_STREAM to glasses | Send STOP_STREAM to glasses + stop relay |
| Status messages | `stream_status` from glasses | `managed_stream_status` from relay infrastructure |

For managed streams, the relay infrastructure (Cloudflare, HLS/DASH servers) continues running independently of the mini app. The viewer URLs remain valid even if the mini app restarts. The mini app just needs to re-learn the URLs.

## SDK API Design

### Getting active streams on session start

```typescript
app.onSession((session) => {
  // Streams that were started by a previous session of this app
  // and are still running on the glasses
  const activeStreams = session.camera.getActiveStreams();

  for (const stream of activeStreams) {
    if (stream.type === "managed") {
      console.log("Managed stream still live:", stream.hlsUrl, stream.webrtcUrl);
      // Update UI with viewer URLs
    } else {
      console.log("Direct stream still running to:", stream.url);
      // Update UI to show streaming state
    }
  }
});
```

### Adopting vs stopping existing streams

```typescript
app.onSession((session) => {
  const active = session.camera.getActiveStreams();

  if (active.length > 0) {
    // Option A: Adopt it — keep streaming, take control
    // Status events will now flow to this session
    // Nothing to call — adoption is automatic on connect

    // Option B: Stop it — don't want this stream anymore
    session.camera.stopStream();
  }
});
```

### Stream status across reconnections

```typescript
session.camera.onStreamStatus((status) => {
  // This fires for both new streams and adopted streams
  // After a reconnection, the first status event gives you
  // the current state of the stream
  console.log(status.streamId, status.status);
});
```

## v3 CameraManager Bug: Unhandled rtmp_stream_status

The cloud sends `rtmp_stream_status` as a top-level message type, but the v3 `_MessageRouter` doesn't have a handler for it. The `CameraManager.onStreamStatus()` registers on the DATA_STREAM router for `StreamType.STREAM_STATUS`, but the cloud sends it as a direct message.

Fix: Register a top-level message handler in CameraManager for `rtmp_stream_status`:

```typescript
// In CameraManager constructor
this.deps.messageHandlers.register("rtmp_stream_status", (msg) => {
  this.currentStreamState = msg;
  this.events.emit("rtmp_stream_status", msg);
});
```

This is separate from the lifecycle issues but was discovered alongside them.

## Related Issues

- **083** — Unified camera streaming API. This is where the bugs were discovered.
- **084** — "App is not running" race condition. The stale stream status relay triggers the same code path that causes the race.

## Priority

1. **Don't crash on TRANSPORT_DOWN status relay** — fixes the immediate reconnection storm
2. **Register rtmp_stream_status handler in CameraManager** — fixes the "unhandled message type" warning
3. **Stop streams on explicit app stop** — prevents orphaned streams when user closes the app
4. **Inform new sessions about existing streams** — enables adoption after restart/resurrection
5. **Auto-stop after orphan timeout** — safety net for development and edge cases