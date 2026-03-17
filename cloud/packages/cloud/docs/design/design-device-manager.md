# DeviceManager Design

This document proposes a dedicated `DeviceManager` for session-scoped device state and capabilities. It centralizes logic currently spread across `UserSession` and WebSocket handlers, and introduces a clear path to integrate REST-based updates (e.g., `default_wearable`) with device model and capability handling.

Goals

- Centralize device state and capability management behind a single session-scoped manager.
- Ensure updates to `default_wearable` immediately update `currentGlassesModel` and capabilities.
- Keep backward compatibility: Apps still receive `CAPABILITIES_UPDATE`, and incompatible Apps are stopped when capabilities change.
- Preserve legacy WS flows (GLASSES_CONNECTION_STATE), but move logic out of `websocket-glasses.service.ts` into DeviceManager.
- Provide a clear API for other managers/services to consume device state (e.g., capabilities, model).
- Preserve `User.glassesModels` historical tracking and all existing PostHog analytics semantics for connection events and first-time model connections.

Non-goals (for this phase)

- SDK changes (e.g., new SDK device APIs) — not in scope now.
- Data model changes beyond what’s needed to coordinate capabilities and analytics.
- Changing how capabilities are derived for existing models (use the same capability profiles).

---

1. Current State (Summary)

Where device-related logic lives today:

- `UserSession`:
  - State: `currentGlassesModel`, `capabilities`, `glassesConnected` (deprecated), `glassesModel` (deprecated), `lastGlassesStatusUpdate`.
  - Methods: `updateGlassesModel`, `sendCapabilitiesUpdateToApps`, `stopIncompatibleApps`, `getCapabilities`, `hasCapability`.
- `websocket-glasses.service.ts`:
  - Handles `GLASSES_CONNECTION_STATE`.
  - Updates `UserSession.glassesConnected`, `glassesModel`, and calls `userSession.updateGlassesModel(modelName)` when connected.
  - Tracks with PostHog (person properties and events), and updates `User.glassesModels` array (first-time per model).
- Capability profiles:
  - `config/hardware-capabilities.ts` and model-specific modules (e.g., `mentra-live.ts`) provide a lookup via `getCapabilitiesForModel(modelName)`.
- App initialization:
  - `AppManager.handleAppInit` includes `capabilities: userSession.getCapabilities()` in the connection ACK to Apps.

Pain points:

- Device model and capability logic is fragmented across `UserSession` and the WS service.
- There is no central API to set the “logical” device model based on user preference (e.g., `default_wearable`), even when no physical glasses are connected.
- Analytics and downstream side-effects (PostHog + `User.glassesModels`) are intertwined with WS handling code.

---

2. Key Concepts and State

- `currentGlassesModel: string | null`
  - The active or logical model name for the session (e.g., "Mentra Live", "Even Realities G1").
  - Determines which capability profile applies to Apps.
- `capabilities: Capabilities | null`
  - The capability profile in effect (driven by `currentGlassesModel`).
- `glassesConnected: boolean` (deprecated)
  - Deprecated and not a reliable source of truth. This mutable field should be ignored by new code and removed in a follow-up refactor. DeviceManager derives effective model/capabilities from authoritative events (e.g., `GLASSES_CONNECTION_STATE`) and user preference (`default_wearable`) without exposing global mutable flags.
- `default_wearable: string` (new system setting, from REST)
  - Client-defined preference. Updating this SHOULD update `currentGlassesModel` and `capabilities` immediately (per product direction), regardless of deprecated `glassesConnected`/`phoneConnected` flags. It also ensures `User.glassesModels` includes the model (append once per unique) and updates PostHog person properties; additionally emit a dedicated `preference_model_changed` analytics event. It does not toggle deprecated connection flags.
- Capability profiles
  - Derived from `getCapabilitiesForModel(modelName)`, with fallback behavior when model is unknown.

---

3. Events and Triggers

Inbound sources that should update device state:

A) Legacy WS (Glasses)

- `GLASSES_CONNECTION_STATE`:
  - When status becomes `CONNECTED` and provides `modelName`:
    - Update `glassesConnected = true`.
    - Set `currentGlassesModel = modelName`.
    - Refresh `capabilities`.
    - Notify Apps (`CAPABILITIES_UPDATE`) and stop incompatible Apps.
    - PostHog updates (person properties, possibly first-connect event).
  - When status becomes `DISCONNECTED`:
    - Update `glassesConnected = false`.
    - Do NOT automatically change `currentGlassesModel` unless product decides otherwise.
    - PostHog updates to reflect disconnection.

B) New REST (Client)

- `default_wearable` (User Settings, REST):
  - On update, DeviceManager should:
    - Set `currentGlassesModel = default_wearable` and refresh `capabilities` immediately.
    - Notify Apps (`CAPABILITIES_UPDATE`) and stop incompatible Apps.
  - Note: This can differ from the physical device connection state (e.g., none connected). The capability profile still gates App features and compatibility from the session’s perspective.

C) Other sources

- `CORE_STATUS_UPDATE` or other messages may include model hints (if any). For now, these should flow through the same update APIs if used.

---

4. Responsibilities of DeviceManager

- State ownership:
  - Holds and exposes session-scoped device state (`currentGlassesModel`, `glassesConnected`, `capabilities`, timestamps).
- Model updates:
  - Set or update `currentGlassesModel` (from WS or `default_wearable`).
  - Refresh `capabilities` via capability profiles.
- App notifications and enforcement:
  - Send `CAPABILITIES_UPDATE` to all running Apps when capabilities change.
  - Stop Apps that are incompatible with the new capabilities (delegates to AppManager).
- Analytics (PostHog):
  - Track connection events and model transitions.
  - Maintain person properties (e.g., `current_glasses_model`, `glasses_current_connected`, `glasses_models_used`, etc.).
- Manager coordination:
  - Notify `MicrophoneManager` on connection state changes (existing behavior).
- Persistence of known models (optional and existing):
  - Update `User.glassesModels` for historical tracking when new models connect (as is today).

---

5. Proposed Public API (Session-scoped)

Note: This is a design — signatures may be refined during implementation.

- `getCurrentModel(): string | null`
- `getCapabilities(): Capabilities | null`
- `getEffectiveModel(): string | null`
- `setDefaultWearable(modelName: string): Promise<void>`
  - Sets the logical model from the new user setting.
  - Refreshes capabilities; triggers `CAPABILITIES_UPDATE`; stops incompatible Apps.
  - Does NOT toggle deprecated `phoneConnected`/`glassesConnected` flags; updates `User.glassesModels` (append once per unique) and PostHog person properties; emits a `preference_model_changed` analytics event.
- `handleGlassesConnectionState(modelName: string | null, status: "CONNECTED" | "DISCONNECTED" | string): Promise<void>`
  - Updates `currentGlassesModel` when connected (ignore deprecated flags); recalculates capabilities.
  - Sends `CAPABILITIES_UPDATE` and stops incompatible Apps.
  - Preserves analytics and user history semantics:
    - Updates `User.glassesModels` (append once per unique model).
    - Emits PostHog person property updates (current model, models used/count, last connected, current connected true/false).
    - Emits “glasses_model_first_connect” event on first-time model connections.
- `refreshCapabilities(): void`
  - Re-derive `capabilities` from `currentGlassesModel`.
- `notifyCapabilitiesUpdateToApps(): void`
  - Sends `CloudToAppMessageType.CAPABILITIES_UPDATE` with the current `capabilities` and `modelName`.
- `stopIncompatibleApps(): Promise<void>`
  - Evaluates running Apps against `capabilities` and stops incompatible ones (delegates/coordinates with `AppManager`).
- `dispose(): void`
  - Cleanup if any (e.g., timers, listeners).

---

6. Data Flow: End-to-End

A) Legacy WS connection message (authoritative event source)

- Glasses → Cloud: `GLASSES_CONNECTION_STATE`
- WS service → DeviceManager: `handleGlassesConnectionState(modelName, status)` (do not mutate deprecated session flags; DeviceManager updates `currentGlassesModel` and recalculates capabilities internally)
- DeviceManager:
  - Updates state, refreshes capabilities
  - Notifies Apps via `CAPABILITIES_UPDATE`
  - Stops incompatible Apps
  - Updates PostHog and user model history

B) REST `default_wearable` update (authoritative user preference)

- Client → Cloud: `PUT/POST /api/client/user/settings` with `{ default_wearable: "<model>" }`
- UserSettingsManager detects the update and calls DeviceManager: `setDefaultWearable(modelName)`
- DeviceManager:
  - Updates `currentGlassesModel`, refreshes `capabilities`
  - Sends `CAPABILITIES_UPDATE` and stops incompatible Apps
  - Ignores deprecated `phoneConnected`/`glassesConnected` and `glassesModel` session fields (to be removed)
  - Updates `User.glassesModels` (append once per unique model) and PostHog person properties; emits a `preference_model_changed` analytics event (distinct from connection events).

C) Capabilities read

- Any component needing capabilities calls `DeviceManager.getCapabilities()` (or via `UserSession.getCapabilities()` as a shim during migration).
- `AppManager.handleAppInit` includes current capabilities in the App ACK unchanged.

---

7. Dependency Map

Sources:

- `websocket-glasses.service.ts` (legacy WS)
- `UserSettingsManager` (REST user settings bridge)

Consumers:

- `AppManager.handleAppInit`: reads capabilities
- `UserSession.sendCapabilitiesUpdateToApps` (will be internalized by the manager)
- `UserSession.stopIncompatibleApps` (delegated to manager)
- `MicrophoneManager`: receives connection state changes (DeviceManager delegates to it)

Downstream side effects:

- `CloudToAppMessageType.CAPABILITIES_UPDATE` broadcasts to Apps
- PostHog analytics and person properties (preserve existing semantics for connection events)
- User model `glassesModels` history (append once-per-unique model on physical connection only)

Capability definitions:

- `config/hardware-capabilities.ts` and model-specific capability files.

---

8. Backward Compatibility and Deprecations

- Apps:
  - Continue receiving `CAPABILITIES_UPDATE` when capabilities change.
  - Continue receiving capabilities in the connection ACK.
- Legacy WS:
  - `GLASSES_CONNECTION_STATE` still processed; only the implementation moves into DeviceManager. Deprecated session flags (`phoneConnected`, `glassesConnected`) and `glassesModel` are not used as sources of truth and will be removed.
  - Preserve `User.glassesModels` updates and PostHog tracking semantics exactly as today on connect/disconnect and first-time model connect.
- REST `default_wearable`:
  - New behavior: immediately updates session model/capabilities and notifies Apps, without requiring WS events.
  - Updates `User.glassesModels` (append once per unique) and PostHog person properties; emits a `preference_model_changed` analytics event; does not toggle deprecated connection flags or emit connection/disconnection events.

---

9. Refactor Plan (Phased)

Phase 1: Introduce DeviceManager (no behavior changes yet; mark deprecated flags)

- Add `DeviceManager` to `UserSession` (as `userSession.deviceManager`).
- Implement methods and internally call existing `UserSession` helpers (e.g., temporarily call `userSession.sendCapabilitiesUpdateToApps()` and `userSession.stopIncompatibleApps()` until those are moved inside).
- Keep all existing code paths working. Explicitly annotate `phoneConnected`, `glassesConnected`, and `glassesModel` as deprecated and non-authoritative.

Phase 2: Migrate WS handling to DeviceManager (eliminate reliance on deprecated flags)

- In `websocket-glasses.service.ts`, replace direct state manipulation with calls to:
  - `deviceManager.handleGlassesConnectionState(modelName, status)`
- Avoid setting or reading `phoneConnected`/`glassesConnected` and `glassesModel` in `UserSession`.
- Move PostHog + model history logic into DeviceManager.

Phase 3: Wire `default_wearable` updates (device model as preference)

- From `UserSettingsManager`, when `default_wearable` changes, call:
  - `deviceManager.setDefaultWearable(modelName)` (do not touch deprecated `phoneConnected`/`glassesConnected` flags)
- Ensure capabilities update and incompatible Apps stopping runs.

Phase 4: Consolidate methods (remove or shim deprecated fields)

- Move `sendCapabilitiesUpdateToApps`, `stopIncompatibleApps`, `getCapabilities`, `hasCapability`, `updateGlassesModel` fully into DeviceManager.
- Remove `phoneConnected`, `glassesConnected`, and `glassesModel` from `UserSession` (or keep shims strictly for telemetry until fully removed).
- Deprecate/shim `UserSession` methods to call into DeviceManager.

Phase 5: Cleanup (remove deprecated fields)

- Remove duplicated state from `UserSession` (deprecated: `phoneConnected`, `glassesConnected`, `glassesModel`).
- Update tests and documentation to use DeviceManager as the sole source of truth for model/capabilities.

---

10. Precedence Rules (Proposed)

The following precedence is recommended to avoid confusion:

- When `glassesConnected === true`, the connected physical device model (from WS) defines `currentGlassesModel` and capabilities.
- When `glassesConnected === false`, the `default_wearable` defines `currentGlassesModel` and capabilities.
- If product direction explicitly requires `default_wearable` to override even when connected, note that Apps will see capability changes mid-connection that may not reflect physical hardware; this can break camera/display features. Confirm before implementing this override.

Note: The product guidance mentioned “changing default_wearable should update currentGlassesModel and capabilities immediately.” The above approach satisfies that when no device is connected. If we must override even when connected, we should:

- Broadcast a separate “preference changed” event to differentiate it from a physical device change (optional).
- Document risks to Apps (capability mismatches to actual hardware).
- Consider an “effectiveModel = connectedModel || defaultWearable” rule and a separate “preferredModel” field.

---

11. Testing & Observability

Tests

- Unit tests:
  - `setDefaultWearable` updates model/capabilities and triggers notifications/stops incompatible Apps.
  - `handleGlassesConnectionState` updates connection, model, capabilities, and analytics.
  - Precedence rules (connected vs not connected).
- Integration tests:
  - WS `GLASSES_CONNECTION_STATE` → Apps receive `CAPABILITIES_UPDATE`.
  - REST update `default_wearable` with/without a physical connection → Apps receive `CAPABILITIES_UPDATE`.

Logging & Metrics

- Structured logs on model changes, capability refresh, broadcast counts, stopped Apps.
- PostHog events: first-time model connect; current model changes; connect/disconnect timestamps.

---

12. Open Questions

- Precedence when a physical device is connected:
  - Should `default_wearable` override the connected model’s capabilities? (Recommended: No; use connected model when available.)
- Should capabilities differ between “logical” model and “connected” model?
  - If yes, define how Apps should react to mismatches.
- Should we emit analytics on `default_wearable` changes (separate from connection events)?
- Should the session expose both `preferredModel` (from user setting) and `effectiveModel` (connected or preferred)?
  - If so, what do we send in the App ACK and CAPABILITIES_UPDATE?

---

13. Summary

This `DeviceManager` consolidates device model and capability handling into a single session-scoped owner. It supports both legacy WS device events and new REST-based user settings (`default_wearable`) with immediate effects on `currentGlassesModel` and capabilities. It keeps App-facing behavior unchanged (capability updates and enforcement), reduces fragmentation, and positions us for future SDK improvements without regressions.
