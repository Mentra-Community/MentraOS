# Consolidate SessionService and SessionStorage into UserSession

Owner: cloud/session
Status: Proposal (investigation complete)
Scope: packages/cloud

## Goal

Unify session lifecycle, accessors, and app-relay helpers inside `UserSession`, and remove the redundant `SessionStorage` and `session.service.ts` layers. This simplifies the call graph, avoids proxy/singleton indirection, and reduces circular-dependency risk.

## TL;DR

- Move the singleton map from `SessionStorage` into `UserSession` as a private static Map<string, UserSession> with static accessors.
- Replace `SessionService` APIs with static or instance methods on `UserSession` (or existing managers) and update all imports/callers.
- Keep behavior the same (reconnect, mic-state updates, app relay, audio mapping, settings lookup), just consolidate the surface area.

---

## Current State

### SessionStorage (to be removed)

- File: `packages/cloud/src/services/session/SessionStorage.ts`
- Holds a singleton map of sessions with typical CRUD helpers and debug logging.
- Used by `UserSession` constructor and static helpers to store/get sessions.
- Also referenced by:
  - `packages/cloud/src/services/debug/MemoryTelemetryService.ts` (to list sessions)
  - `packages/cloud/src/index.ts` (to list sessions for logs/health)
  - Multiple docs under `cloud/docs/**` reference it conceptually.

### SessionService (to be removed)

- File: `packages/cloud/src/services/session/session.service.ts`
- Exposes a proxy-initialized singleton with:
  - createSession(ws, userId) → { userSession, reconnection }
  - getSession(sessionId)
  - transformUserSessionForClient(userSession)
  - getAllSessions()
  - getSessionByUserId(userId)
  - getUserSettings(userId)
  - getAppSettings(userId, packageName)
  - relayMessageToApps(userSession, data)
  - relayAudioToApps(userSession, audioData)
  - relayAudioPlayResponseToApp(userSession, audioResponse)
- Note: `transformUserSessionForClient()` updates microphone state as a side-effect, based on aggregate subscriptions.

### UserSession (target consolidation point)

- File: `packages/cloud/src/services/session/UserSession.ts`
- Already owns most session state and managers; registers itself via `SessionStorage` today.
- Provides static `getById()` / `getAllSessions()` (wrappers over `SessionStorage`) and instance methods for heartbeat, reconnection, dispose, etc.
- Contains `audioPlayRequestMapping` used by `SessionService.relayAudioPlayResponseToApp`.

---

## Usage Inventory (callers to update)

Below is the concrete inventory of code importing/depending on `SessionStorage` and `SessionService`, plus direct `UserSession.getById()` sites (for awareness). All must be reviewed during the migration.

### Direct SessionStorage usages

- `packages/cloud/src/services/session/UserSession.ts` (import + set/get/delete calls)
- `packages/cloud/src/services/debug/MemoryTelemetryService.ts` (import + getAllSessions)
- `packages/cloud/src/index.ts` (import + getInstance + getAllSessions for diagnostics)
- Docs: multiple md/mdx under `cloud/docs/**` reference SessionStorage patterns

### Direct SessionService usages

- Routes
  - `packages/cloud/src/routes/hardware.routes.ts`
  - `packages/cloud/src/routes/app-settings.routes.ts`
  - `packages/cloud/src/routes/account.routes.ts`
  - `packages/cloud/src/routes/photos.routes.ts`
  - `packages/cloud/src/routes/audio.routes.ts`
  - `packages/cloud/src/routes/user-data.routes.ts`
  - `packages/cloud/src/routes/streams.routes.ts`
  - `packages/cloud/src/routes/transcripts.routes.ts`
  - `packages/cloud/src/routes/app-communication.routes.ts`
- Middleware
  - `packages/cloud/src/middleware/glasses-auth.middleware.ts`
  - `packages/cloud/src/middleware/client/client-auth-middleware.ts`
- WebSocket services
  - `packages/cloud/src/services/websocket/websocket-glasses.service.ts` (createSession, relay\*, transformUserSessionForClient)
  - `packages/cloud/src/services/websocket/websocket-app.service.ts` (transformUserSessionForClient)
- Managers / Services
  - `packages/cloud/src/services/session/UnmanagedStreamingExtension.ts` (relay via sessionService)
  - `packages/cloud/src/services/session/AppManager.ts` (transformUserSessionForClient)
  - `packages/cloud/src/services/streaming/ManagedStreamingExtension.ts` (getSessionByUserId)
  - `packages/cloud/src/services/core/location.service.ts` (relayMessageToApps)
- Barrel / Exports
  - `packages/cloud/src/index.ts` (exports sessionService)
- Docs
  - Numerous under `cloud/docs/**` describing/diagramming SessionService

### Direct `UserSession.getById()` usages (informational)

- Websocket services, multiple routes (e.g., `account.routes.ts`, `apps.routes.ts`, `developer.routes.ts`), and docs already use `UserSession.getById()` directly.

---

## Proposed Target API (UserSession)

Introduce/confirm the following methods on `UserSession` and deprecate/remove `SessionStorage` and `SessionService`:

### Static

- `UserSession.createOrReconnect(userId: string, ws: WebSocket): Promise<{ userSession: UserSession; reconnection: boolean }>`
  - Moves logic from `SessionService.createSession()`, including ws update and app bootstrap (`appService.getAllApps`).
- `UserSession.get(userId: string): UserSession | undefined`
- `UserSession.getAll(): UserSession[]`
- `UserSession.delete(userId: string): boolean`

Implementation detail: a private static `sessions = new Map<string, UserSession>()` inside `UserSession` replaces `SessionStorage`.

### Instance

- `snapshotForClient(): Promise<{ ... }>`
  - Replaces `transformUserSessionForClient()`. Preserve behavior: compute `requiresAudio`, derive required data from `microphoneManager`, update mic state, include minimal transcription languages and app subscriptions. Consider extracting mic-state update to a separate `refreshMediaState()` if side-effects in snapshot are undesirable.
- `relayMessageToApps(data: GlassesToCloudMessage): void`
  - Port from `SessionService.relayMessageToApps()`; uses `subscriptionManager` + `appWebsockets` to send.
- `relayAudioToApps(audioData: ArrayBuffer): void`
  - Port from `SessionService.relayAudioToApps()`; delegates to `audioManager.processAudioData`.
- `relayAudioPlayResponseToApp(audioResponse: any): void`
  - Port from `SessionService.relayAudioPlayResponseToApp()`; uses `audioPlayRequestMapping`.

### Settings helpers (option A vs B)

- Option A (minimal churn): Add static helpers on `UserSession`:
  - `UserSession.getUserSettings(userId: string)` and `UserSession.getAppSettings(userId: string, packageName: string)` ported from `SessionService`. These already depend on `User` model and map->obj conversion.
- Option B (cleaner separation): Move to a new `SettingsService` module under `services/core` and update routes to call it directly, not via session.

Recommendation: Option A for first pass (reduce moving parts), with a TODO to extract later.

---

## Migration Plan (incremental, safe)

1. Introduce static Map + accessors in `UserSession` while keeping `SessionStorage` as a shim

- Add `private static sessions = new Map<string, UserSession>()` and implement `get() / getAll() / delete()` and `createOrReconnect()` in `UserSession`.
- Update `UserSession` constructor to register into `UserSession.sessions` instead of `SessionStorage`. Add a temporary adapter inside `SessionStorage` to delegate to `UserSession` so existing callers stay functional during transition.
- Update a small, low-risk caller to use `UserSession.get()` instead of `SessionStorage.getInstance().get()` and verify behavior.

2. Port instance helpers from SessionService into `UserSession`

- Add `snapshotForClient()`, `relayMessageToApps()`, `relayAudioToApps()`, `relayAudioPlayResponseToApp()` to `UserSession`.
- Update internal call sites first (e.g., `AppManager`, `VideoManager`, `location.service`) to use `this.userSession.<method>`.

3. Update WebSocket services

- `websocket-glasses.service.ts`: replace `sessionService.createSession()` with `UserSession.createOrReconnect()`. Replace `relay*` and `transformUserSessionForClient()` calls with `userSession.<method>()`.
- `websocket-app.service.ts`: replace `transformUserSessionForClient()` with `userSession.snapshotForClient()`.

4. Update routes and middleware

- Replace imports of `session.service` in listed routes/middleware with direct `UserSession` static accessors and instance helpers as needed. Common patterns:
  - `sessionService.getSessionByUserId(userId)` → `UserSession.get(userId)`
  - `sessionService.getSession(sessionId)` → `UserSession.get(sessionId)`
  - `sessionService.getAllSessions()` → `UserSession.getAll()`

5. Settings helpers (Option A)

- Move `getUserSettings()` and `getAppSettings()` as static methods on `UserSession`. Update references:
  - `app-settings.routes.ts` and any other direct calls.

6. Remove `SessionStorage` and `SessionService`

- Delete files and their imports.
- In `index.ts`, stop exporting `sessionService`.
- Update diagnostics/telemetry to call `UserSession.getAll()`.

7. Documentation cleanup

- Update docs under `cloud/docs/**` to remove references to `SessionService` and `SessionStorage` or describe the new `UserSession`-centric approach.

8. Test and validate

- Build, lint, and run fast smoke paths (WebSocket connect/reconnect, message relay, audio play response mapping, subscription-driven mic state changes).
- Add/adjust a couple of unit tests where feasible (e.g., `UserSession.createOrReconnect()` behavior and `relayAudioPlayResponseToApp()` mapping).

---

## File-by-File Change Checklist

Core implementation

- Remove: `packages/cloud/src/services/session/SessionStorage.ts`
- Remove: `packages/cloud/src/services/session/session.service.ts`
- Edit: `packages/cloud/src/services/session/UserSession.ts`
  - Add static sessions Map and static methods: `createOrReconnect`, `get`, `getAll`, `delete`
  - Port `transformUserSessionForClient` → `snapshotForClient`
  - Port relay methods: `relayMessageToApps`, `relayAudioToApps`, `relayAudioPlayResponseToApp`
  - Register in static Map instead of SessionStorage

Primary callers to update imports/usage

- `packages/cloud/src/services/websocket/websocket-glasses.service.ts`
- `packages/cloud/src/services/websocket/websocket-app.service.ts`
- `packages/cloud/src/services/session/UnmanagedStreamingExtension.ts`
- `packages/cloud/src/services/session/AppManager.ts`
- `packages/cloud/src/services/streaming/ManagedStreamingExtension.ts`
- `packages/cloud/src/services/core/location.service.ts`
- Routes: `hardware.routes.ts`, `app-settings.routes.ts`, `account.routes.ts`, `photos.routes.ts`, `audio.routes.ts`, `user-data.routes.ts`, `streams.routes.ts`, `transcripts.routes.ts`, `app-communication.routes.ts`
- Middleware: `glasses-auth.middleware.ts`, `client-auth-middleware.ts`
- Barrel: `packages/cloud/src/index.ts` (stop exporting `sessionService`)

Secondary callers (diagnostics/telemetry)

- `packages/cloud/src/services/debug/MemoryTelemetryService.ts` → use `UserSession.getAll()`
- `packages/cloud/src/index.ts` → use `UserSession.getAll()`

Documentation

- Update/remove references under:
  - `cloud/docs/cloud-architecture/services/session-service.mdx`
  - `cloud/docs/cloud-architecture/session-management/**`
  - `cloud/docs/cloud-architecture/managers/**` mentioning SessionService
  - Any tutorial snippets calling `SessionStorage` or `sessionService`

---

## Compatibility Notes & Risks

- Import cycles: Collapsing to `UserSession` reduces one layer of imports; however ensure `UserSession` does not import modules that depend back on routes/services. Current usage of `appService` in `createSession` exists today; keeping that inside `UserSession.createOrReconnect()` maintains parity.
- Side effects in snapshot: `transformUserSessionForClient()` currently updates `microphoneManager` state. Keep this behavior in `snapshotForClient()` to avoid regressions; optionally split later.
- Audio mapping: `audioPlayRequestMapping` already lives on `UserSession`; moving the relay response method in keeps the state and operation co-located.
- Tests/mocks: Any tests that mocked `sessionService` will need updates. Provide shim helpers or refactor tests to use `UserSession` directly.
- Docs/examples: Many docs reference the soon-to-be-removed services; plan a pass to keep docs aligned.

---

## Validation Plan (Green Gates)

- Build: Type-check the whole workspace after each stage; fix import paths.
- Lint: Run the project eslint config.
- Unit: Add minimal unit tests for `createOrReconnect()` (new vs reconnect), and `relayAudioPlayResponseToApp()` mapping.
- Smoke: Local run with a simulated glasses connection to ensure:
  - Reconnect path updates heartbeat and clears cleanup timer
  - App subscriptions still drive mic state and snapshot payload
  - App relay and audio relay work; audio play response reaches correct app

---

## Rollback Plan

- Keep the removal changes isolated in a feature branch.
- If issues arise, restore `SessionService`/`SessionStorage`, revert import changes, and keep `UserSession` static map implementation behind a flag while investigating.

---

## Next Steps

- Implement Step 1 (static map + accessors) and Step 2 (port instance helpers) behind non-breaking adapters.
- Update WebSocket services (highest leverage) and a small route to validate end-to-end.
- Proceed to remaining routes/middleware, then delete the redundant files.
