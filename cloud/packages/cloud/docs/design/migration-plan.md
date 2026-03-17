# Migration Plan: Calendar and User Settings

## Overview

This document tracks the migration for:

- Calendar events: from the legacy WebSocket flow and ad-hoc caching to a session-scoped `CalendarManager`, with a REST-first client integration.
- User settings: from being only accessible via the new REST + `UserSettings` model to being integrated into the active `UserSession`, with live forwarding to Apps. We intentionally do NOT persist old WS settings into the new `UserSettings` store.

The goals:

- Preserve backward compatibility for Apps and legacy clients.
- Provide a clean, session-scoped ownership model (managers) and REST-first flows.
- Make developer-facing behavior and SDK usage clear and consistent.

Non-goals:

- Migrating or reading from deprecated `User.augmentosSettings`.
- Changing App-facing stream types or breaking backward compatibility for current SDK consumers.
- Implementing AppSettings changes (per-app settings) in this phase.

---

## Table of Contents

1. Current Architecture (E2E)
   - 1.1 Calendar (legacy WS path)
   - 1.2 Calendar (new REST path, partial)
   - 1.3 User Settings (new REST path, partial)
   - 1.4 SDK usage (today)
2. Target Architecture (E2E)
   - 2.1 CalendarManager (session-scoped)
   - 2.2 UserSettingsManager (session-scoped)
   - 2.3 SDK usage (target)
3. API Contracts (Client)
   - 3.1 Calendar endpoint
   - 3.2 User settings endpoints
4. Backward Compatibility
5. Rollout Plan
6. Observability & Validation
7. Risks & Mitigations
8. Open Questions
9. Appendix: Data shape mapping

---

## 1. Current Architecture (E2E)

### 1.1 Calendar (legacy WS path)

- Glasses send `CalendarEvent` over WebSocket to Cloud.
- Cloud:
  - `websocket-glasses.service.ts` receives the message.
  - Caches the event (currently in `SubscriptionManager`).
  - Relays the event to Apps subscribed to `StreamType.CALENDAR_EVENT` via Cloud→App `DATA_STREAM`.
- Apps:
  - Subscribe to `StreamType.CALENDAR_EVENT`.
  - Receive `CloudToAppMessageType.DATA_STREAM` with `streamType=calendar_event`.
- When an App newly subscribes to `calendar_event`, Cloud replays the cached events to that App.

Constraints/issues:

- Calendar caching lives in `SubscriptionManager` (not ideal for domain ownership).
- New clients want to POST calendar events via REST, not WS.

### 1.2 Calendar (new REST path, partial)

- `POST /api/client/user/calendar` exists but is not fully wired:
  - It authenticates with an active `UserSession`.
  - It currently echoes the payload; needs to call a session-scoped manager to normalize, cache, and forward to Apps.

### 1.3 User Settings (new REST path, partial)

- Canonical model exists: `UserSettings` (`user-settings.model.ts`), with generic key/value `settings` map per user (keys decided by the client).
- `user-settings.api.ts` supports CRUD over HTTP (GET, PUT/POST, GET key, PUT key, DELETE key).
- Missing piece: forwarding updates to Apps (live updates) via the session once persisted.

Important constraints:

- We will NOT persist old settings from WS into `UserSettings`.
- We will still forward legacy WS settings to Apps (for now) for backward compatibility.
- No fallback to `User.augmentosSettings`. The client seeds defaults into `UserSettings`.

### 1.4 SDK usage (today)

- Calendar:
  - Apps call `session.subscribe(StreamType.CALENDAR_EVENT)`.
  - Apps handle events via `session.on(StreamType.CALENDAR_EVENT, handler)`.
- System (MentraOS) settings:
  - SDK `SettingsManager` handles `"augmentos_settings_update"` messages and per-key events.
  - This is distinct from the new `UserSettings` REST model (client-defined keys). The live-forwarding for this new system will be introduced after CalendarManager.

---

## 2. Target Architecture (E2E)

### 2.1 CalendarManager (session-scoped)

- Ownership:
  - Attach `calendarManager` to `UserSession` (similar to audio/display/etc managers).
- Responsibilities:
  - Ingest events from both sources:
    - Legacy WS (`GlassesToCloudMessageType.CALENDAR_EVENT`): accept and normalize (if needed).
    - New REST (`/api/client/user/calendar`): accept Expo Calendar event, normalize to SDK `CalendarEvent`.
  - Broadcast to Apps:
    - Use the existing stream path (`CloudToAppMessageType.DATA_STREAM` with `streamType=calendar_event`).
  - Cache:
    - Maintain a session-scoped, bounded cache of recent events for replay to newly-subscribing Apps.
- Integration changes:
  - `websocket-glasses.service.ts`: delegate legacy `CALENDAR_EVENT` handling to `CalendarManager` (cache + broadcast).
  - `websocket-app.service.ts`: on new subscription to `calendar_event`, read from `CalendarManager.getCachedEvents()` and send to that App.
  - `api/client/calendar.api.ts`: call into `CalendarManager.updateFromClient(expoEvent)` (normalize/cache/broadcast).

Developer experience (SDK): no changes required for Apps

- Apps keep using `StreamType.CALENDAR_EVENT` and `session.on(...)` as they do today.

### 2.2 UserSettingsManager (session-scoped)

- Ownership:
  - Attach `userSettingsManager` to `UserSession`.
- Canonical store:
  - `UserSettings` (`user-settings.model.ts`) remains the canonical data store for user settings (client-defined keys).
- Responsibilities:
  - Serve current user settings to session-scoped consumers/managers.
  - When `user-settings.api.ts` updates keys:
    - Persist to `UserSettings`.
    - If a `UserSession` exists, compute changed keys and forward updates to Apps (live).
  - Legacy WS settings:
    - Do not persist into `UserSettings`.
    - Continue forwarding legacy WS settings to Apps for backward compatibility (no writes to the new store).
- Eventing to Apps:
  - We will forward updates to Apps via a dedicated message (TBD name and exact shape) that delivers changed keys and values.
  - This is separate from the existing MentraOS settings route used by the SDK’s `SettingsManager`. Keys and semantics are defined by the client.
  - Decisions to finalize (see Open Questions):
    - Event type name (e.g., `user_settings_update`).
    - Subscription mechanism (do Apps need to subscribe to a specific stream, or will updates always be delivered after App connection?).
- Developer experience (SDK):
  - Provide a helper in the SDK (post-Calendar) for Apps to:
    - Fetch current user settings via REST (optional).
    - Subscribe to and handle live updates for user settings (once event is defined).
    - Minimal boilerplate to react to setting changes.

### 2.3 SDK usage (target)

- Calendar: unchanged (subscribe + on event).
- User settings:
  - REST: clients and/or Apps can fetch current values from `/api/client/user/settings`.
  - Live updates: Apps will handle update events (TBD event name) to receive changes in real time.
  - No use of deprecated `User.augmentosSettings`. No fallback or migration.

---

## 3. API Contracts (Client)

### 3.1 Calendar endpoint

Base path: `/api/client/user/calendar`

- POST `/`
  - Auth: Client JWT with an active `UserSession`.
  - Body:
    - `calendar` object shaped like Expo Calendar Event (see mapping appendix).
  - Behavior:
    - Validates payload minimally.
    - Calls `UserSession.calendarManager.updateFromClient(...)`.
    - Normalizes to SDK `CalendarEvent`, caches, and broadcasts to subscribed Apps.
  - Response:
    - `{ success: true, data: { calendar: <normalized or original> }, timestamp: <iso> }`

Notes:

- This does not persist calendar events server-side beyond the in-memory session cache for replay.
- Idempotency/dedup and TTL/size limits can be added by the manager.

### 3.2 User settings endpoints

Base path: `/api/client/user/settings`

- GET `/`
  - Returns full `UserSettings.settings` for the authenticated user.
- PUT `/` or POST `/`
  - Accepts a partial map of keys → values.
  - Persists to `UserSettings` (create-on-demand).
  - If a `UserSession` exists, the session manager will forward changed keys to Apps (live event; TBD name).
- GET `/key/:key`
  - Returns a single setting value or `null` if not set.
- PUT `/key/:key`
  - Sets a single key to a value.
- DELETE `/key/:key`
  - Deletes a single key.

Notes:

- Keys are client-defined; server treats them as opaque.
- No persistence of legacy WS settings into this store.

---

## 4. Backward Compatibility

- Calendar:
  - Legacy WS `CALENDAR_EVENT` continues to work; Apps keep receiving `calendar_event` streams with the same shape.
  - New REST path adds a way for mobile clients to send events via HTTP without breaking existing behavior.

- User settings:
  - Legacy WS settings are still forwarded to Apps (so existing SDK “mentraos” flows remain functional where needed).
  - We do not write legacy WS settings to `UserSettings`.
  - The new user settings system is independent; Apps will receive live updates via a new event (TBD) once wired, and can fetch current values via REST.

- No migration or fallback:
  - No use of `User.augmentosSettings` for reads/writes.
  - The client seeds defaults into `UserSettings`.

---

## 5. Rollout Plan

Phase 1: Calendar

1. Implement `CalendarManager` and attach to `UserSession`.
2. Wire WS glasses handler to delegate to `CalendarManager`.
3. Wire App WS subscription replay to `CalendarManager.getCachedEvents()`.
4. Wire `calendar.api.ts` to call `CalendarManager.updateFromClient(...)`.
5. Mount `calendar.api.ts` under `/api/client/user/calendar`.
6. Monitor logs and behavior in staging; verify SDK Apps continue receiving `calendar_event` streams from both sources.

Phase 2: User Settings

1. Implement `UserSettingsManager` and attach to `UserSession`.
2. Keep `user-settings.api.ts` persistence as-is; after success, if a `UserSession` exists, compute diffs and forward live updates to Apps.
3. Define and implement the App-facing update event (TBD name/shape) and any subscription semantics required.
4. Add SDK helper(s) to consume user settings updates (and optional REST fetch).
5. Validate end-to-end in staging; ensure no writes to deprecated `User.augmentosSettings`.

---

## 6. Observability & Validation

- Structured logs at each hop:
  - Calendar: receipt (REST/WS), normalization, broadcast count, replay count.
  - User settings: REST updates (keys), computed diffs, broadcast targets.
- Metrics:
  - Count of calendar events received via WS vs. REST.
  - User settings updates per minute and broadcast fan-out.
- Error tracking:
  - Validation failures, WS send errors, cache overflows.
- Test harnesses:
  - Simulate App subscriptions and verify that cached/replayed calendar events and user settings updates arrive as expected.

---

## 7. Risks & Mitigations

- Risk: Duplicate calendar events when both WS and REST fire for the same user.
  - Mitigation: Optional dedup by `eventId` or time window in `CalendarManager`.
- Risk: Excessive memory for calendar cache.
  - Mitigation: Bound the cache by size and/or TTL.
- Risk: Unclear event contract for user settings live updates.
  - Mitigation: Document and finalize the event name and payload shape before Phase 2 implementation.

---

## 8. Open Questions

- User settings live event:
  - Event type name and payload shape (proposed: `user_settings_update` with `{ changed: Record<string, any> }`).
  - Do Apps need to subscribe to a specific stream for user settings updates, or should updates be delivered to all connected Apps (or those that opt-in)?
- Should calendar REST endpoint normalize and return the SDK-shaped `CalendarEvent` in the response (for debugging), or just echo the raw input?
- Cache policy for calendar replay (size limit, TTL, eviction strategy).

---

## 9. Appendix: Data shape mapping

### A. Calendar event mapping (Expo → SDK)

Input (from Expo, posted by client to REST):

- `calendar.id` → `eventId`
- `calendar.title` → `title`
- `calendar.startDate` → `dtStart` (ISO)
- `calendar.endDate` → `dtEnd` (ISO)
- `calendar.timeZone` → `timezone`
- `now()` (or provided createdAt) → `timeStamp`

Output to Apps:

- CloudToApp `DATA_STREAM` with `streamType="calendar_event"` and `data`:
  - `{ type: "calendar_event", eventId, title, dtStart, dtEnd, timezone, timeStamp }`

### B. User settings (client-defined keys)

- Canonical store: `UserSettings.settings` (map of string → any).
- REST read/write interfaces already exist.
- Live updates to Apps will deliver only changed keys (diff), event name/shape TBD.

---

End of document.
