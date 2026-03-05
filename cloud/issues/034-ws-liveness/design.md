# Design: WebSocket Liveness Detection Implementation

## Overview

**What this doc covers:** Exactly what code changes are needed on the mobile client and cloud to implement application-level ping/pong, fix related reconnection bugs, and improve error responses for missing sessions.

**Why this doc exists:** The [spec](./spec.md) defines _what_ the system should do. This doc defines _how_ — which files change, what the changes look like, and what to watch out for.

**What you need to know first:**

- [spike.md](./spike.md) — why WebSocket connections are dying
- [spec.md](./spec.md) — the ping/pong protocol and timing decisions

**Who should read this:** Engineers implementing the changes on mobile client or cloud.

---

## Changes Summary

| #   | Component | File                                      | Change                                                                                                           |
| --- | --------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1   | Client    | `mobile/src/services/WebSocketManager.ts` | Add liveness monitor (ping sender + timeout checker)                                                             |
| 2   | Client    | `mobile/src/services/WebSocketManager.ts` | Fix `actuallyReconnect()` — reconnect on `ERROR` status, not just `DISCONNECTED`                                 |
| 3   | Client    | `mobile/src/services/WebSocketManager.ts` | Fix `disconnect()` — null out event handlers before closing (prevents stale `onclose` from restarting reconnect) |
| 4   | Cloud     | Glasses WS message handler                | Respond to `{ "type": "ping" }` with `{ "type": "pong" }`                                                        |
| 5   | Cloud     | `client.middleware.ts`                    | Return 503 (not 401) when user is authenticated but has no active session                                        |

---

## Client Changes

All client changes are in `mobile/src/services/WebSocketManager.ts`.

### Change 1: Liveness Monitor

Add three new private fields:

```typescript
private lastMessageTime: number = 0
private livenessCheckInterval: ReturnType<typeof BackgroundTimer.setInterval> = 0
private pingInterval: ReturnType<typeof BackgroundTimer.setInterval> = 0
```

Add constants at the top of the file:

```typescript
const PING_INTERVAL_MS = 2_000
const LIVENESS_TIMEOUT_MS = 4_000
const LIVENESS_CHECK_INTERVAL_MS = 2_000
const RECONNECT_INTERVAL_MS = 5_000
```

Add two new private methods:

**`startLivenessMonitor()`** — called when the WebSocket connects (`onopen`):

- Sets `lastMessageTime = Date.now()`
- Starts a repeating timer that sends `{ "type": "ping" }` every `PING_INTERVAL_MS`
- Starts a repeating timer that checks `Date.now() - lastMessageTime > LIVENESS_TIMEOUT_MS` every `LIVENESS_CHECK_INTERVAL_MS`
- If the timeout is exceeded: log a message, call `detachAndCloseSocket()` (see Change 3), set status to `DISCONNECTED`, start the reconnect interval

**`stopLivenessMonitor()`** — called on disconnect, error, cleanup, and before starting a new connection:

- Clears both intervals

Update `onmessage` handler to reset the liveness clock on every incoming message:

```typescript
this.webSocket.onmessage = (event) => {
  this.lastMessageTime = Date.now()
  this.handleIncomingMessage(event.data)
}
```

In `handleIncomingMessage`, consume `pong` messages without forwarding them to listeners:

```typescript
if (message.type === "pong") {
  return
}
```

Call `startLivenessMonitor()` from `onopen`. Call `stopLivenessMonitor()` from `onerror`, `onclose`, `disconnect()`, `cleanup()`, and at the start of `connect()`.

### Change 2: Fix `actuallyReconnect()` ERROR Status Bug

Current code only reconnects when status is `DISCONNECTED`:

```typescript
// CURRENT (broken)
if (store.status === WebSocketStatus.DISCONNECTED) {
  this.connect(this.url!, this.coreToken!)
}
```

When `onerror` fires, status is set to `ERROR`. If `onclose` doesn't fire promptly (or at all), every reconnect tick is a no-op. The client is stuck — not connected, not reconnecting.

Change to:

```typescript
// FIXED
if (store.status === WebSocketStatus.DISCONNECTED || store.status === WebSocketStatus.ERROR) {
  if (this.url && this.coreToken) {
    this.connect(this.url, this.coreToken)
  }
}
```

Also add a null guard on `this.url` and `this.coreToken` to avoid the `!` non-null assertions.

### Change 3: Fix `disconnect()` Event Handler Leak

`connect()` correctly nulls out event handlers before closing the old socket:

```typescript
// connect() does this right:
if (this.webSocket) {
  this.webSocket.onclose = null
  this.webSocket.onerror = null
  this.webSocket.onmessage = null
  this.webSocket.onopen = null
  this.webSocket.close()
  this.webSocket = null
}
```

But `disconnect()` does not — it calls `.close()` with handlers still attached:

```typescript
// disconnect() does NOT null out handlers:
if (this.webSocket) {
  this.webSocket.close() // ← onclose can still fire after this
  this.webSocket = null
}
```

If `onclose` fires asynchronously after `disconnect()`, it calls `startReconnectInterval()`. This is normally guarded by `manuallyDisconnected`, but creates a race condition when switching backends: `disconnect()` sets `manuallyDisconnected = true`, then the new `connect()` sets it back to `false`, then the stale `onclose` fires and starts a reconnect loop against the old URL.

Extract a shared helper:

```typescript
private detachAndCloseSocket() {
  if (this.webSocket) {
    this.webSocket.onclose = null
    this.webSocket.onerror = null
    this.webSocket.onmessage = null
    this.webSocket.onopen = null
    this.webSocket.close()
    this.webSocket = null
  }
}
```

Use `detachAndCloseSocket()` in both `connect()` (replacing the existing inline version) and `disconnect()`.

---

## Cloud Changes

### Change 4: Respond to Application-Level Pings

**File:** The glasses WebSocket message handler — wherever incoming glasses WS messages are routed by type (likely in `GlassesMessageHandler` or the WS upgrade handler that dispatches messages).

When a message with `type: "ping"` is received:

- Send `{ "type": "pong" }` back on the same WebSocket
- Do not log (2 pings/second/user × many users = log spam)
- Do not relay to apps
- Do not update session state
- Do not treat it as a "glasses message" that triggers any other processing

This should be handled as early as possible in the message handler to avoid unnecessary processing:

```typescript
if (type === "ping") {
  ws.send(JSON.stringify({type: "pong"}))
  return
}
```

**Important:** The server's existing protocol-level heartbeat (`setupGlassesHeartbeat` in `UserSession.ts`) is unchanged. It continues to send protocol-level pings every 10 seconds for server-side dead connection detection. The application-level ping/pong is a separate mechanism for the client's benefit.

### Change 5: Return 503 for Missing Session (not 401)

**File:** `cloud/packages/cloud/src/api/hono/middleware/client.middleware.ts`

In `requireUserSession`, when the user is authenticated (valid JWT, email extracted) but no `UserSession` exists:

Current:

```typescript
if (!userSession) {
  reqLogger.warn(`requireUserSession: No active session found for user: ${email}`)
  return c.json({error: "No active session found"}, 401)
}
```

Change to:

```typescript
if (!userSession) {
  reqLogger.warn(`requireUserSession: No active session found for user: ${email}`)
  return c.json(
    {
      error: "no_active_session",
      message: "No active cloud session. Please ensure your app is connected.",
    },
    503,
  )
}
```

**Why 503:** The user IS authenticated — their JWT is valid. They just don't have an active session because their WS disconnected and the session was disposed. 401 ("Unauthorized") is wrong and misleading:

- The client may interpret 401 as "token expired" and redirect to login
- Logs can't distinguish real auth failures from session gaps
- 503 ("Service Unavailable") correctly communicates "try again after reconnecting"

**Client impact:** The mobile client should handle 503 `no_active_session` responses by showing a "reconnecting" indicator rather than silently failing. This is a separate UI task but the error code change unblocks it.

---

## What This Does NOT Change

- **Protocol-level server pings** — The 10-second `websocket.ping()` in `setupGlassesHeartbeat` stays. It handles server-side detection and keeps the connection alive through nginx/Cloudflare.
- **Session grace period** — The 60-second `UserSession` dispose timer stays. Faster client-side reconnection means the client is more likely to reconnect within this window.
- **Reconnect interval timing** — Still 5 seconds between reconnect attempts.
- **UDP audio path** — Completely unaffected.
- **Cloud ↔ TPA WebSockets** — No changes. TPAs detect 1006 via the SDK and reconnect immediately. May add app-level ping/pong later if needed.

---

## Testing

### Manual verification

1. Connect mobile client to local cloud
2. Pause the Docker container (simulates silent connection death)
3. **Before this change:** Client doesn't notice for 60+ seconds
4. **After this change:** Client should detect within 4–6 seconds, show disconnected state, and start reconnecting

### Edge cases to verify

| Scenario                                                    | Expected behavior                                                                              |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Server goes down cleanly (close frame sent)                 | `onclose` fires immediately, normal reconnect — ping/pong is irrelevant                        |
| Server process killed (no close frame)                      | Liveness timeout fires after ~4s, force close, reconnect                                       |
| Network black-hole (packets silently dropped)               | Same as above — pings get no response, timeout at ~4s                                          |
| Temporary network blip (1-2s)                               | Liveness timeout is 4s, so a brief blip won't trigger false disconnect                         |
| Client sends ping, server responds with pong after 3s delay | `lastMessageTime` resets on the pong, no false disconnect                                      |
| Client switches backends (changes `backend_url` setting)    | `cleanup()` → `stopLivenessMonitor()` + `detachAndCloseSocket()`, new `connect()` starts fresh |
| Server receives ping but session doesn't exist              | Server responds with pong anyway — ping is handled at the WS layer, not the session layer      |

---

## Rollout

1. **Cloud first** — deploy the pong responder (Change 4) and the 503 error code (Change 5). These are backward-compatible — old clients that don't send pings are unaffected. Old clients receiving 503 instead of 401 may behave slightly differently, verify this doesn't cause issues (e.g. the client doesn't have special 401 handling that triggers logout).
2. **Client second** — ship the liveness monitor (Change 1), reconnect fix (Change 2), and disconnect fix (Change 3). These work even before the cloud change is deployed — the liveness monitor resets on _any_ incoming message, not just pongs. The pings just won't get responses until the cloud change lands, but existing traffic (display events, etc.) will still reset the liveness clock.

This ordering means either side can be deployed independently without breaking the other.
