# Design: CalendarManager and UserSettingsManager (Cloud-only)

This document specifies the design to introduce two session-scoped managers in the Cloud:

- CalendarManager: normalize, cache, and forward calendar events from both WS and REST.
- UserSettingsManager: integrate the existing REST-based `UserSettings` store with active sessions to forward live updates to Apps.

Scope: Cloud-only changes. No SDK changes required for this phase.

Non-goals:

- No migration from deprecated `User.augmentosSettings`.
- Do not persist legacy WS MentraOS settings into `UserSettings`.
- No new SDK APIs (e.g., `session.calendar`) in this phase.
- No changes to AppSettings (per-app settings).

Terminology:

- “Apps” refers to third-party App backends connected via the App WebSocket (TPAs).
- “Client” refers to a mobile or user-facing client (RN/Expo) calling our REST endpoints.
- “Glasses” refers to the device-originated WS connection handled by `websocket-glasses.service.ts`.
- “Session” refers to `UserSession` (one active per user).

---

1. Current State (Summary)

1.1 Calendar (legacy WS)

- Glasses → Cloud (WS): Glasses send `CalendarEvent`.
- Cloud:
  - `websocket-glasses.service.ts` caches event (currently in `SubscriptionManager`) and relays to Apps via Cloud→App `DATA_STREAM` with `streamType=calendar_event`.
- Apps:
  - Subscribe to `StreamType.CALENDAR_EVENT`.
  - On first-time subscription during a session, Cloud replays cached calendar events.

Limitations:

- Calendar cache lives in `SubscriptionManager` (cross-cutting, not ideal domain ownership).
- New clients want a REST-first path for sending calendar events.

  1.2 Calendar (new REST path, partial)

- `POST /api/client/user/calendar` exists but does not yet call a session manager; it just echoes the payload.

  1.3 User Settings (new REST path)

- Canonical model: `UserSettings` (`user-settings.model.ts`) persists generic client-defined settings under `settings` map.
- APIs exist at `/api/client/user/settings/*` for CRUD.
- Missing: wiring to active sessions to forward changes live to Apps (no SDK changes are required for now; we can use existing Cloud→App message types).

  1.4 Legacy WS settings (MentraOS)

- WS handlers in `websocket-glasses.service.ts` process old MentraOS settings traffic.
- We will NOT persist these into `UserSettings`; we will still forward them to Apps for back-compat.

---

2. Target Architecture (E2E Overview)

2.1 Session-scoped managers

- Attach both managers to `UserSession`:
  - `userSession.calendarManager`
  - `userSession.userSettingsManager`

    2.2 CalendarManager (session-scoped)

- Ingest from both sources:
  - Glasses WS `CALENDAR_EVENT` (legacy supported).
  - Client REST POST `/api/client/user/calendar` (Expo Calendar Event).
- Normalize to SDK `CalendarEvent` shape.
- Cache recent events in-memory (session-scoped) for replay to newly-subscribed Apps.
- Forward events to Apps via the existing path:
  - Cloud→App `DATA_STREAM` with `streamType=calendar_event`.
- Back-compat maintained without SDK changes.

  2.3 UserSettingsManager (session-scoped)

- Persist settings via existing REST endpoints (`user-settings.api.ts` remains source of truth).
- On successful REST update:
  - Persist to `UserSettings`.
  - Special-case bridge: if `metric_system_enabled` is present, map to legacy `metricSystemEnabled` and broadcast a legacy `"augmentos_settings_update"` to Apps (maintains backward compatibility without SDK changes).
- Do NOT persist legacy WS MentraOS settings to `UserSettings`.
- Continue forwarding the legacy WS MentraOS settings to Apps as-is for backwards compatibility. This path remains separate and unchanged.

---

3. Responsibilities and APIs

3.1 CalendarManager

Primary responsibilities:

- Normalize events:
  - Expo Calendar → SDK `CalendarEvent`.
  - Verify minimum fields and coerce to expected types.
- Caching:
  - Maintain a bounded, in-memory per-session cache for replay with a max of 100 events.
  - Ordering policy: prioritize present/future events first; within future events, sort by soonest start time; fall back to most recent past events if needed.
  - Optional TTL can be added later (e.g., 30–60 minutes) if memory pressure or staleness arises.
  - Optional dedup by `eventId` within the cache window to avoid immediate duplicates.
- Broadcasting:
  - Use `userSession.relayMessageToApps(normalizedEvent)` to target subscribed Apps (`StreamType.CALENDAR_EVENT`).
- Replay:
  - Provide `getCachedEvents()` for `websocket-app.service.ts` to send to an App when it first subscribes to `calendar_event`.

Proposed methods (internal design):

- `updateFromClient(expoEvent: any): Promise<void>`
  - Validate + normalize to SDK `CalendarEvent`.
  - Cache and broadcast to subscribed Apps.
- `ingestFromGlasses(event: CalendarEvent): void`
  - Assume event is already SDK-shaped or normalize if necessary.
  - Cache and broadcast.
- `getCachedEvents(): CalendarEvent[]`
  - Return a snapshot of the cache for replay.
- `clearCache(): void`
  - Clear cache when the session is disposed.

    3.2 UserSettingsManager

Primary responsibilities:

- Runtime access to the canonical `UserSettings` document for the active user.
- Track successful REST updates (already persisted) to maintain a session snapshot; no live forwarding in this phase.
- Do not write legacy WS MentraOS settings into `UserSettings`.
- Keep WS legacy forwarding intact (no behavior change) in `websocket-glasses.service.ts` for back-compat.

Proposed methods (internal design):

- `load(): Promise<Record<string, any>>`
  - Fetch (or lazily fetch) current `UserSettings` for the user and cache in session memory for quick diffs.
- `onSettingsUpdatedViaRest(updated: Record<string, any>): void`
  - Compute diffs vs. last known snapshot and update the snapshot (no live broadcast in this phase).
- `getSnapshot(): Record<string, any>`
  - Returns the last known snapshot (useful for debug/logging).
- `dispose(): void`
  - Clear any state on session disposal.

---

4. Data Shapes and Normalization

4.1 Calendar (Expo → SDK)

- Expo input (representative subset):
  - `id` (string)
  - `title` (string)
  - `startDate` (ISO)
  - `endDate` (ISO)
  - `timeZone` (string)
- SDK `CalendarEvent` for App streams:
  - `type: "calendar_event"`
  - `eventId: string`
  - `title: string`
  - `dtStart: string` (ISO)
  - `dtEnd: string` (ISO)
  - `timezone: string`
  - `timeStamp: string` (ISO; use `new Date().toISOString()` if not provided)
- Cache policy (session-scoped):
  - Max 100 events
  - Prioritize present/future events first; sort by soonest start time
  - Evict oldest items when the cap is reached

    4.2 UserSettings

- Client-defined keys under `UserSettings.settings` (map).
- Values are arbitrary JSON-compatible types.
- No special key prefixes; the manager knows nothing about “augmentos” keys in this phase.

---

5. Message Contracts (Cloud→App)

5.1 Calendar events (unchanged)

- Envelope:
  - `type: "data_stream"`
  - `streamType: "calendar_event"`
  - `data: CalendarEvent` (as above)
- Trigger paths:
  - Direct broadcast on WS calendar event ingest (legacy).
  - Direct broadcast on REST calendar update ingest (new).
  - Replay of cached events when an App newly subscribes to `calendar_event`.

    5.2 User settings updates (bridge for metric system)

- Special-case bridge: when REST user settings include the key `metric_system_enabled`, map and broadcast to legacy Apps using the existing AugmentOS settings update event:
  - New key → old legacy key: `metric_system_enabled` (boolean) → `metricSystemEnabled` (boolean)
  - Broadcast shape: send the existing `"augmentos_settings_update"` event with `settings: { metricSystemEnabled: <boolean> }` so legacy Apps and the SDK continue to react without changes.
- No other user-settings keys are broadcast in this phase (only `metric_system_enabled`).
- `default_wearable`: do not broadcast a legacy event in this phase. Historically this was implied by `GLASSES_CONNECTION_STATE`. See Open Questions for handling and implications (capabilities, PostHog, currentGlassesModel).
- Apps that need broader user-settings should fetch via REST; a dedicated Cloud→App message type and SDK support will follow in a later phase.

---

6. Wiring and Touch Points (Cloud)

6.1 New files

- `services/session/CalendarManager.ts`
- `services/session/UserSettingsManager.ts`

  6.2 UserSession

- Add fields:
  - `public readonly calendarManager: CalendarManager`
  - `public readonly userSettingsManager: UserSettingsManager`
- Initialize in the `UserSession` constructor (after logger is available).
- Ensure `dispose()` calls managers’ disposal where needed.

  6.3 websocket-glasses.service.ts (Calendar)

- In `handleGlassesMessage` switch-case:
  - For `CALENDAR_EVENT`: replace cache+relay logic with `userSession.calendarManager.ingestFromGlasses(message as CalendarEvent)`.
- No behavior change for App broadcast shape or subscription gating.

  6.4 websocket-app.service.ts (Calendar replay)

- In `handleSubscriptionUpdate`:
  - When `isNewCalendarSubscription` is true:
    - Replace calls to `subscriptionManager.getAllCalendarEvents()` with `userSession.calendarManager.getCachedEvents()`.

    6.5 api/client/calendar.api.ts

- Mount under `/api/client/calendar` in `api/index.ts`.
- In handler:
  - Validate body contains `calendar`.
  - Call `userSession.calendarManager.updateFromClient(calendar)`; return `{ success: true }` with minimal echo.

    6.6 api/client/user-settings.api.ts

- After successful persistence of settings:
  - If an active `UserSession` exists for the email, invoke:
    - `userSession.userSettingsManager.onSettingsUpdatedViaRest(updatedSettingsSubset)`
      - The manager updates the in-session snapshot.
      - If `updatedSettingsSubset` contains `metric_system_enabled`, it will bridge and broadcast a legacy `"augmentos_settings_update"` with `{ metricSystemEnabled: boolean }` to subscribed Apps (backward-compatible path).
      - It does NOT write anything to the deprecated `User.augmentosSettings`.

    6.7 SubscriptionManager

- Deprecate and remove calendar event cache from here after the new manager is wired.
- For a short transition, you may keep a shim that delegates to `CalendarManager` to avoid churn; goal is to fully remove calendar caching from `SubscriptionManager`.

---

7. Backward Compatibility

- Calendar:
  - Legacy WS calendar messages continue to work.
  - Apps continue receiving `data_stream` with `streamType="calendar_event"`; no SDK changes required.
  - Cached replay behavior is preserved.

- User settings:
  - Legacy WS MentraOS settings continue to be forwarded to Apps along their existing path.
  - We do not write legacy WS settings to `UserSettings`.
  - REST-based user settings are live-forwarded only for the special-case bridge:
    - `metric_system_enabled` → broadcast legacy `"augmentos_settings_update"` with `{ metricSystemEnabled }`.
    - All other user-settings keys are not broadcast in this phase; Apps can fetch via REST. A dedicated Cloud→App message type will be introduced in a future phase.

- No changes to ACK payload shape (avoids SDK changes).

---

8. Security, Validation, and Limits

- Auth:
  - `POST /api/client/user/calendar`: requires client JWT + active UserSession (ensures we know which session to broadcast into).
  - `user-settings.api.ts`: existing auth with email remains; forwarding to Apps only occurs when an active session exists.

- Permissions:
  - Calendar broadcast is guarded by App subscriptions to `StreamType.CALENDAR_EVENT` (enforced elsewhere).
  - User settings updates via `custom_message` are user-owned; we will broadcast to all running Apps for the user. If needed, future controls can restrict which Apps receive which keys.

- Validation:
  - Calendar: ensure required fields; coerce dates to ISO strings. Drop malformed payloads with clear logs.
  - User settings: trust persistence layer; only compute diffs and forward.

- Limits:
  - Calendar cache size: e.g., 20 items per session.
  - Optional TTL: can be introduced later if needed.
  - Optional dedup: by `eventId` within cache window.

---

9. Observability

- Structured logs:
  - Calendar ingest (source: WS/REST), normalized payload (redact if needed), broadcast count, replay count.
  - User settings diff size, keys changed, broadcast targets.

- Metrics (future):
  - Calendar events received per source.
  - User settings updates per minute; broadcast fan-out.

- Error handling:
  - Guard WS sends with try/catch; log failures per app.
  - Validation errors respond with 400 on REST.

---

10. Testing Plan

- Unit tests:
  - CalendarManager: normalization, caching bounds, replay order, dedup (if implemented).
  - UserSettingsManager: diff computation, `custom_message` payload shape.

- Integration tests:
  - WS calendar event → broadcast → App receives `calendar_event`.
  - REST calendar → broadcast → App receives `calendar_event`.
  - App newly subscribes to `calendar_event` → receives replayed cached events (ensure ordering policy is respected and cache size capped at 100).
  - REST user settings update with active session → if `metric_system_enabled` present, Apps receive legacy `"augmentos_settings_update"` with `{ metricSystemEnabled }`. Other keys: no broadcast.

- Manual QA:
  - Simulate client posting Expo event and verify App output.
  - Update user settings via REST and verify persistence; no live App notification in this phase.

---

11. Open Questions (added)

- `default_wearable` mapping:
  - Historically, “default wearable” changes were implied via `GLASSES_CONNECTION_STATE` messages from old clients, which also drove capabilities updates and PostHog tracking.
  - New clients will only change `default_wearable` via REST and won’t send `GLASSES_CONNECTION_STATE`. We need to decide:
    - Whether changing `default_wearable` via REST should trigger a synthetic capabilities update and/or tracking events (and what the source of truth is for model capability selection).
    - Whether to broadcast any legacy event for `default_wearable`, or keep it REST-only and rely on separate capability updates.
- Calendar payload content and sorting:
  - Confirm from mobile/frontend what subset of events they will send and any additional fields needed for sorting/prioritization.

---

11. Rollout

Phase A: Calendar

- Implement `CalendarManager`, wire WS/REST and replay.
- Remove calendar cache from `SubscriptionManager`.
- Validate in staging.

Phase B: User Settings

- Implement `UserSettingsManager`, wire `user-settings.api.ts` to:
  - Update session snapshot on REST updates.
  - If `metric_system_enabled` is present, bridge to legacy and broadcast `"augmentos_settings_update"` with `{ metricSystemEnabled }` (only this key in this phase).
- Keep legacy WS MentraOS settings forwarding unchanged.
- Validate in staging.

---

12. Future Work (Post-Phase)

- Calendar replay deprecation: In a future SDK update, introduce an SDK-side Calendar manager (e.g., `session.calendar`) to remove the need for Cloud-side session replay. Apps would fetch and track calendar state directly; Cloud would only deliver notifications for actual changes.

- SDK:
  - Add optional `session.calendar` helpers (e.g., subscribe to calendar on the App SDK side, or REST ingestion helpers).
  - Add first-class user settings module on SDK side for easy consumption (live updates + REST fetch).

- Cloud:
  - Consider adding a snapshot endpoint for Apps to fetch current user settings in one call.
  - Consider per-App filtering or permissioning for user settings payloads if key sensitivity arises.
  - Consider delivering user settings snapshot in the App connection ACK in a later SDK version.

---

Appendix: Example Messages

A. Calendar broadcast (unchanged)

- Cloud→App:
  {
  "type": "data_stream",
  "streamType": "calendar_event",
  "data": {
  "type": "calendar_event",
  "eventId": "abcd-123",
  "title": "Demo",
  "dtStart": "2025-01-01T10:00:00.000Z",
  "dtEnd": "2025-01-01T11:00:00.000Z",
  "timezone": "America/Los_Angeles",
  "timeStamp": "2025-01-01T09:55:00.000Z"
  },
  "timestamp": "2025-01-01T09:55:00.000Z"
  }

B. User settings bridging (special-case)

- Bridge mapping for backward compatibility:
  - New REST key → legacy AugmentOS key: `metric_system_enabled` (boolean) → `metricSystemEnabled` (boolean)
  - Broadcast event: `"augmentos_settings_update"` with `settings: { metricSystemEnabled }`
- No other user-settings keys are broadcast in this phase.
