# 085 — Stream State Delivery on App Connect

**Status:** Ready to implement
**Author:** Isaiah, with Claude
**Date:** April 5, 2026
**Branch:** `cloud/issues-048`

## Principle

**Streams belong to the user, not the app.** A stream should never die because of
an app lifecycle event (disconnect, grace period expiry, resurrection, restart).
The only things that kill a stream are:

1. App explicitly calls `stopStream()`
2. User stops the app from the phone
3. Glasses disconnect (hardware off, out of range)
4. The stream itself fails (SRT/RTMP connection dies, Cloudflare errors)

Everything else — server restarts, deploys, WebSocket blips, developer Ctrl+C,
`bun --watch` reloads — should be invisible to the person wearing the glasses.

## What This Spec Covers

When an app connects (fresh start, resurrection, or reconnect), the cloud should
**proactively deliver active stream state** to the app. The app doesn't need to
ask. The existing `onStreamStatus` handler fires automatically, and the stream
just continues.

This is fully backward compatible. We send existing message types
(`managed_stream_status`, `stream_status`) that every SDK version already handles.

## Current Behavior

1. App starts managed stream → cloud provisions Cloudflare → glasses stream SRT → works
2. App crashes / developer Ctrl+C → cloud enters grace period → app doesn't reconnect
3. Cloud resurrects the app → fires session webhook → new session connects
4. **New session has zero knowledge of the active stream**
5. Stream status messages arrive but the app has no context for them
6. Glasses keep streaming into the void, LED stays on, Cloudflare times out
7. Developer has to restart glasses to clear the zombie stream

## Target Behavior

Steps 1–3 are identical. Then:

4. Cloud sends `CONNECTION_ACK` to the new session (existing behavior)
5. **Cloud immediately checks for active streams on this user's session**
6. **Cloud sends `managed_stream_status` / `stream_status` with full stream info**
7. App's `onStreamStatus` handler fires with the current stream state
8. App updates its UI — "you're streaming, here are the URLs"
9. Stream continues uninterrupted

The developer's code doesn't change at all. Their existing status handler
receives one extra event at connect time.

## Implementation

### Where to inject

`AppManager.attachAppSocket()` — right after `CONNECTION_ACK` is sent and
`deviceManager.sendFullStateSnapshot()` is called. This is the single code path
for both fresh connections and resurrections.

**File:** `cloud/packages/cloud/src/services/session/AppManager.ts`

**Current code (line ~1785):**

```typescript
ws.send(JSON.stringify(ackMessage))
metricsService.incrementMiniappMessagesOut()
this.userSession.deviceManager.sendFullStateSnapshot(ws)
```

**New code:**

```typescript
ws.send(JSON.stringify(ackMessage))
metricsService.incrementMiniappMessagesOut()
this.userSession.deviceManager.sendFullStateSnapshot(ws)

// Deliver active stream state to the app (issue 085).
// This enables stream adoption after app restart/resurrection.
this.deliverActiveStreamState(packageName, ws)
```

### The new method

Add to `AppManager`:

```typescript
/**
 * If the user has active streams, send their current state to the
 * newly-connected app. This allows the app to resume control of
 * streams that survived a disconnect/restart.
 *
 * Sends existing message types (managed_stream_status / stream_status)
 * so every SDK version handles it without changes.
 *
 * See: cloud/issues/085-orphaned-stream-cleanup
 */
private deliverActiveStreamState(packageName: string, ws: IWebSocket): void {
  try {
    // Check managed streams (Cloudflare relay)
    const managedState = this.userSession.managedStreamingExtension
      .getUserStreamState(this.userSession.userId);

    if (managedState && managedState.type === "managed") {
      const previewUrl = `https://iframe.videodelivery.net/${managedState.cfLiveInputId}?autoplay=true&muted=true&controls=true`;

      const statusMessage = {
        type: CloudToAppMessageType.MANAGED_STREAM_STATUS,
        status: "active",
        streamId: managedState.streamId,
        hlsUrl: managedState.hlsUrl,
        dashUrl: managedState.dashUrl,
        webrtcUrl: managedState.webrtcUrl,
        previewUrl: previewUrl,
        activeViewers: managedState.activeViewers.size,
        // Signal that this is a resumed stream, not a freshly started one.
        // Old SDKs ignore unknown fields, new SDKs can use this for UI hints.
        resumed: true,
        timestamp: new Date(),
      };

      ws.send(JSON.stringify(statusMessage));
      metricsService.incrementMiniappMessagesOut();

      this.logger.info(
        { packageName, streamId: managedState.streamId, type: "managed" },
        "Delivered active managed stream state to reconnected app",
      );
    }

    // Check unmanaged/direct streams
    const unmanagedInfo = this.userSession.unmanagedStreamingExtension
      .getActiveStreamInfo();

    if (unmanagedInfo && unmanagedInfo.packageName === packageName) {
      const statusMessage = {
        type: "rtmp_stream_status",  // The type glasses/cloud already use
        status: unmanagedInfo.status || "active",
        streamId: unmanagedInfo.streamId,
        streamUrl: unmanagedInfo.streamUrl,
        resumed: true,
        timestamp: new Date(),
      };

      ws.send(JSON.stringify(statusMessage));
      metricsService.incrementMiniappMessagesOut();

      this.logger.info(
        { packageName, streamId: unmanagedInfo.streamId, type: "direct" },
        "Delivered active direct stream state to reconnected app",
      );
    }
  } catch (error) {
    // Non-fatal — the app can still call checkExistingStream() manually.
    this.logger.warn(
      error,
      "Failed to deliver active stream state (non-fatal)",
    );
  }
}
```

### Fix: Don't crash on TRANSPORT_DOWN status relay

**File:** `cloud/packages/cloud/src/services/session/AppManager.ts` (or wherever
stream status messages are relayed to the app WebSocket)

When the cloud tries to relay a stream status message to an app that's in
`TRANSPORT_DOWN`, it currently triggers `handleAppConnectionClosed` which
cascades into a reconnection storm. Instead:

```typescript
// Before relaying a stream status message to the app:
if (connectedAppSession.transportState === "down") {
  // App is temporarily disconnected — queue or drop, do NOT trigger disconnect.
  this.logger.debug(
    {packageName, streamId},
    "Skipping stream status relay — app transport is down (will deliver on reconnect)",
  )
  return
}
```

This is safe because `deliverActiveStreamState()` will re-deliver the current
state when the app reconnects.

### Fix: Stop streams on explicit app stop (user closes app from phone)

**File:** `cloud/packages/cloud/src/services/session/AppManager.ts` — in the
stop handler

When the cloud processes an explicit app stop (not a transport blip, not a
grace period expiry — an actual "user closed the app" event):

```typescript
async handleAppStop(packageName: string, reason: string): Promise<void> {
  // ... existing stop logic ...

  // If the user explicitly stopped the app, clean up its streams.
  // This is the ONLY app lifecycle event that should kill streams.
  if (reason === "user_stopped" || reason === "user_closed") {
    await this.stopStreamsForApp(packageName);
  }
}

private async stopStreamsForApp(packageName: string): Promise<void> {
  try {
    // Stop managed streams
    const managedState = this.userSession.managedStreamingExtension
      .getUserStreamState(this.userSession.userId);
    if (managedState) {
      await this.userSession.managedStreamingExtension
        .stopManagedStream(this.userSession, { packageName, type: "managed_stream_stop" as any });
      this.logger.info({ packageName }, "Stopped managed stream on app stop");
    }

    // Stop direct streams
    const unmanagedInfo = this.userSession.unmanagedStreamingExtension
      .getActiveStreamInfo();
    if (unmanagedInfo && unmanagedInfo.packageName === packageName) {
      await this.userSession.unmanagedStreamingExtension
        .stopStream({ packageName, type: "stream_stop" as any });
      this.logger.info({ packageName }, "Stopped direct stream on app stop");
    }
  } catch (error) {
    this.logger.error(error, "Error stopping streams on app stop");
  }
}
```

## Backward Compatibility

### Message types

| What we send            | v2 SDK (published)                   | v3 SDK (hono experimental)    | v3 SDK (current branch)       |
| ----------------------- | ------------------------------------ | ----------------------------- | ----------------------------- |
| `managed_stream_status` | ✅ `onManagedStreamStatus()` handler | ✅ same handler               | ✅ `onStreamStatus()` handler |
| `rtmp_stream_status`    | ✅ registered handler                | ⚠️ may not handle (see below) | ✅ registered handler         |
| `stream_status`         | ✅ `onStreamStatus()` handler        | ✅ same handler               | ✅ `onStreamStatus()` handler |

The `resumed: true` field is new but ignored by old SDKs (unknown fields are
silently dropped by JSON parsing).

### SDK versions in the wild

1. **Published v2** — receives `managed_stream_status` via existing handler. Works.
2. **Hono experimental (3.0.0-hono.x)** — same handlers as v2. Works.
3. **Current v3 branch** — unified `onStreamStatus`. Works.

### Apps that don't handle stream status

If a mini app doesn't register any stream status handlers, the messages arrive
and are silently ignored. No crash, no error. The stream continues on the
glasses regardless.

## What the SDK Should Do (optional, not required for this change)

The cloud fix works without any SDK changes. But for a better developer
experience, the v3 SDK could:

1. **Expose `session.camera.getActiveStream()`** — returns the last received
   stream state, or `null`. Populated by the proactive delivery on connect.

2. **Auto-log stream adoption** — when `onStreamStatus` fires with
   `resumed: true` before any `startStream()` call, log:
   `"Adopted existing stream {streamId} from previous session"`

3. **Keep `checkExistingStream()` as a manual fallback** — for apps that
   connect to older cloud versions that don't have this fix yet.

## What the Stream-Test App Already Does

The stream-test app (`examples/stream-test/`) already has the app-side
handling wired up:

- `StreamManager.attachSession()` calls `checkExistingStream()` as a fallback
- `StreamManager.onStreamStatus()` adopts orphaned streams when status "active"
  arrives with no prior `startStream()` call
- `StateManager` pushes adopted stream state to all connected frontends via SSE

With the cloud fix, the `checkExistingStream()` call becomes redundant (but
harmless). The proactive `managed_stream_status` message will arrive first and
populate the state through the normal `onStreamStatus` path.

## Testing Plan

### Manual test (stream-test app)

1. Start the stream-test app, connect glasses, start a managed stream
2. Verify stream is working (WebRTC player shows video)
3. Ctrl+C the app (kill the server)
4. Verify glasses LED stays on (stream persists)
5. Restart the app (`bun run dev`)
6. **Expected:** within 2-3 seconds of reconnection, the webview shows
   "● Streaming" with the correct WebRTC/HLS URLs and the video player
   reconnects to the live stream
7. Hit "Stop Stream" — glasses LED turns off, stream stops

### Manual test (backward compat)

1. Deploy the cloud change to debug
2. Connect a v2 SDK app that uses `startManagedStream()`
3. Start a managed stream
4. Restart the app
5. **Expected:** the v2 `onManagedStreamStatus` handler fires with the
   active stream info

### Edge cases to verify

- **No active stream:** App connects, cloud has no streams → no extra
  messages sent, normal behavior
- **Stream died during disconnect:** Cloud sends stale state, app tries
  WebRTC, gets 409 → WHEP client gives up after 10 retries (already fixed
  in stream-test WHEPClient)
- **Multiple apps:** Only the app that owns the stream gets the state
  delivery (checked via `packageName` for direct streams; managed streams
  are per-user so any app for that user gets them)
- **User stops app from phone:** Streams are stopped, glasses LED turns off

## Files to Change

| File                                                      | Change                                                           |
| --------------------------------------------------------- | ---------------------------------------------------------------- |
| `cloud/packages/cloud/src/services/session/AppManager.ts` | Add `deliverActiveStreamState()`, call it in `attachAppSocket()` |
| `cloud/packages/cloud/src/services/session/AppManager.ts` | Guard status relay for TRANSPORT_DOWN apps                       |
| `cloud/packages/cloud/src/services/session/AppManager.ts` | Stop streams on explicit app stop                                |

## Files NOT Changed

| File                     | Why                                                                     |
| ------------------------ | ----------------------------------------------------------------------- |
| SDK (`packages/sdk/`)    | Not required — existing message handlers work                           |
| ASG Client (glasses app) | Can't touch — separate release cycle                                    |
| Message type definitions | No new types — using existing `managed_stream_status` / `stream_status` |
| stream-test app          | Already handles adoption — the `checkExistingStream()` fallback stays   |

## Sequence Diagram

```
Developer restarts app (Ctrl+C + bun run dev)
│
├── Cloud detects app disconnect
│   ├── Grace period starts (5s)
│   ├── Stream keeps running on glasses ← NEVER TOUCHED
│   └── Grace period expires → cloud marks app as stopped
│
├── Cloud resurrects app → sends webhook to new instance
│   └── New app instance starts → connects WebSocket
│
├── Cloud sends CONNECTION_ACK
│   ├── sessionId, settings, capabilities
│   └── deviceManager.sendFullStateSnapshot()
│
├── Cloud calls deliverActiveStreamState()          ← NEW
│   ├── Checks managedStreamingExtension → found active stream
│   └── Sends managed_stream_status { status: "active", hlsUrl, webrtcUrl, ... }
│
├── SDK receives managed_stream_status
│   └── Fires onStreamStatus handler
│
├── App's StreamManager receives status
│   ├── Sets state.active = true
│   ├── Populates URLs from status message
│   └── pushState() → SSE broadcast to all frontends
│
└── Frontends show "● Streaming" with live video player
    └── Stream continues uninterrupted
```
