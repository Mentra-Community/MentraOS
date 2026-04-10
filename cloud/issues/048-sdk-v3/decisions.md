# SDK v3 — Decisions Log

**Issue:** 048
**Status:** Living document — updated as decisions are made
**Last updated:** 2026-03-19

---

## Purpose

Single source of truth for every SDK v3 decision. When someone asks "why is it called X?" or "why did we do Y?", the answer is here. Entries are chronological. Each decision has a short rationale so future readers understand the context without re-reading the full spike.

---

## Naming Decisions

### D-001: `MentraSession` is the per-user session class

**Decided:** 2026-03-17 (spike session)
**Rationale:** Replaces `AppSession`. "Mentra" prefix because this is the branded core experience — developers spend 95% of their time interacting with it. `Session` alone is too generic and could conflict with other libraries.

### D-002: `MiniAppServer` is the cloud/server host class (not `MentraApp`)

**Decided:** 2026-03-19 (implementation session)
**Rationale:** Originally named `MentraApp` in the spikes. Renamed to `MiniAppServer` because:

- It IS a server — it listens on a port, handles webhooks, serves static files.
- Avoids confusion when local apps arrive (v3.1+) — local apps don't need a server, so `MiniAppServer` makes it obvious it's cloud-only.
- Frees up `MentraApp` for a potential future unified config object that works for both cloud and local.
- `@mentra/sdk` package name already provides the brand context, so "Mentra" in every class name is redundant.
- The v2 class was `AppServer` — `MiniAppServer` is a natural evolution.

### D-003: `AppServer` is the v2 compat shim

**Decided:** 2026-03-17 (spike session)
**Rationale:** Existing v2 apps do `class MyApp extends AppServer`. The compat shim preserves this pattern by extending `MiniAppServer` (which itself extends the old `AppServer` during the transition period). Removed in v3.1.

### D-004: Internal classes use `_` prefix

**Decided:** 2026-03-19 (implementation session)
**Rationale:** The `_` prefix signals "this is private implementation, not public API." Developers on the team immediately know not to import or extend these. Same convention used by Node.js core and most TypeScript projects.

### D-005: Internal class naming convention — `_Purpose` + role suffix

**Decided:** 2026-03-19 (this conversation)
**Rationale:** The other agent used verbose names like `_MiniAppServerRuntime`, `_MiniAppServerCallbackBridge`, `_CompatMentraSessionAdapter`. These were confusing because:

- "Runtime" is overloaded (could mean JS runtime, not "session lifecycle orchestrator")
- "Bridge" doesn't say what it bridges
- "Adapter" is generic — doesn't say what it adapts from or to

New convention:

| Old name                       | New name                      | Role suffix                                                                 |
| ------------------------------ | ----------------------------- | --------------------------------------------------------------------------- |
| `_MiniAppServerRuntime`        | `_SessionManager`             | Manages the collection of sessions for the server                           |
| `_MiniAppServerCallbackBridge` | `_CallbackManager`            | Stores onSession/onStop/onToolCall handlers                                 |
| `_MentraSessionServerFactory`  | Merged into `_SessionManager` | Was only used by the manager — not worth a separate class                   |
| `_MiniAppSessionRegistry`      | Merged into `_SessionManager` | Two Maps with get/set/delete — not worth a separate class                   |
| `_SessionLifecycleManager`     | `_ConnectionManager`          | Manages one session's connection lifecycle (connect, reconnect, ping, park) |
| `_MessageRouter`               | `_MessageRouter`              | Unchanged — name was already clear                                          |
| `_SubscriptionManager`         | `_SubscriptionManager`        | Unchanged — name was already clear                                          |

### D-006: V2 compat shims use `_V2` prefix + `Shim` suffix

**Decided:** 2026-03-19 (this conversation)
**Rationale:** The other agent used `_Compat*Adapter` which was vague. `_V2` prefix instantly communicates "this is the old v2 interface." `Shim` suffix communicates "this is a translation layer that goes away."

| Old name                          | New name              |
| --------------------------------- | --------------------- |
| `_CompatMentraSessionAdapter`     | `_V2SessionShim`      |
| `_CompatEventManagerAdapter`      | `_V2EventManagerShim` |
| `_CompatCameraAdapter`            | `_V2CameraShim`       |
| `_CompatSettingsAdapter`          | `_V2SettingsShim`     |
| `_CompatAudioOutputStreamAdapter` | `_V2AudioStreamShim`  |

### D-007: Collapse factory + registry + manager into one `_SessionManager`

**Decided:** 2026-03-19 (this conversation)
**Rationale:** `_SessionFactory` (~50 lines), `_SessionRegistry` (~60 lines), and `_SessionManager` were three classes doing one job — the server needs to create, track, and tear down sessions. They were never used independently. One ~200-line class is clearer than three tiny classes with indirection between them. Split again only if it grows past 400 lines.

---

## Architecture Decisions

### D-010: `MentraSession` depends on `Transport`, not `ws`

**Decided:** 2026-03-17 (spike session)
**Rationale:** The session layer must run unchanged with `WebSocketTransport` (cloud), a future native bridge transport (local apps), or a mock (tests). This is the primary internal portability boundary. Only `WebSocketTransport.ts` imports `ws`.

### D-011: Message routing is registry-based, not conditional-chain

**Decided:** 2026-03-17 (spike session)
**Rationale:** The old `handleMessage()` was a 413-line if/else chain. The new `MessageHandlerRegistry` + `DataStreamRouter` provides O(1) lookup + multiple handlers per message type. Managers register their own handlers at construction time.

### D-012: Subscriptions are derived from handler registrations

**Decided:** 2026-03-17 (spike session)
**Rationale:** This is the Bug 007 fix made structural. If an app registers a handler requiring a stream, the SDK subscribes. If the last handler for a stream is removed, the SDK unsubscribes. The session never maintains an independent hand-edited subscription set that can drift. Managers call `addSubscription`/`removeSubscription` via the dependency bag.

### D-013: Managers are the primary subsystem boundary

**Decided:** 2026-03-17 (spike session)
**Rationale:** 14 managers (transcription, translation, display, speaker, mic, camera, device, phone, permissions, location, led, storage, dashboard, time) each own their subsystem behavior. They register their own router handlers, request subscriptions through session-provided callbacks, and avoid direct WebSocket usage.

### D-014: Do NOT flatten `device.state`

**Decided:** 2026-03-17 (spike session), overrides 039 D14
**Rationale:** The 039 API map proposed flattening `session.device.state.batteryLevel` → `session.device.batteryLevel`. But `session.device` already has hardware events, WiFi actions, capabilities, and gesture subscriptions. Keeping `.state` as a sub-object is cleaner. Two levels of nesting is fine when `state` is a coherent group of read-only reactive values.

### D-015: Keep `Observable<T>` pattern as-is

**Decided:** 2026-03-19 (session-device-spike)
**Rationale:** The existing `Observable<T>` implementation has the right semantics: synchronous read, reactive subscribe, cleanup function, change detection, error isolation. No reason to replace it with a simpler getter + onChange callback — that would double the API surface.

### D-016: `MentraSession` and `MiniAppServer` stay thin — complex logic goes to `_`-prefixed internals

**Decided:** 2026-03-19 (this conversation)
**Rationale:** The old `AppSession` became 2,423 lines because "session-level logic" is a gravity well. The rule: if the logic has its own state (timers, counters, maps, flags), extract it to an internal class. If it's pure dispatch with no state, keep it inline. `MentraSession` should be ~300-350 lines. `MiniAppServer` should be ~150 lines.

### D-017: The compat layer wraps the new runtime, not the other way around

**Decided:** 2026-03-17 (spike session)
**Rationale:** The v2 compat shims (`_V2SessionShim`, `_V2EventManagerShim`, etc.) delegate INTO the v3 managers. The v3 code has zero awareness of v2. When compat is removed in v3.1, only the shim files are deleted — the runtime is untouched.

### D-018: Binary audio frames bypass JSON routing

**Decided:** 2026-03-19 (this conversation, audit finding)
**Rationale:** Raw PCM audio arrives as binary WebSocket frames, not JSON. They are handed directly from `_ConnectionManager` to `MicManager.handleBinaryAudio()`. They do not pass through `_MessageRouter` or `DataStreamRouter`. This is the one exception to the "everything goes through the router" rule.

### D-019: Error isolation — handler errors must not kill the session

**Decided:** 2026-03-19 (this conversation, audit finding)
**Rationale:** All handler invocations in `DataStreamRouter` and `MessageHandlerRegistry` are wrapped in try/catch. A buggy developer handler cannot crash the transport, the session, or other managers.

---

## API Surface Decisions

### D-020: Phone events use sub-scoped managers

**Decided:** 2026-03-18 (session-phone-spike)
**Rationale:** `session.phone.notifications.on()` and `session.phone.calendar.on()` are lightweight sub-managers with their own `.hasPermission`. Better discoverability than flat methods. Matches how iOS/Android organize notifications and calendar as distinct subsystems.

### D-021: Phone battery stays permission-free

**Decided:** 2026-03-18 (session-phone-spike)
**Rationale:** Battery level isn't sensitive data. No permission gate where none is needed.

### D-022: Mic and transcription are independent subscriptions

**Decided:** 2026-03-18 (session-mic-spike)
**Rationale:** Subscribing to transcription does NOT give you raw audio. Subscribing to mic does NOT give you transcription. Either enables the hardware mic. Developers who want both subscribe to both.

### D-023: `session.mic.isActive` is per-app, not global

**Decided:** 2026-03-18 (session-mic-spike)
**Rationale:** The developer wants to know "am I receiving chunks?", not "is some other app using the mic?" Global mic state is a cloud concern.

### D-024: Translation pulled into v3.0 (overrides 039 D9)

**Decided:** 2026-03-17 (spike session)
**Rationale:** The 039 API map deferred translation to v3.1. Pulled into v3.0 because it follows the exact same pattern as transcription. No additional complexity.

### D-025: No notification caching in v3.0

**Decided:** 2026-03-18 (session-phone-spike)
**Rationale:** Notifications are transient real-time alerts. Replaying old notifications on subscription would confuse users. Calendar caching + replay stays (cloud's CalendarManager already does this).

---

## Deferred Decisions

These are explicitly NOT decided yet — they'll be resolved during implementation or in a future version.

| #     | Topic                                                | Notes                                                                      |
| ----- | ---------------------------------------------------- | -------------------------------------------------------------------------- |
| D-100 | `_SubscriptionManager` batching                      | Currently sends SUBSCRIPTION_UPDATE per add/remove. Should batch/debounce. |
| D-101 | `session.state<T>` typed shared state                | Spiked but not implemented. v3.1+ territory.                               |
| D-102 | Local app runtime (Hermes, native bridge)            | Spiked but not implemented. v3.1+ territory.                               |
| D-103 | `mentra` CLI tool                                    | Spiked but not implemented. v3.1+ territory.                               |
| D-104 | `userId` email → MongoDB `_id` migration             | Spiked in reconnection spike. Needs cloud + SDK coordinated change.        |
| D-105 | Audio priority system                                | Spiked in speaker spike. Deferred to v3.1 — last-writer-wins for now.      |
| D-106 | Video recording                                      | Spiked in camera spike. Requires ASG client firmware support.              |
| D-107 | SRT streaming support                                | Spiked in camera spike. Yash actively working on ASG client SRT.           |
| D-108 | `session.display.wrap()` text formatting             | Spiked in 039 API map. Not yet implemented in DisplayManager.              |
| D-109 | WebSocket path renames (`/ws/client`, `/ws/miniapp`) | Spiked. Requires coordinated cloud deploy.                                 |
| D-110 | Route namespacing (`/api/_mentraos/`)                | Spiked. SDK mounts both old and new paths. Cloud migrates separately.      |

---

## Superseded Decisions

These were made in earlier spikes but have been overridden by later decisions.

| Original                                      | In          | Superseded by                                                      | Why                                                                  |
| --------------------------------------------- | ----------- | ------------------------------------------------------------------ | -------------------------------------------------------------------- |
| 039 D14: Flatten `device.state`               | 039 API map | D-014: Do NOT flatten                                              | Too crowded with events/actions/capabilities at the same level       |
| 039 D9: Translation in v3.1                   | 039 API map | D-024: Translation in v3.0                                         | Same pattern as transcription, no additional complexity              |
| spike.md: `MentraApp` naming                  | Core spike  | D-002: `MiniAppServer`                                             | Avoids confusion with local apps, frees name for future use          |
| spike.md: `server/MentraApp.ts` file location | Core spike  | Implementation: `src/MiniAppServer.ts`                             | Simpler — one file at root, not a directory with one file            |
| spike.md: `compat/AppServer.ts`               | Core spike  | Implementation: compat via `_V2*Shim` files in `session/internal/` | Compat is tightly coupled to session internals, not a separate layer |
