# Design Spec: Client WebSocket Fix

## Overview

Three changes to fix the dead WebSocket problem:

1. **Flip ping-pong direction** — client pings the cloud, not the other way around.
2. **New error code** — cloud returns a specific code when the WebSocket is dead and no active session exists.
3. **New health-check endpoint** — client calls it when a pong is missed to confirm whether the session is actually dead, then reconnects if needed.

---

## 1. Client-Initiated Ping-Pong

**Current behavior:** The cloud sends `ping`, the client responds with `pong`.

**New behavior:** The client sends `ping` every **5 seconds**. The cloud responds with `pong`.

**Why flip it:** The client is the one that needs to know if the connection is alive. It should be the one asking, not waiting to be asked.

### What changes

- **Client** ([WebSocketManager.ts](mobile/src/services/WebSocketManager.ts)): Start a 5-second interval that sends `{"type":"ping"}` over the WebSocket. Track when the last `pong` was received.
- **Cloud** ([websocket-glasses.service.ts](cloud/packages/cloud/src/services/websocket/websocket-glasses.service.ts)): Stop sending `ping`. Instead, listen for `ping` and respond with `pong`.
- **Client** ([SocketComms.ts](mobile/src/services/SocketComms.ts)): Handle incoming `pong` instead of incoming `ping`.

### Missed pong detection

If the client sends a `ping` and does not receive a `pong` within 5 seconds (i.e. one full interval passes with no response), the client treats the WebSocket as potentially dead and moves to step 3 (health-check).

---

## 2. New Error Code

**Current behavior:** When the WebSocket is dead and the client makes a REST call, the cloud returns:

```
503 — "no_active_session" / "No active cloud session. Please ensure your app is connected."
```

This is too vague. A 503 can mean many things — the same status code is also returned when the server is draining during shutdown ([hono-app.ts:107](cloud/packages/cloud/src/hono-app.ts#L107), [bun-websocket.ts:61](cloud/packages/cloud/src/services/websocket/bun-websocket.ts#L61)). The client can't tell the difference.

**New behavior:** Keep HTTP `503`, but use a specific **string error code** in the response body: `NO_ACTIVE_SESSION_OR_WEBSOCKET`.

```json
{
  "error": "NO_ACTIVE_SESSION",
  "message": "No active WebSocket connection and no active user session for this client."
}
```

This follows the existing pattern in the codebase — domain-specific `UPPER_SNAKE_CASE` string identifiers (see `ConnectionErrorCode` in [ConnectionValidator.ts](cloud/packages/cloud/src/services/validators/ConnectionValidator.ts), `AppErrorCode` in [app-message-handler.ts](cloud/packages/cloud/src/services/session/handlers/app-message-handler.ts)). The client keys off the `error` field in the body, not the HTTP status code.

This error means exactly:

> There is no active WebSocket connection between this client and the cloud, **and** there is no active UserSession for this user.

Both conditions must be true for this code to be returned. This gives the client a clear signal: your connection is dead, reconnect.

### Where it gets returned

- The `requireUserSession` middleware — [client.middleware.ts:163-171](cloud/packages/cloud/src/api/hono/middleware/client.middleware.ts#L163-L171) (replace the current lowercase `"no_active_session"` with `"NO_ACTIVE_SESSION"`)
- The new health-check endpoint (see below)

---

## 3. New Health-Check Endpoint

A new REST endpoint on the cloud that the client calls when it suspects the WebSocket is dead.

### When the client calls it

The client misses a `pong` (sent a `ping`, got nothing back within 5 seconds). Instead of immediately tearing everything down, the client hits this endpoint to confirm.

### What the endpoint checks

1. Is there an active WebSocket connection for this user?
2. Is there an active `UserSession` for this user?

### What it returns

- **If both exist:** Connection is fine. Client was wrong — maybe a single pong got dropped. Client does nothing.
- **If either is missing:** Return the new error code (`NO_ACTIVE_SESSION_OR_WEBSOCKET`). Client now knows for sure the connection is dead.

### What the client does on error code `6767`

1. Enter reconnection mode.
2. Re-establish the WebSocket connection to the cloud.
3. The WebSocket connection automatically creates a new `UserSession` on the cloud side (this already happens today via `UserSession.createOrReconnect` — [UserSession.ts:480](cloud/packages/cloud/src/services/session/UserSession.ts#L480)).
4. Once connected, the client is back to normal.

---

## Flow Summary

```
Client                          Cloud
  |                               |
  |-- ping ---------------------->|
  |<--------------------- pong --|
  |                               |
  |-- ping ---------------------->|
  |           (no pong)           |
  |                               |
  |-- GET /health-check -------->|
  |                               |
  |    (checks: WebSocket alive?  |
  |     UserSession exists?)      |
  |                               |
  |<-- 503 NO_ACTIVE_SESSION ----|
  |                               |
  |-- reconnect WebSocket ------>|
  |<-------- CONNECTION_ACK -----|
  |    (new session created)      |
  |                               |
```

---

## What This Fixes

| Before                                                    | After                                                                                  |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Dead WebSocket goes undetected for ~13-15 seconds         | Detected within ~5-10 seconds (one missed pong + health-check round trip)              |
| Generic 503 error — client doesn't know what's wrong      | `NO_ACTIVE_SESSION_OR_WEBSOCKET` in response body — client knows exactly what happened |
| User sees "app not available, contact developer"          | Client auto-reconnects before the user notices                                         |
| No way to confirm WebSocket state without a full teardown | Health-check endpoint gives a definitive answer                                        |
