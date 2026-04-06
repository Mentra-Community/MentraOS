# Spike: Dead WebSocket on App Start

## The User Flow

1. User taps a mini app
2. `startApplet()` is called — [applets.ts:781](mobile/src/stores/applets.ts#L781)
3. This calls `startStopApplet()` which calls `restComms.startApp(packageName)` — [applets.ts:658](mobile/src/stores/applets.ts#L658)
4. `startApp()` sends `POST /apps/:packageName/start` over REST — [RestComms.ts:177-180](mobile/src/services/RestComms.ts#L177-L180)
5. On the cloud, the route handler calls `c.get("userSession")` — [apps.routes.ts:337](cloud/packages/cloud/src/api/hono/routes/apps.routes.ts#L337)
6. That `userSession` is populated by the `requireUserSession` middleware — [client.middleware.ts:151](cloud/packages/cloud/src/api/hono/middleware/client.middleware.ts#L151)
7. The middleware calls `UserSession.getById(email)` — [client.middleware.ts:161](cloud/packages/cloud/src/api/hono/middleware/client.middleware.ts#L161)

## Where It Breaks

If the WebSocket is dead, the `UserSession` has been disposed (or was never created on this server instance). `UserSession.getById(email)` returns `null`.

The middleware returns **503**:

```json
{
  "error": "no_active_session",
  "message": "No active cloud session. Please ensure your app is connected."
}
```

— [client.middleware.ts:163-171](cloud/packages/cloud/src/api/hono/middleware/client.middleware.ts#L163-L171)

The mobile receives the 503 but does not handle it specifically. The user sees _"app is currently not available, please contact the developer."_

## How the WebSocket Dies

The mobile connects to the cloud via a single WebSocket at `/glasses-ws`.

- Connection is established in `WebSocketManager.connect()` — [WebSocketManager.ts:109-162](mobile/src/services/WebSocketManager.ts#L109-L162)
- The URL is built from the backend setting with `/glasses-ws` appended — [settings.ts:805-809](mobile/src/stores/settings.ts#L805-L809)
- On the cloud, `GlassesWebSocketService.handleConnection()` receives it — [websocket-glasses.service.ts:68](cloud/packages/cloud/src/services/websocket/websocket-glasses.service.ts#L68)
- The cloud creates or reconnects a `UserSession` via `UserSession.createOrReconnect(ws, userId)` — [UserSession.ts:480](cloud/packages/cloud/src/services/session/UserSession.ts#L480)

The WebSocket can die silently in several ways (we do not care right now):

- App goes to background, OS kills the connection
- Cloud restarts or pod eviction without a clean close frame
- Network switch (WiFi → cellular)
- Cloudflare absorbs the close frame at the edge

When the WebSocket closes on the cloud side:

1. `handleGlassesConnectionClose()` fires — [websocket-glasses.service.ts:222](cloud/packages/cloud/src/services/websocket/websocket-glasses.service.ts#L222)
2. Sets `userSession.disconnectedAt` — line 243
3. Starts a **1-minute grace period** timer — line 252
4. If the user doesn't reconnect in 1 minute, `userSession.dispose()` is called — line 323
5. After dispose, `UserSession.getById(email)` returns `null`

## How the Client Detects Dead Sockets Today

- The server sends `{"type":"ping"}` every 2s. The client responds with `{"type":"pong"}` — [SocketComms.ts:691-693](mobile/src/services/SocketComms.ts#L691-L693)
- The client tracks `lastMessageTime` — updated on every incoming message — [WebSocketManager.ts:144](mobile/src/services/WebSocketManager.ts#L144)
- A liveness monitor runs every 4s (`LIVENESS_CHECK_INTERVAL_MS`) and checks if `lastMessageTime` is older than 8s (`LIVENESS_TIMEOUT_MS`) — [WebSocketManager.ts:238-250](mobile/src/services/WebSocketManager.ts#L238-L250)

If stale:

1. Force-closes the socket — line 246
2. Sets status to `DISCONNECTED` — line 247
3. Starts reconnect interval (every 5s) — line 248

**Constants:**

| Constant                     | Value   | Location                                                              |
| ---------------------------- | ------- | --------------------------------------------------------------------- |
| `LIVENESS_TIMEOUT_MS`        | `8_000` | [WebSocketManager.ts:25](mobile/src/services/WebSocketManager.ts#L25) |
| `LIVENESS_CHECK_INTERVAL_MS` | `4_000` | [WebSocketManager.ts:28](mobile/src/services/WebSocketManager.ts#L28) |
| `RECONNECT_INTERVAL_MS`      | `5_000` | [WebSocketManager.ts:31](mobile/src/services/WebSocketManager.ts#L31) |

## Timeline from Socket Death to Recovery

| Time        | What happens                                                                                                                | User taps mini app → result          |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| **0s**      | Socket dies. Client doesn't know. Status is `CONNECTED`.                                                                    | 503 error → _"app not available"_    |
| **~4s**     | First liveness check. `lastMessageTime` is 4s old. Under 8s threshold. No action.                                           | 503 error → _"app not available"_    |
| **~8s**     | Second liveness check. `lastMessageTime` is 8s old. Detected. Force-close. Status → `DISCONNECTED`. Reconnect timer starts. | REST call still goes out. 503 error. |
| **~13s**    | First reconnect attempt (`RECONNECT_INTERVAL_MS` = 5s). `connect()` called.                                                 | Depends on timing — may still fail   |
| **~13-15s** | If server is up: `onopen` fires, `CONNECTION_ACK` received. Status → `CONNECTED`.                                           | Works                                |

**Total dead time: ~13-15 seconds.** During this entire window, tapping a mini app results in an error.

## The Gap

Nothing in the app start flow (`startApplet` → `startStopApplet` → `restComms.startApp`) checks WebSocket health before sending the REST call. It fires regardless of connection state.

- `startApplet()` checks app compatibility, foreground app conflicts, offline status — [applets.ts:781-870](mobile/src/stores/applets.ts#L781-L870)
- `startStopApplet()` calls `restComms.startApp()` with no connection check — [applets.ts:657-658](mobile/src/stores/applets.ts#L657-L658)
- `restComms.startApp()` just sends the POST — [RestComms.ts:177-185](mobile/src/services/RestComms.ts#L177-L185)

**No step asks "is the WebSocket alive?" before proceeding.**

## Why the Workaround Works

Going to developer settings and pressing "Save & Test URL":

1. Tests the URL via `GET {url}/apps/version` — [BackendUrl.tsx:100-101](mobile/src/components/dev/BackendUrl.tsx#L100-L101)
2. Saves the URL — line 119
3. On OK press: calls `mantle.cleanup()` — [BackendUrl.tsx:128](mobile/src/components/dev/BackendUrl.tsx#L128)
   - Disconnects LiveKit — [MantleManager.ts:129](mobile/src/services/MantleManager.ts#L129)
   - Cleans up WebSocket and UDP — line 130
   - Calls `restComms.goodbye()` — line 131
4. Navigates to `/` via `replaceAll("/")` — [BackendUrl.tsx:129](mobile/src/components/dev/BackendUrl.tsx#L129)
5. Root route runs `handleTokenExchange()` — [index.tsx:118](mobile/src/app/index.tsx#L118)
   - Token exchange with the (same) server — line 125
   - New `coreToken` received — line 133
   - `mantle.init()` called — line 138
   - `initServices()` → `socketComms.connectWebsocket()` — [MantleManager.ts:134-135](mobile/src/services/MantleManager.ts#L134-L135)
6. New WebSocket opened, new session created, everything works

**This is a full teardown and reconnect.** The fix should do the same thing automatically when a 503 is received.
