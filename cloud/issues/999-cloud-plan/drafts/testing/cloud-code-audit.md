# Cloud Code Audit

Read-only audit of the MentraOS cloud server code. Findings are organized by severity and category. Nothing has been changed. Each finding needs review to determine if it's a bug, intentional, or a regression.

**Audited:** April 8, 2026
**Scope:** All REST endpoints, WebSocket handlers, UDP handlers, auth middleware, legacy routes

---

## Security Findings

Security-sensitive findings (auth bypasses, injection vulnerabilities, credential leaks, unauthenticated endpoints) are documented separately in `security-audit.md` (gitignored, not committed to the public repo). 17 security findings total.

---

## High (Bugs)

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

Both paths are live. The legacy one at `/auth/exchange-store-token` has issues (see `security-audit.md`). The new one at `/api/store/auth/exchange-store-token` is clean.

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

---

## Summary by Severity

| Severity         | Count  | Key Items                                                                               |
| ---------------- | ------ | --------------------------------------------------------------------------------------- |
| High (Bugs)      | 2      | A-004 sendError kills WS, A-005 timeout race                                            |
| High (Dead Code) | 4      | A-007 through A-010: ~2000+ lines of duplicated legacy routes                           |
| Medium (Bugs)    | 8      | A-011 through A-018: missing guards, inverted logs, orphaned streams, polling loops     |
| Low (Dead Code)  | 16     | A-023 through A-039: stale files, unused constants, commented-out code, misleading logs |
| **Total**        | **30** |                                                                                         |

17 additional security findings are in the gitignored `security-audit.md`.

---

# Mobile Client Audit

Read-only audit of the MentraOS mobile app's cloud interaction layer. Focus on REST endpoints, WebSocket handlers, UDP audio, and dead code.

**Codebase:** `MentraOS-2/mobile/`

## Critical

### M-001: `/api/client/goodbye` endpoint does not exist on cloud

**File:** `mobile/src/services/RestComms.ts`, ~L621-632, called from `MantleManager.ts` L131

The mobile app POSTs to `/api/client/goodbye` on every disconnect. This endpoint does not exist anywhere in the cloud codebase (zero matches across all cloud source). The call silently 404s every time. The return value is never checked by the caller.

### M-002: i18n strings contain literal "TODO" visible to users

**File:** `mobile/src/utils/en.ts`, ~L249-253 and L537

Three i18n string values are literally `"TODO1"`, `"TODO2"`, and `"TODO"`. These are rendered in the UI and visible to end users.

### M-003: Duplicate `fanOutPcm` method definitions

**File:** `mobile/src/services/Composer.ts`, ~L190-208

Two identical method definitions of `fanOutPcm`. The second silently overrides the first. Both are entirely commented-out stubs with a TODO. TypeScript may not error on this in a class body.

## High

### M-004: Cloud sends `settings_update` WS message but mobile doesn't handle it

**File:** `mobile/src/services/SocketComms.ts` (handle_message switch)

The cloud can push `settings_update`, `dashboard_mode_change`, and `dashboard_always_on_change` via WebSocket. The mobile client has no handlers for any of these. Settings changes pushed from the cloud are silently ignored.

### M-005: Buffer/video recording WS handlers have no cloud sender

**File:** `mobile/src/services/SocketComms.ts`, ~L555-585

`start_buffer_recording`, `stop_buffer_recording`, `save_buffer_video`, `start_video_recording`, `stop_video_recording` are all handled by the mobile client but do not appear in the cloud SDK `CloudToGlassesMessageType` enum and have zero matches in cloud source. These may be sent by individual mini apps via passthrough, or they may be dead code from a removed feature.

### M-006: No UDP fallback after mid-session network change

**File:** `mobile/src/services/UdpManager.ts`

Once `audioEnabled = true` is set after a successful probe, there's no monitoring that UDP stays available. If the network path changes mid-session (WiFi to cellular), UDP packets silently fail and no audio reaches the cloud until the WebSocket reconnects and re-probes. No sustained-failure detection or fallback mechanism.

### M-007: CapsuleMenu hardcodes store URL instead of using configured setting

**File:** `mobile/src/components/miniapps/CapsuleMenu.tsx`, L201

```
const storeUrl = `https://apps.mentraglass.com/package/${packageName}`
```

If the user is on China deployment or a dev server, this share link points to the wrong store. Should use the configured `store_url` setting.

## Medium (Stale References)

### M-008: Multiple REST endpoints use old URL patterns

**File:** `mobile/src/services/RestComms.ts`

| Method                    | Old Path               | Should Be                  |
| ------------------------- | ---------------------- | -------------------------- |
| `startApp()` L195         | `/apps/:pkg/start`     | `/api/apps/:pkg/start`     |
| `stopApp()` L208          | `/apps/:pkg/stop`      | `/api/apps/:pkg/stop`      |
| `exchangeToken()` L273    | `/auth/exchange-token` | `/api/auth/exchange-token` |
| `getAppSettings()` L235   | `/appsettings/:app`    | `/api/appsettings/:app`    |
| `updateAppSetting()` L244 | `/appsettings/:app`    | `/api/appsettings/:app`    |
| `sendErrorReport()` L525  | `/app/error-report`    | `/api/error-report`        |

All work due to backward-compat aliases on the cloud, but they're hitting legacy routes.

## Low (Dead Code)

### M-010: LiveKit infrastructure still loaded despite being disabled

**Files:** `mobile/src/services/Livekit.ts`, `SocketComms.ts`, `WebSocketManager.ts`, `MantleManager.ts`

`Livekit.ts` is a full service class that's imported and partially called. `livekit.connect()` is commented out but `livekit.disconnect()` is still called on cleanup. `WebSocketManager.ts` still sends `livekit=true` query param on WS connect. `RestComms.ts` still has `getLivekitUrlAndToken()`. All of this is dead work on every connection.

### M-011: `Composer.updateOfflineSTT()` is entirely empty

**File:** `mobile/src/services/Composer.ts`, ~L302-310

Method is exported but has no implementation (all lines commented out).

### M-012: `MiniComms` dead handlers

**File:** `mobile/src/services/MiniComms.ts`, ~L216-240

`request_mic_audio` and `request_transcription` message types are in the switch statement but their handlers are commented out. `handleRequestTranscription` body is empty.

### M-013: `Constants.tsx` dead exports

**File:** `mobile/src/utils/Constants.tsx`

`INTENSE_LOGGING`, `enable_phone_notifications_DEFAULT`, and `ConnTypes` are exported but never imported anywhere. `MOCK_CONNECTION` is always `false`.

### M-014: Gallery sync notifications entirely disabled

**File:** `mobile/src/services/asg/gallerySyncNotifications.ts`

Every `Notifications.scheduleNotificationAsync()` call is commented out. Permission check hardcodes `return true`. The entire notification system for gallery sync is stubbed out.

---

# Developer Console Audit

Read-only audit of the developer console frontend.

**Codebase:** `MentraOS-2/cloud/websites/console/`

## High

### C-001: Unreachable duplicate catch-all route

**File:** `console/src/App.tsx`, ~L255-256

```
<Route path="*" element={<NotFound />} />
<Route path="*" element={<LandingPage />} />
```

Two `path="*"` routes. React Router matches the first and never reaches the second. `<LandingPage />` is unreachable.

### C-002: 16 UI call sites still use legacy `api.*` instead of `api.console.*`

**File:** `console/src/services/api.service.ts` and various pages/dialogs

The Zustand stores (`apps.store`, `orgs.store`) use the new `/api/console/*` endpoints. But 16 page/dialog components bypass the stores and call legacy `api.*` functions that hit `/api/dev/*`, `/api/orgs/*`, and `/api/apps/*` directly.

Affected: `CreateOrgDialog`, `OrganizationSettings`, `Members`, `CreateMiniApp`, `PublishDialog`, `DeleteDialog`, `ApiKeyDialog`, `SharingDialog`, `InstallDialog`, `MiniAppTable`, `AdminPanel`, `EditMiniApp`, `ServerUrlInput`, `ImageUpload`, `AuthPage`, `useOrgPermissions`.

### C-003: 8 dead API functions hitting likely non-existent endpoints

**File:** `console/src/services/api.service.ts`

| Function                            | Endpoint                                 | Call Sites |
| ----------------------------------- | ---------------------------------------- | ---------- |
| `api.apps.permissions.get`          | `GET /api/permissions/:pkg`              | 0          |
| `api.apps.permissions.update`       | `PATCH /api/permissions/:pkg`            | 0          |
| `api.auth.updateProfile`            | `PUT /api/dev/auth/profile`              | 0          |
| `api.admin.fixAppStatuses`          | `POST /api/admin/fix-app-statuses`       | 0          |
| `api.admin.createTestSubmission`    | `POST /api/admin/create-test-submission` | 0          |
| `api.admin.users.getAll/add/remove` | `/api/admin/users/*`                     | 0          |
| `api.apps.updateVisibility`         | `PATCH /api/dev/apps/:pkg/visibility`    | 0          |
| `api.apps.updateSharedEmails`       | `PATCH /api/dev/apps/:pkg/share-emails`  | 0          |

### C-004: Inconsistent documentation URLs

Two different docs domains used interchangeably across console components:

- `https://docs.mentra.glass` in `DashboardLayout`, `DashboardHome`, `LandingPage`
- `https://docs.mentraglass.com` in `HelpLink`, `HardwareRequirementsSection`, `ServerUrlField`, `ToolsSection`, `PermissionsSection`, `StoreGuidelines`, `EditMiniApp`

One is likely wrong or a redirect.

## Medium (Dead Code)

### C-005: Dead files

| File                                 | Issue                                                                             |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| `src/hooks/useAuthToken.ts`          | Never imported. Superseded by `@mentra/shared`.                                   |
| `src/components/ShadcnProviders.tsx` | Entirely commented out (48 lines). Never imported.                                |
| `src/types/app.tsx`                  | Never imported. Duplicate `App` interface that conflicts with `src/types/app.ts`. |
| `src/stores/stores.md`               | Planning doc mixed in with source code.                                           |

### C-006: Dead enums

**File:** `console/src/types/enums.ts`

`AppState`, `Language`, `LayoutType`, `ViewType`, `AppSettingType`, `AppType` are all exported but never imported. Only `HardwareType` and `HardwareRequirementLevel` are actually used from this file. `AppState` has a `TODO(isaiah)` asking if it should be removed.

---

# App Store Audit

Read-only audit of the app store frontend.

**Codebase:** `MentraOS-2/cloud/websites/store/`

## High

### S-001: 7 dead API functions

**File:** `store/src/api/index.ts`

| Function                             | Call Sites                                              |
| ------------------------------------ | ------------------------------------------------------- |
| `appService.startApp`                | 0                                                       |
| `appService.stopApp`                 | 0 (only in commented-out code in dead `AppDetails.tsx`) |
| `appService.searchApps`              | 0 (search is done client-side)                          |
| `userService.getCurrentUser`         | 0                                                       |
| `authService.exchangeToken`          | 0                                                       |
| `authService.exchangeTemporaryToken` | 0                                                       |
| `setAuthToken`                       | 0                                                       |

Auth is handled entirely by `@mentra/shared`. These functions are leftover from before that migration.

### S-002: Dead page file with cascading dead components

**File:** `store/src/pages/AppDetails.tsx`

Never routed (import commented out in `App.tsx:11`). Superseded by `AppDetailsV2.tsx`. This causes `Header.tsx` (only imported by dead `AppDetails.tsx`) and `AppPermissions.tsx` (same) to also be dead code.

### S-003: Hardcoded `com.augmentos.xstats` references

**File:** `store/src/components/ui/slides.tsx`, L483, L512, L595

Three hardcoded references to `com.augmentos.xstats` package name in navigation and API calls. Old brand name, should be `com.mentra.xstats` or whatever the current package is.

## Medium

### S-004: Dead hooks and enums

| File                                 | Issue                                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `src/hooks/useToken.tsx`             | Never imported anywhere.                                                                         |
| `src/components/PlatformExample.tsx` | Never imported anywhere.                                                                         |
| `src/types/enums.ts`                 | Same dead enums as console (`AppState`, `Language`, `LayoutType`, `ViewType`, `AppSettingType`). |

### S-005: Env var inconsistency with console

Console uses `VITE_API_URL`, store uses `VITE_CLOUD_API_URL`. Both point to the same backend. Should be standardized.

---

# CLI Audit

Read-only audit of the `@mentra/cli` package.

**Codebase:** `MentraOS-2/cloud/packages/cli/`

## Critical

### CLI-001: `.mentrarc` documented but completely unimplemented

**File:** `README.md` L126-132, zero implementation in `src/`

README tells users to create a `.mentrarc` per-project config with `packageName` and `org` fields. No code anywhere reads this file. Users following the docs get nothing.

### CLI-002: Global options `--quiet`, `--verbose`, `--no-color` are no-ops

**File:** `src/index.ts`, L25-27

Registered with Commander but never read by any command handler. `--quiet` doesn't suppress anything. `--verbose` doesn't add debug output. `--no-color` doesn't disable chalk.

### CLI-003: `app delete` confirmation prompt is misleading

**File:** `src/commands/app.ts`, ~L413-420

The message says "Type the package name to confirm deletion" but the code uses a simple yes/no `confirm()` prompt, not a text `input()` that validates the typed name. The safety confirmation is weaker than described.

## High

### CLI-004: Version mismatch

**File:** `package.json` says `1.0.3`, `src/index.ts` L19 says `.version("1.0.0")`. `mentra --version` prints wrong version.

### CLI-005: `app export` / `app import` round-trip loses data

**File:** `src/commands/app.ts`, ~L537-547 and ~L623-628

Export only includes `packageName, name, description, appType, publicUrl, logoURL`. Both `webviewURL` and `permissions` are silently dropped. Import doesn't set `webviewURL` either. Export then import loses data.

## Medium

### CLI-007: Dead root `index.ts`

**File:** `index.ts` (root)

Contains only `console.log("Hello via Bun!")`. Real entry point is `src/index.ts`.

### CLI-008: 8 exported functions never called

| Function           | File                     |
| ------------------ | ------------------------ |
| `updateCloud()`    | `src/config/clouds.ts`   |
| `setConfigValue()` | `src/config/settings.ts` |
| `getConfigValue()` | `src/config/settings.ts` |
| `display()`        | `src/utils/output.ts`    |
| `warning()`        | `src/utils/output.ts`    |
| `info()`           | `src/utils/output.ts`    |
| `password()`       | `src/utils/prompt.ts`    |
| `multiSelect()`    | `src/utils/prompt.ts`    |

### CLI-012: Test suite is mostly placeholder stubs

**Files:** `test/credentials.test.ts`, `test/api-client.test.ts`

Most tests are `expect(true).toBe(true)` placeholders. `IMPLEMENTATION.md` claims "52+ tests passing" but actual assertions are trivial.

### CLI-013: `TESTING.md` references non-existent test files

**File:** `TESTING.md`

Claims `test/integration/` directory exists with `auth-flow.test.ts`, `app-commands.test.ts`, `cloud-switching.test.ts`. None exist.

---

# Full Audit Summary

| Codebase          | Critical | High   | Medium | Low    | Total  |
| ----------------- | -------- | ------ | ------ | ------ | ------ |
| Cloud Server      | 0        | 6      | 8      | 16     | 30     |
| Mobile Client     | 3        | 4      | 1      | 5      | 13     |
| Developer Console | 1        | 3      | 2      | 0      | 6      |
| App Store         | 0        | 3      | 2      | 0      | 5      |
| CLI               | 3        | 2      | 4      | 0      | 9      |
| **Total**         | **7**    | **18** | **17** | **21** | **63** |

17 additional security findings are in the gitignored `security-audit.md`.

## Recommended Review Order

1. **A-004** - `sendError` killing connections on transient errors. Likely a major contributor to "apps feel broken."
2. **A-005** - Timeout race in app start. 6s session timeout vs 10s webhook timeout.
3. **M-001** - Mobile calls `/api/client/goodbye` which doesn't exist. Silent 404 on every disconnect.
4. **M-002** - Users see literal "TODO" strings in the UI.
5. **CLI-001/002/003** - CLI advertises features that don't work (`.mentrarc`, global flags, delete confirmation).
6. **A-007 through A-010** - ~2000 lines of duplicated legacy routes. Decide what can be removed.
7. **C-002** - Console still has 16 call sites hitting legacy endpoints instead of new console API.
8. **S-001** - Store has 7 dead API functions from before `@mentra/shared` migration.
9. Everything else in severity order.
