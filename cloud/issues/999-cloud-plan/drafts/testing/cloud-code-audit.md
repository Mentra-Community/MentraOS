# Cloud Code Audit

Read-only audit of the MentraOS cloud server code. Findings are organized by severity and category. Nothing has been changed. Each finding needs review to determine if it's a bug, intentional, or a regression.

**Audited:** April 8, 2026
**Scope:** All REST endpoints, WebSocket handlers, UDP handlers, auth middleware, legacy routes

---

## Critical

### A-001: `getUserAppSettings` uses raw auth header as userId (no JWT verification)

**File:** `packages/cloud/src/api/hono/routes/app-settings.routes.ts`, ~L222-230

The `GET /appsettings/user/:appName` endpoint takes the raw second word of the Authorization header and uses it directly as a `userId` to look up settings. It does not verify any JWT. It also calls `User.findOrCreateUser(userId)`, meaning an attacker can create user records by sending arbitrary emails in the header.

```
const authHeader = c.req.header("authorization");
const userId = authHeader.split(" ")[1];
// ... used directly in User.findOrCreateUser(userId)
```

**Impact:** Any caller can read and write settings for any user, and create user records.

---

## High (Security)

### A-002: Store search passes user input directly to MongoDB `$regex`

**File:** `packages/cloud/src/services/core/store.service.ts`, ~L98-106

```
const apps = await App.find({
  appStoreStatus: "PUBLISHED",
  $or: [
    { name: { $regex: query, $options: "i" } },
    { packageName: { $regex: query, $options: "i" } }
  ],
}).lean();
```

The user-supplied `query` string from `GET /api/store/search?q=` is passed directly as a MongoDB `$regex` pattern without escaping. This enables ReDoS (regex denial of service) via crafted patterns like `.*.*.*.*.*.*.*a`.

**Impact:** An attacker can slow or hang MongoDB queries. Should use `escapeRegex(query)` or `$text` search.

### A-003: Legacy `exchange-store-token` leaks static Supabase JWT to client

**File:** `packages/cloud/src/api/hono/routes/auth.routes.ts`, ~L246-266

The legacy `POST /auth/exchange-store-token` endpoint returns a `supabaseToken` field in the response that contains the value of the `JOE_MAMA_USER_JWT` environment variable. This is a static server-side token being sent to every caller.

The newer `POST /api/store/auth/exchange-store-token` does NOT include this field.

**Impact:** Every authenticated store token exchanger receives a shared Supabase JWT. The legacy endpoint should be removed or the field stripped.

### A-004: `sendError` kills the entire WebSocket on every error (including transient)

**File:** `packages/cloud/src/services/session/handlers/app-message-handler.ts`, ~L788-806

```
function sendError(ws, code, message, logger) {
  ws.send(JSON.stringify(errorResponse));
  ws.close(1008, message);
}
```

Every call to `sendError()` sends an error message and then forcibly closes the socket with code 1008. This means transient, recoverable errors (e.g., "Glasses not connected" when an app sends `AUDIO_PLAY_REQUEST`) kill the app's entire WebSocket connection. The app has to fully reconnect.

Affected handlers: `handleRgbLedControl`, `handleCameraFovSet`, `handleAudioPlayRequest`, `handleAudioStopRequest`, `handleStreamRequest`, `handlePhotoRequest`, `handleLocationPollRequest`.

**Impact:** Apps get forcibly disconnected on recoverable errors. This is likely a major contributor to the "apps feel broken" experience.

### A-005: Webhook timeout (10s x 2 retries) exceeds app session timeout (6s)

**File:** `packages/cloud/src/services/session/AppManager.ts`, ~L48 and ~L1058-1094

`APP_SESSION_TIMEOUT_MS` is 6 seconds, but `triggerWebhook` has a 10-second timeout with 2 retries and exponential backoff (~23s worst case). The session timeout fires at 6s, resolves the pending connection as timed out, and deletes it from `pendingConnections`. When the webhook eventually succeeds seconds later, it tries to resolve an already-deleted pending connection (no-op). The webhook response is silently discarded.

Race condition: the app server could connect _after_ the timeout but before cleanup, causing unpredictable behavior.

**Impact:** Apps with server startup > 6s will always fail to start, even if the webhook eventually succeeds.

### A-006: JWT secret falls back to empty string

**File:** `packages/cloud/src/services/websocket/websocket.service.ts`, ~L15

```
const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET || "";
```

If the env var is missing, `jwt.verify(token, "")` will verify tokens signed with the empty string, enabling token forgery. The Bun WebSocket handler (`bun-websocket.ts:48`) does NOT use a fallback (correctly leaves it undefined).

**Impact:** If the env var is unset, any token signed with an empty string is accepted.

---

## High (Dead Code / Duplication)

### A-007: `developer.routes.ts` (793 lines) fully duplicates console API

**File:** `packages/cloud/src/api/hono/routes/developer.routes.ts`

The entire file duplicates functionality now in `/api/console/*`:

- `GET /api/dev/apps` = `GET /api/console/apps`
- `POST /api/dev/apps/register` = `POST /api/console/apps`
- `PUT /api/dev/apps/:packageName` = `PUT /api/console/apps/:packageName`
- ... and so on for delete, publish, api-key

Plus legacy-only endpoints: image upload/delete, share/visibility. These are not in the console API yet.

### A-008: `organization.routes.ts` duplicates `/api/console/orgs`

Both are live and handle the same operations (list, create, update, delete, invite, accept). Different auth flows, different code, same functionality.

### A-009: `apps.routes.ts` partially duplicates `/api/client/apps` and `/api/store`

Mounted at both `/api/apps` and `/apps`. Handles install/uninstall/start/stop with a query-parameter-based `unifiedAuthMiddleware`, while the newer `clientAppsApi` and `storeAppsApi` handle the same operations with proper JWT auth.

### A-010: `/auth/*` duplicates `/api/store/auth/*` token exchange

Both paths are live. The legacy one at `/auth/exchange-store-token` has the Supabase JWT leak (A-003). The new one at `/api/store/auth/exchange-store-token` is clean.

---

## Medium (Bugs / Suspicious)

### A-011: Missing WebSocket readyState check in subscription update handler

**File:** `packages/cloud/src/services/session/handlers/app-message-handler.ts`, ~L274-281

```
userSession.websocket.send(JSON.stringify(clientResponse));
```

This `websocket.send()` call has no readyState guard. Every other handler that sends to the glasses WebSocket checks `userSession.websocket && userSession.websocket.readyState === WebSocketReadyState.OPEN` first. This one doesn't. If the mobile WebSocket drops right as an app sends a subscription update, this will throw.

### A-012: WebSocket log message is inverted

**File:** `packages/cloud/src/api/hono/routes/app-settings.routes.ts`, ~L357-360

```
if (appWebsocket) {
  logger.warn({ packageName: appName }, `No WebSocket connection found for App ${appName}`);
  appWebsocket.send(JSON.stringify(settingsUpdate));
```

The `logger.warn("No WebSocket connection found...")` fires when the WebSocket IS found (inside `if (appWebsocket)`). The log message is inverted. This fires on every successful WebSocket settings push.

### A-013: `handleWifiSetupRequest` silently fails (no error response to app)

**File:** `packages/cloud/src/services/session/handlers/app-message-handler.ts`, ~L746-751

When the glasses WS is not connected, this handler logs an error but sends no error response to the SDK app. Compare to `handleRgbLedControl` which properly calls `sendError()`. The app gets no indication the request failed.

(Though given A-004, not calling `sendError` might actually be better since it avoids killing the connection.)

### A-014: Orphaned streams when glasses disconnect (managed and unmanaged)

**Files:**

- `packages/cloud/src/services/streaming/ManagedStreamingExtension.ts`, ~L1207
- `packages/cloud/src/services/session/UnmanagedStreamingExtension.ts`, ~L403-404

When the glasses WS drops, `shouldSendKeepAlive` returns false (WS not open), keep-alives are silently skipped, the missed ACK counter never increments, and the stream stays "alive" in state. The stream is effectively orphaned until session disposal or the periodic cleanup (60 min).

### A-015: `startApp` polling loop with no upper bound

**File:** `packages/cloud/src/services/session/AppManager.ts`, ~L736-761

When a second call to `startApp()` detects the app is already loading, it polls with `setTimeout(checkCompletion, 100)` forever. The only exit conditions are: (a) the pending connection resolves, or (b) the session is disposed. There is no timeout on this poll loop. If `pendingConnections` gets stuck, this polls forever.

### A-016: Dedup cache fix only applies to v3 apps

**File:** `packages/cloud/src/services/session/AppManager.ts`, ~L1810-1813

```
if (connectedAppSession.isV3) {
  this.userSession.managedStreamingExtension.clearLastSentStatus(packageName);
  this.deliverActiveStreamState(packageName, ws);
}
```

The fix for issue 087 (stream status not delivered on reconnect) only runs for v3 apps. v2 apps reconnecting mid-stream will still miss status delivery.

### A-017: UUID regex in binary frame parser rejects uppercase

**File:** `packages/cloud/src/services/session/AppAudioStreamManager.ts`, ~L586-587

```
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-.../.test(streamId)) {
  return null;
}
```

The regex only matches lowercase hex. If any SDK or library generates uppercase UUIDs, binary audio frames will be silently dropped. The debug log ("Unrecognized binary frame from app") is easy to miss.

### A-018: `snapshotForClient()` commented out of CONNECTION_ACK

**File:** `packages/cloud/src/services/websocket/websocket-glasses.service.ts`, ~L205-213

The `snapshotForClient()` call is commented out of the CONNECTION_ACK message sent to the mobile client. The client currently receives no session state on connect. May be intentional (client rebuilds via REST) or may mean the client is missing initial state.

---

## Medium (Security)

### A-019: `/api/admin/debug` exposes DB counts with no auth

**File:** `packages/cloud/src/api/hono/routes/admin.routes.ts`, ~L43

Returns document counts (apps, orgs) and status information to any unauthenticated caller.

### A-020: `/api/onboarding/status` takes email from query param, no auth

**File:** `packages/cloud/src/api/hono/routes/onboarding.routes.ts`, ~L24

Allows probing for user/app existence without authentication.

### A-021: `create-test-submission` admin route relies only on NODE_ENV

**File:** `packages/cloud/src/api/hono/routes/admin.routes.ts`, ~L45

If `NODE_ENV` is misconfigured in production, anyone can create test app submissions.

### A-022: System-app API key auth via query params

**File:** `packages/cloud/src/api/hono/sdk/system-app/system-app.api.ts`, ~L68-71

API keys are passed as query parameters rather than headers. Query params appear in access logs, browser history, referrer headers, and proxy logs. The whitelist restricts this to trusted packages, but credentials should be in headers.

---

## Low (Dead Code / Cleanup)

### A-023: `photo-taken.service.ts` is entirely dead

**File:** `packages/cloud/src/services/core/photo-taken.service.ts`

Explicit deprecation note at the top: "This file is deprecated and not used." Zero imports. Saves photos to local disk via `fs.writeFileSync` with a TODO to use R2. The active implementation is `PhotoManager` in `services/session/`.

### A-024: 6 `AppToCloudMessageType` constants never handled

**File:** `packages/sdk/src/types/message-types.ts`, ~L138-152

`APP_BROADCAST_MESSAGE`, `APP_DIRECT_MESSAGE`, `APP_USER_DISCOVERY`, `APP_ROOM_JOIN`, `APP_ROOM_LEAVE`, `TELEMETRY_RESPONSE` are defined in the enum but have zero handlers in the cloud. TODO comment confirms they're known dead code.

### A-025: 6 `CloudToAppMessageType` constants never sent

**File:** `packages/sdk/src/types/message-types.ts`, ~L175-191

`CUSTOM_MESSAGE` (deprecated), `APP_MESSAGE_RECEIVED`, `APP_USER_JOINED`, `APP_USER_LEFT`, `APP_ROOM_UPDATED`, `APP_DIRECT_MESSAGE_RESPONSE` are defined but never sent by the cloud. These are the app-to-app communication types that were intentionally removed.

### A-026: `startApp`/`stopApp` functions in store are commented out but code remains

**File:** `packages/cloud/src/api/hono/store/store.apps.api.ts`, ~L39-40

The route registrations are commented out, but the handler functions (~60 lines each) are still in the file. Unreachable dead code.

### A-027: `_shouldUseLegacyExpress` and `LEGACY_EXPRESS_PATHS` unused

**File:** `packages/cloud/src/index.ts`, ~L108-119

The legacy Express fallback function and path array are dead code. The Express fallback is commented out.

### A-028: Empty `legacyPrefixes` array in 404 handler

**File:** `packages/cloud/src/hono-app.ts`, ~L490-492

The 404 handler checks for "legacy routes not yet migrated" but the array is empty. The check is always false.

### A-029: `/tpasettings` is a dead alias

**File:** `packages/cloud/src/hono-app.ts`, ~L397-398

`/tpasettings` maps to the same handler as `/appsettings`. TPA = "Third-Party App" (legacy name). Probably no clients use this path anymore.

### A-030: 5 exported service functions never called by any route

**File:** `packages/cloud/src/services/console/console.apps.service.ts`

`getPermissions`, `updatePermissions`, `getShareLink`, `trackSharing`, `applyDefaultCreatePermissions` are exported but never imported by any route handler. The legacy `developer.routes.ts` has inline implementations instead of calling the service.

### A-031: Duplicate null checks in incidents API

**File:** `packages/cloud/src/api/hono/console/incidents.api.ts`, ~L119-123

`getIncidentLogs` checks `!incidentId` twice in a row. The second check is unreachable.

### A-032: Rate limiting TODO never implemented for simple-storage

**File:** `packages/cloud/src/api/hono/sdk/simple-storage.api.ts`, ~L31-33

Comment documents a 100 req/min rate limit, but the middleware is commented out. No rate limiting is applied.

### A-033: `isTranscribing` flag is stale

**File:** `packages/cloud/src/services/session/UserSession.ts`, ~L109

Set during VAD events but barely consumed (only in `snapshotForClient()` and debug). Not used to gate any actual audio processing. Has a TODO to remove.

### A-034: Vestigial binary message counter in glasses WS handler

**File:** `packages/cloud/src/services/websocket/websocket-glasses.service.ts`, ~L90-99

`let i = 0` counter with `i % 10` debug log throttle. The `AudioManager.processAudioData` already has its own logging cadence.

### A-035: Commented-out `sessionService.endSession()` in close handler

**File:** `packages/cloud/src/services/websocket/websocket-glasses.service.ts`, ~L242-244

Leftover from a refactor. Replaced by `userSession.dispose()`.

### A-036: "Phone WebSocket" log in glasses handler

**File:** `packages/cloud/src/services/websocket/websocket-glasses.service.ts`, ~L232-233

The handler is for `/glasses-ws`, but the log message says "Phone WebSocket connection closing." Misleading for debugging.

### A-037: Alibaba transcription/translation providers are stubs (China-only)

**Files:**

- `packages/cloud/src/services/session/transcription/providers/AlibabaTranscriptionProvider.ts`
- Translation equivalent

`initialize()` is a stub that logs "(stub)". 8+ TODO comments. Only loaded when `IS_CHINA` is true (guarded). `task-failed` handler doesn't close WebSocket.

### A-038: Hardcoded `"rtmp_stream_status"` with `as any` cast

**File:** `packages/cloud/src/services/session/AppManager.ts`, ~L2006-2013

`deliverActiveStreamState` sends a message with type `"rtmp_stream_status" as any`, which is a hardcoded string that doesn't match any defined `CloudToAppMessageType` enum value. Needed for v2 SDK compat but fragile.

### A-039: `/ws/miniapp` not handled by ws-based server

**File:** `packages/cloud/src/services/websocket/websocket.service.ts`, ~L125

The Bun WebSocket handler checks for both `/app-ws` and `/ws/miniapp`. The ws-based fallback only checks `/app-ws`. If the server ever runs in a non-Bun environment, `/ws/miniapp` connections will be destroyed.

### A-040: Console JWT secret evaluated at module load, not per-request

**File:** `packages/cloud/src/api/hono/middleware/console.middleware.ts`, ~L17

Inconsistent with CLI middleware which evaluates per-request via `getCLIJWTSecret()`. If the env var changes at runtime (secret rotation), the console middleware won't pick it up.

---

## Summary by Severity

| Severity          | Count  | Key Items                                                                                                   |
| ----------------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| Critical          | 1      | A-001: Auth bypass on settings endpoint                                                                     |
| High (Security)   | 5      | A-002 regex injection, A-003 JWT leak, A-004 sendError kills WS, A-005 timeout race, A-006 empty JWT secret |
| High (Dead Code)  | 4      | A-007 through A-010: ~2000+ lines of duplicated legacy routes                                               |
| Medium (Bugs)     | 8      | A-011 through A-018: missing guards, inverted logs, orphaned streams, polling loops                         |
| Medium (Security) | 4      | A-019 through A-022: unauthenticated endpoints, query param credentials                                     |
| Low (Dead Code)   | 18     | A-023 through A-040: stale files, unused constants, commented-out code, misleading logs                     |
| **Total**         | **40** |                                                                                                             |

## Recommended Review Order

1. **A-001** - Critical auth bypass. Verify if this endpoint is reachable in production.
2. **A-003** - JWT leak in legacy endpoint. Check if the legacy `/auth/exchange-store-token` can be removed.
3. **A-004** - `sendError` killing connections. This is likely a significant contributor to "apps feel broken." Decide whether errors should be non-fatal.
4. **A-002** - Regex injection in store search. Quick fix (escape the input).
5. **A-005** - Timeout race in app start. The 6s session timeout vs 10s webhook timeout mismatch needs a decision.
6. **A-006** - Empty string JWT fallback. Verify the env var is always set in production.
7. **A-007 through A-010** - Legacy route cleanup. ~2000 lines of duplication. Decide which legacy routes can be removed.
8. Everything else in severity order.
