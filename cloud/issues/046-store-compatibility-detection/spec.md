# Spec: Store Compatibility Detection

## Overview

**What this doc covers:** How the store API resolves a user's device capabilities when checking app compatibility.
**Why this doc exists:** Compatibility checks were broken for the internal dev team (and any user whose store and glasses session are on different backend instances) because we were checking in-memory `UserSession` only — which doesn't exist cross-backend.
**What you need to know first:** See PR #2212 (`fix-store-compatibility` branch) for the initial fix that shipped.
**Who should read this:** Cloud engineers touching the store API or device session model.

## The Problem in 30 Seconds

The store calls `UserSession.getById(email)` to get capabilities for compatibility checks. `UserSession` is in-memory and backend-scoped. A user on dev backend whose `UserSession` lives on `dev` is invisible to `prod` backend — so the prod store sees no session, returns `compatibility: null`, and the store UI shows every app as installable regardless of hardware.

This is mostly an internal problem (devs switching backends), but it reveals a structural issue: **we have two independent sources of truth for the device model that can diverge.**

```
WS glasses_connection_state ──→ DeviceManager.deviceState.modelName  (in-memory only)
REST device-state ─────────────→ DeviceManager.deviceState.modelName  (in-memory only)
REST user/settings (pairing) ──→ UserSettings.default_wearable (DB) + session via onSettingsUpdatedViaRest
```

The DB `default_wearable` is only written when mobile explicitly saves a setting (pairing flow, device change in UI). The WS and device-state REST paths update the session in-memory but never touch the DB. So a user whose mobile has the model in local settings — and sends it via WS — may not have it persisted in DB if the explicit settings sync never ran.

## Spec

### `resolveDeviceInfo(email)` — two-phase lookup

Replace the single-source lookup with a prioritized fallback chain:

**Phase 1 — Live session (same backend)**

```
userSession = UserSession.getById(email)
if userSession exists:
    model = userSession.deviceManager.getModel()
    capabilities = userSession.getCapabilities()
    if model && capabilities:
        return { capabilities, deviceName: model, isConnected: userSession.deviceManager.isGlassesConnected }
```

Use the session when it's there — it reflects the most current state (WS connection, device-state REST, or settings update). The WS `glasses_connection_state` and `POST /device/state` both write to the in-memory session but not DB, so session-first is the only way to catch those.

**Phase 2 — Persisted DB preference (cross-backend fallback)**

```
defaultWearable = UserSettingsService.getUserSetting(email, "default_wearable")
if defaultWearable (string):
    capabilities = getCapabilitiesForModel(defaultWearable)
    if capabilities:
        return { capabilities, deviceName: defaultWearable, isConnected: false }
```

The `isConnected` flag is `false` here because if we're falling back to DB it means there's no live session on this backend — so glasses are not connected from this backend's perspective.

**Phase 3 — No data**

```
return { capabilities: null, deviceName: null, isConnected: false }
```

### `isConnected` semantics

`isConnected` always comes from the live session (`deviceManager.isGlassesConnected`). If there's no session on this backend, it's `false` — even if the DB fallback gives us a model. This is correct: we know _what device they use_, but not whether it's currently connected from this backend's vantage point.

### Where this applies

All three store handlers that call `resolveDeviceInfo`:

- `getPublishedAppsForUser`
- `getAppDetails`
- `searchApps`

No change to the handler logic — they already gate on `if (capabilities)` before using the result.

## Decision Log

| Decision                                    | Alternatives considered                                   | Why we chose this                                                                                                                                                     |
| ------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session first, DB fallback                  | DB first (PR #2212 as shipped), session first no fallback | Session-first catches the case where model is set via WS/device-state but was never written to DB. DB fallback catches the cross-backend case. Both sources needed.   |
| Session first (not DB first)                | DB first                                                  | The session can be set via `glasses_connection_state` WS or `POST /device/state` REST — neither writes to DB. Session-first is the only way to capture those updates. |
| `isConnected: false` when using DB fallback | Derive from DB `glasses_current_connected` PostHog field  | `isConnected` is live WS state. If we're on the DB fallback path, there's no live session — `false` is accurate. Don't mix live state with historical DB state.       |
| No session fallback when DB lookup fails    | Try session as secondary fallback if DB is empty          | Keep it simple: one pass through both sources in priority order. If session had no model, falling back to it after DB also has nothing gains nothing.                 |
