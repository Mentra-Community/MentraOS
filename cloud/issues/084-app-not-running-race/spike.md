# Spike: "App is not running" Race Condition

## Overview

**What this doc covers:** A race condition where the cloud rejects messages from a mini app with "App is not running" even though the app just connected and received CONNECTION_ACK.
**Why this doc exists:** Discovered while testing the stream-test app (issue 083). The SDK fires `onSession` immediately after CONNECTION_ACK, developer code sends a stream request, and the cloud rejects it because AppSession hasn't transitioned to RUNNING yet.
**Who should read this:** Cloud engineers, SDK developers.

## The Bug

Timeline of what happens (all within ~75ms):

1. Cloud sends `CONNECTION_ACK` to the SDK
2. SDK receives ACK, fires the developer's `onSession` callback
3. Developer code calls `session.camera.startStream({ direct: "rtmp://..." })`
4. SDK sends `STREAM_REQUEST` to the cloud
5. Cloud receives `STREAM_REQUEST`, calls `UnmanagedStreamingExtension.startStream()`
6. `startStream()` calls `AppManager.isAppRunning(packageName)`
7. `isAppRunning()` checks `this.apps.get(packageName)?.isRunning` — returns `false`
8. Cloud throws "App dev.mentra.streamtest is not running"
9. Error sent back to SDK, crashes the session runtime, transport closes

The app IS running — it has an authenticated WebSocket connection, it received CONNECTION_ACK, and it's sending messages. But the cloud's internal state hasn't caught up yet.

## Where the Check Happens

**File:** `cloud/packages/cloud/src/services/session/UnmanagedStreamingExtension.ts`

```typescript
// Line ~91
if (!this.userSession.appManager.isAppRunning(packageName)) {
  throw new Error(`App ${packageName} is not running`);
}
```

**File:** `cloud/packages/cloud/src/services/session/AppManager.ts`

```typescript
// Line 1202
isAppRunning(packageName: string): boolean {
  const appSession = this.apps.get(packageName);
  return appSession?.isRunning ?? false;
}
```

The `isRunning` flag on `AppSession` depends on the app being in the `RUNNING` state. There's a window between when the WebSocket is authenticated and CONNECTION_ACK is sent, and when AppSession transitions to RUNNING, where messages from the app are rejected.

## Who Else Uses isAppRunning

Need to audit every caller of `isAppRunning` to understand the impact:

```
grep -rn "isAppRunning" cloud/packages/cloud/src/
```

Expected callers:
- `UnmanagedStreamingExtension.startStream()` — the one we hit
- Possibly `ManagedStreamingExtension`
- Possibly photo request handling
- Possibly other hardware request handlers

Each caller needs to be evaluated: is the check protecting against cross-app abuse (valid) or rejecting the app's own messages (invalid)?

## The Core Question

**Why does `isAppRunning` exist?** Two possible reasons:

1. **Prevent cross-app abuse.** App A shouldn't be able to start a stream on behalf of App B. The check ensures the requesting `packageName` corresponds to a running app. This is valid.

2. **Prevent stale requests.** If an app was stopped but a delayed message arrives, don't process it. This is valid but should be handled differently (check the WebSocket identity, not the app state).

In both cases, checking the WebSocket identity (did this message come from the app's own authenticated connection?) is more correct than checking the app state (is this app in the RUNNING state?). If a message arrives on an authenticated app WebSocket, the app is running by definition.

## Proposed Fix

**Don't check `isAppRunning` for messages that arrive on the app's own WebSocket.**

The app WebSocket is already authenticated during the handshake (`handleAppInit` or `handleReconnect` in `bun-websocket.ts`). If the message arrived on that WebSocket, the app is running. The connection itself is the proof.

The `isAppRunning` check should only be used for:
- Cross-app requests (App A asking the cloud to do something involving App B)
- REST API endpoints where there's no WebSocket context
- Admin/system operations that need to verify app state

For messages dispatched from `app-message-handler.ts` (which handles messages from the app's own WebSocket), the check is redundant and causes this race condition.

### What to change

In `UnmanagedStreamingExtension.startStream()` and any similar handler that receives messages from the app's own WebSocket:

```typescript
// Before: checks global app state (racy)
if (!this.userSession.appManager.isAppRunning(packageName)) {
  throw new Error(`App ${packageName} is not running`);
}

// After: check that the message came from an app that has an active WebSocket
// This is already guaranteed by the fact that app-message-handler.ts only
// dispatches messages from authenticated app WebSockets.
// The isAppRunning check can be removed for this code path.
```

Or alternatively, make `isAppRunning` return `true` as soon as the WebSocket is authenticated, not when the session transitions to RUNNING:

```typescript
isAppRunning(packageName: string): boolean {
  const appSession = this.apps.get(packageName);
  // Consider the app running if it has an active WebSocket,
  // even if it hasn't transitioned to RUNNING state yet
  return (appSession?.isRunning || appSession?.hasActiveWebSocket) ?? false;
}
```

### What NOT to change

- Keep the authentication check during WebSocket handshake. The app must be authorized (valid webhook, valid package name, valid API key) before the WebSocket is accepted.
- Keep `isAppRunning` for cross-app and REST API use cases.
- Don't add a `setTimeout` in the SDK. That's a hack, not a fix.

## Temporary Workaround

Until this is fixed in the cloud, apps that send messages immediately in `onSession` need a delay:

```typescript
app.onSession((session) => {
  // Wait for cloud to fully establish the session
  setTimeout(() => {
    session.camera.startStream({ direct: "srt://..." });
  }, 2000);
});
```

This is in the stream-test app currently. It should be removed once the cloud fix ships.

## Next Steps

1. Audit all callers of `isAppRunning` in the cloud
2. Determine which callers are in the app-message-handler path (own WebSocket) vs cross-app/REST paths
3. Remove or relax the check for own-WebSocket paths
4. Verify the fix doesn't open any security holes (an app starting streams for another app)
5. Remove the setTimeout workaround from the stream-test app