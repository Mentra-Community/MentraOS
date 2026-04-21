# Private Runtime Architecture: SDK v3

**Issue:** 048  
**Status:** Working spec  
**Scope:** Hidden/internal SDK runtime design for `MiniAppServer`, `MentraSession`, transport, routing, subscriptions, lifecycle, and compatibility  
**Date:** 2026-03-14  
**Updated:** 2026-03-19 — naming decisions, internal class consolidation, v2 shim naming

---

## Purpose

This doc freezes the internal architecture for SDK v3 before more implementation lands.

It complements:

- [`spike.md`](./spike.md) for overall implementation direction
- [`reconnection-architecture-spike.md`](./reconnection-architecture-spike.md) for reconnect philosophy and cloud interaction
- [`cloud-websocket-bootstrap-spike.md`](./cloud-websocket-bootstrap-spike.md) for current cloud-side bootstrap and `UserSession` ownership
- [`../039-sdk-v3-api-surface/v2-v3-api-map.md`](../039-sdk-v3-api-surface/v2-v3-api-map.md) for the public API

This doc is about the parts developers do **not** directly code against:

- server/session orchestration
- transport abstraction
- message routing
- subscription bookkeeping
- hidden manager dependencies
- compatibility layer boundaries

---

## Goals

The internal runtime must:

1. Keep the current cloud wire protocol working.
2. Preserve backward compatibility for legacy SDK apps during the transition.
3. Make `MentraSession` transport-agnostic so the same session API can later run outside Node.
4. Make subscriptions derived from handler registrations, not manually maintained state.
5. Keep subsystem logic inside managers instead of one giant session class.
6. Support reconnection without treating every transport loss as session death.
7. Support a parked/reattach state where the cloud can temporarily defer reconnect acceptance during cloud restart/bootstrap without forcing the SDK to destroy `MentraSession` state.

---

## Non-Goals For This Pass

This refactor does **not** need to solve all future runtime concerns now.

Deferred:

- local runtime implementation
- mobile or ASG client changes
- full cloud-side `UserSession` identity redesign
- new wire protocol
- identity redesign beyond what is required for compatibility

---

## Top-Level Model

The internal runtime has three layers:

1. `MiniAppServer`
   - cloud/server host
   - owns HTTP endpoints, webhook ingress, and session creation

2. `MentraSession`
   - per-user runtime orchestrator
   - owns transport lifecycle, routing, subscriptions, and manager instances

3. Internal subsystems (`_`-prefixed, never exported)
   - `_SessionManager` — server-level: creates, tracks, and tears down sessions from webhooks
   - `_ConnectionManager` — session-level: connect, reconnect, ping, park, disconnect
   - `_SubscriptionManager` — session-level: ref-counted subscription set, sends SUBSCRIPTION_UPDATE
   - `_MessageRouter` — session-level: owns MessageHandlerRegistry + DataStreamRouter

4. Managers
   - subsystem implementations such as transcription, mic, speaker, device, phone, camera, storage

5. V2 compatibility shims (`_V2*Shim`, never exported)
   - old surface preserved temporarily
   - delegates into the new runtime managers
   - removed in v3.1

There is also an explicit distinction between:

- public runtime classes
  - `MiniAppServer`
  - `MentraSession`
  - public subsystem managers such as `TranscriptionManager`, `MicManager`, `SpeakerManager`
- private implementation managers
  - underscore-prefixed internal classes such as `_SessionLifecycleManager` or `_SubscriptionManager`

The purpose of the underscore-prefixed layer is to keep the public top-level classes lean and readable while still giving the runtime clear internal responsibility boundaries.

---

## Class Responsibilities

### `MiniAppServer`

`MiniAppServer` is the cloud-only host wrapper. Named `MiniAppServer` (not `MentraApp`) to avoid confusion with future local apps that don't need a server. See `decisions.md` D-002.

It owns:

- Hono app construction (extends `AppServer` during transition)
- Mentra webhook/tool/settings/health/photo-upload routes
- route aliasing for current cloud compatibility
- `_SessionManager` — creates, tracks, and disposes session instances
- bridging incoming cloud webhook events into per-user session startup and shutdown
- onSession/onStop/onToolCall callback registration

It does **not** own:

- stream-level event logic
- transport message parsing
- subscription derivation
- subsystem behavior like transcription, audio, notifications, location
- detailed internal workflow logic when that logic can live in a private underscore-prefixed runtime manager

### `MentraSession`

`MentraSession` is the real per-user runtime object.

It owns:

- injected `Transport`
- connection init
- connection ack handling
- reconnect attempt policy
- ping keepalive
- raw incoming message parsing
- top-level message dispatch
- `DataStream` dispatch
- subscription set bookkeeping
- manager construction and teardown
- session-scoped settings/capabilities/runtime state

It should remain relatively thin. Its job is orchestration, not feature logic.

It should also remain readable. If the class starts accumulating substantial hidden workflow logic, that logic should move into private underscore-prefixed runtime managers rather than turning `MentraSession` into a large god object.

It must also be able to preserve session-scoped in-memory state through three distinct cases:

- normal transport reconnect
- cloud-driven resurrection
- cloud restart / boot-time reattach deferral (`booting` / parked state)

Default runtime decisions:

- parked timeout defaults to 30 seconds
- deferred/booting app sockets stay open as unattached control channels rather than being immediately closed
- successful reconnect or reattach should emit a public `session.onReconnected()` signal
- cloud-side deferred app sockets should live outside `UserSession`; `UserSession` remains owned by the glasses/mobile connection

### Managers

Managers own subsystem behavior and public subsystem APIs.

Examples:

- `TranscriptionManager`
- `TranslationManager`
- `DisplayManager`
- `SpeakerManager`
- `MicManager`
- `DeviceManager`
- `PhoneManager`
- `PermissionsManager`
- `CameraManager`
- `LedManager`
- `LocationManager`
- `StorageManager`
- `DashboardManager`
- `TimeUtils`

Managers should:

- register their own router/message handlers
- request subscriptions through session-provided callbacks
- avoid direct WebSocket usage
- avoid global mutable state

Managers should not:

- own session reconnect policy
- parse raw transport frames directly unless explicitly given those frames by the session

### Private underscore-prefixed managers

These are internal implementation objects, not public SDK surface.

Examples of the kind of responsibilities that belong here:

- `_SessionLifecycleManager`
- `_SubscriptionManager`
- `_MessageRouter`
- `_ReconnectManager`
- `_SessionRegistry`
- `_WebhookRouteManager`
- `_CompatSessionAdapter`
- cloud-side `_DeferredAppConnectionRegistry`

These names are illustrative, not mandatory, but the pattern is intentional:

- underscore prefix means internal/private runtime implementation
- these classes may change freely without implying public API support
- they exist to keep `MiniAppServer` and `MentraSession` lean

Rule of thumb:

- public developer-facing subsystem concepts stay in normal manager classes
- hidden orchestration/business logic moves into underscore-prefixed private managers

This is preferred over allowing the top-level public runtime classes to accumulate large amounts of hidden control flow.

---

## Transport Boundary

`MentraSession` must depend on `Transport`, not directly on `ws`.

Current transport contracts:

- [`cloud/packages/sdk/src/transport/Transport.ts`](/Users/isaiah/Documents/Mentra/MentraOS/cloud/packages/sdk/src/transport/Transport.ts)
- [`cloud/packages/sdk/src/transport/WebSocketTransport.ts`](/Users/isaiah/Documents/Mentra/MentraOS/cloud/packages/sdk/src/transport/WebSocketTransport.ts)

Required transport responsibilities:

- send JSON text
- send binary data
- emit incoming text
- emit incoming binary
- emit close
- emit error
- expose ready state

The session layer must be able to run unchanged with:

- `WebSocketTransport` in cloud/server mode
- some future native bridge transport in local mode

That is the primary internal portability boundary.

## Cloud Recovery Boundary

The cloud runtime should preserve a hard boundary between:

- user presence on this cloud
- mini app transport presence on this cloud

That means:

- `UserSession` is still created by the glasses/mobile connection
- a reconnecting v3 mini app does not create a full speculative `UserSession`
- cloud boot/recovery should use a deferred unattached app-socket registry outside `UserSession`

This is the cloud-side equivalent of the SDK parked-session model:

- app transport may be connected
- logical attach may still be deferred
- the cloud remains authoritative about when the app is actually allowed to attach

---

## Routing Architecture

The routing model is two-stage, plus a binary bypass.

### Stage 1: top-level message routing

`MessageHandlerRegistry` dispatches by `message.type`.

Examples:

- `tpa_connection_ack`
- `settings_update`
- `device_state_update`
- `capabilities_update`
- `data_stream`
- `photo_response`

### Stage 2: `data_stream` routing

`DataStreamRouter` dispatches by `streamType` with prefix matching.

Examples:

- `transcription:en`
- `translation:auto-es`
- `button_press`
- `touch_event:double_tap`
- `phone_notification`

Prefix matching rules:

- `"transcription"` matches `"transcription:en"`, `"transcription:auto"`, etc.
- The character after the prefix must be `:` or end-of-string (prevents `"touch_event"` from matching `"touch_event_other"`)
- ALL matching handlers fire (not just the first match) — critical for multiple simultaneous `forLanguage()` calls

### Stage 3: binary bypass

Raw PCM audio arrives as binary WebSocket frames. These bypass JSON routing entirely and are handed directly from `_ConnectionManager` to `MicManager.handleBinaryAudio()`. This is the one exception to "everything goes through the router."

### Ownership

- `_MessageRouter` owns both registries (wrapped in a thin class)
- `MentraSession` creates `_MessageRouter` and registers the bridge between stage 1 and stage 2
- managers register only for the message or stream keys they care about

This replaces the legacy 413-line `handleMessage()` if/else chain.

The routing implementation itself may live inside private underscore-prefixed runtime helpers as long as the architectural boundary remains the same.

---

## Subscription Model

This is the most important hidden invariant.

### Source of truth

The SDK runtime must treat active handler registrations as the source of truth for subscriptions.

That means:

- if the app registers a handler requiring a stream, the SDK must subscribe
- if the app removes the last handler for that stream, the SDK must unsubscribe
- the session should not maintain an independent hand-edited subscription model that can drift

### Session responsibility

`_SubscriptionManager` owns the actual wire-visible subscription set and the `SUBSCRIPTION_UPDATE` send.

Managers do not send subscription update messages directly. They call:

- `addSubscription(stream)` — provided via the manager dependency bag
- `removeSubscription(stream)` — provided via the manager dependency bag

**Known issue:** `_SubscriptionManager` currently sends a `SUBSCRIPTION_UPDATE` on every individual `add()`/`remove()` call. If `onSession` registers 5 subscriptions synchronously, that's 5 messages. This needs debouncing — collect changes within a microtask and send one batched update.

### Manager responsibility

Managers own their own ref-counting or registration bookkeeping so they only ask the session to add/remove subscriptions at the correct edges.

Examples:

- first `onChunk()` subscriber adds `audio_chunk`
- last one removes `audio_chunk`
- multiple transcription handlers for the same language should still collapse to one active wire subscription

### Cloud compatibility rule

For this pass, `SUBSCRIPTION_UPDATE` message shape must remain compatible with the current cloud.

The bookkeeping behind this may be implemented in a private `_SubscriptionManager` rather than directly inside `MentraSession`, and that is the preferred direction if session code starts becoming noisy.

---

## Private Session State

The runtime should consider these internal state groups canonical.

### Identity

- `packageName`
- `sessionId` (runtime session ID, may differ from webhook session ID after reconnect)
- `userId` if known
- server/base URL if needed for REST-backed managers (e.g., `StorageManager`)

### Connection (owned by `_ConnectionManager`)

- `transport`
- connected/disconnected flag
- explicit disconnect flag (prevents reconnect after intentional close)
- reconnect attempt counter
- reconnect timer (exponential backoff)
- ping interval (15s keepalive)
- parked timer (for deferred reconnect scenarios)

### Routing (owned by `_MessageRouter`)

- `MessageHandlerRegistry` — top-level message type dispatch
- `DataStreamRouter` — DATA_STREAM streamType dispatch with prefix matching
- manager cleanup callbacks (stored in `cleanupTasks` array on MentraSession)

### Cloud-provided session state

- app settings
- MentraOS settings
- capabilities
- app config

### Runtime bookkeeping

- subscription set
- lifecycle event emitter

These should remain private to the session runtime, not exposed as public mutable fields.

They also do not all need to live directly on `MentraSession` if a private internal manager is the cleaner owner.

---

## Lifecycle Model

The expected lifecycle is:

1. `MiniAppServer` creates a `MentraSession`
2. transport connects
3. session sends `CONNECTION_INIT`
4. cloud returns `CONNECTION_ACK`
5. session applies:
   - settings
   - MentraOS settings
   - capabilities
6. session starts ping keepalive
7. session sends current `SUBSCRIPTION_UPDATE`
8. managers continue handling data and commands

On transport close:

- if explicit shutdown: clean teardown
- if unexpected: reconnect policy may run

On teardown:

- stop timers
- stop ping
- destroy managers
- clear router/registry state
- close transport

The lifecycle flow may be coordinated by a private `_SessionLifecycleManager` if that produces a cleaner implementation.

---

## Reconnection Model

For the current implementation pass:

- `_ConnectionManager` owns reconnect attempt policy (exponential backoff, max attempts, parked timeout).
- reconnect is transport/session level, not manager level.
- manager subscriptions/config should be re-applied from current runtime state after reconnect.

Required principles:

- reconnect should preserve the session runtime instance whenever possible
- losing the transport should not automatically imply losing manager state or developer-installed handlers
- on reconnect: if the session has completed an initial connect, send `RECONNECT` (with sessionId) instead of `CONNECTION_INIT`. If `RECONNECT` is rejected, fall back to `CONNECTION_INIT`.
- after `CONNECTION_ACK` or `RECONNECT_ACK`: call `_SubscriptionManager.sync()` to re-send the full subscription set
- after reconnect: replay `TranscriptionManager.config` via `configure()` if it was previously set

The more ambitious cloud-side resurrection redesign remains governed by [`archive/reconnection-architecture-spike.md`](./archive/reconnection-architecture-spike.md) and may require additive cloud work later.

### State preservation across reconnect

Different managers have different preservation semantics during a transport blip:

- `DeviceManager` Observable values → preserved in memory (may be stale until next DEVICE_STATE_UPDATE)
- `TranscriptionManager`/`TranslationManager` handlers → preserved, re-subscribed via `_SubscriptionManager.sync()`
- `MicManager` audio stream → inherently lost (binary stream is dead, resumes when transport reconnects)
- `SpeakerManager` active `AudioOutputStream` → enters error state (HTTP chunked response to phone is dead)
- `StorageManager` pending writes → flushed or lost depending on timing

---

## Manager Dependency Contract

All managers should receive structural dependencies from the session rather than concrete session implementation references wherever practical.

The unified dependency bag passed to all managers:

```typescript
{
  router: DataStreamRouter          // register for DATA_STREAM subtypes
  messageHandlers: MessageHandlerRegistry  // register for top-level message types
  addSubscription: (stream: string) => void
  removeSubscription: (stream: string) => void
  sendMessage: (message: unknown) => void
  sendBinary: (data: ArrayBuffer | Uint8Array) => void
  logger: Logger
  getPackageName: () => string
  getSessionId: () => string
  getServerUrl: () => string | null   // for REST-backed managers (StorageManager)
  permissions: PermissionsManager     // for .hasPermission getters
}
```

Some managers use a subset (e.g., `PermissionsManager` only needs `{logger}`, `TimeUtils` needs nothing). Some need extra config (e.g., `StorageManager` receives `{userId, apiKey}` separately).

This is intentional:

- keeps managers testable (mock the bag, test the manager)
- reduces coupling (no manager imports MentraSession)
- allows the runtime to evolve without rewriting every manager
- enables future local-app runtime to provide the same bag with different implementations

The same principle applies to private underscore-prefixed managers: they should also prefer narrow structural dependencies over hard coupling to giant top-level classes.

---

## Compatibility Boundary

This must stay explicit.

### New runtime

The target runtime is:

- `MiniAppServer` (cloud host)
- real `MentraSession` (per-user session)
- manager-based subsystem APIs (14 managers)

### Legacy compatibility (v2 shims)

The compatibility surface is implemented as `_V2*Shim` classes in `session/internal/`:

| Shim                  | What it provides                                                                                                    | Delegates to                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `_V2SessionShim`      | `session.layouts`, `session.audio`, `session.simpleStorage`, `session.events`, `session.settings`, `session.camera` | v3 managers via MentraSession                           |
| `_V2EventManagerShim` | `session.events.onTranscription()`, `onButtonPress()`, `onPhoneNotifications()`, etc.                               | TranscriptionManager, DeviceManager, PhoneManager, etc. |
| `_V2CameraShim`       | `requestPhoto()`, `startStream()`, `startManagedStream()`, etc.                                                     | CameraManager                                           |
| `_V2SettingsShim`     | `settings.get()`, `settings.has()`, `settings.onChange()`                                                           | MentraSession.settingsData                              |
| `_V2AudioStreamShim`  | EventEmitter-style `.on("close", ...)` on AudioOutputStream                                                         | SpeakerManager's AudioOutputStream                      |

The compatibility layer wraps the new runtime, not the other way around. Old public names forward to new internals — never the reverse.

**Known gap:** `_V2SessionShim` is missing ~15 utility methods from the old `AppSession` (e.g., `getSettings()`, `subscribe()`, `getWifiStatus()`, `capabilities`, `sendMessage()`). These need to be added before v2 apps can run on the v3 runtime without changes. See `implementation-status.md` for the full list.

### Current transition state

`MiniAppServer` extends the v2 `AppServer` for backward compat. When a v3-style `app.onSession((session) => {...})` callback is registered, webhooks flow through `_SessionManager` → `MentraSession` → v3 runtime. When a v2-style subclass overrides `onSession(session, sessionId, userId)`, it goes through the old `AppServer` path entirely.

This dual path is temporary. The goal is for all paths to flow through `MentraSession` once v2 compat is verified.

---

## Risk Areas Explicitly Called Out

These internals are not equally stable yet.

### Lower-risk areas

- transport abstraction (complete, tested)
- message routing pattern (complete, well-tested prefix matching)
- subscription ownership model (complete, ref-counting works)
- manager-based split (all 14 managers complete)
- ping/reconnect ownership living in `_ConnectionManager`

### Higher-risk areas

- **CONNECTION_INIT handshake** — v3 sends userId via HTTP headers instead of sessionId in CONNECTION_INIT. Must verify the cloud's app WebSocket upgrade handler supports header-based auth. **This is the #1 compatibility risk.**
- camera, because current cloud path still depends on `/photo-upload` behavior and the `_V2CameraShim` bridges this
- storage, because it depends on existing HTTP endpoints and auth assumptions
- permissions, because current cloud payloads are not yet ideal for the cleaner model
- v2 compat completeness — `_V2SessionShim` is missing utility methods that real v2 apps use
- `_SubscriptionManager` batching — currently sends per-add, should debounce

---

## What Is Frozen By This Doc

The following should be considered decided unless we find a concrete incompatibility:

1. `MiniAppServer` is the cloud host abstraction. Not `MentraApp` — that name is reserved for potential future use.
2. `MentraSession` is the real per-user runtime abstraction.
3. `MentraSession` depends on `Transport`, not `ws`.
4. Message routing is registry-based, not giant conditional-chain based.
5. Subscriptions are derived from handler registrations.
6. Managers are the primary private subsystem boundary.
7. The compat layer (`_V2*Shim`) is temporary and wraps the new runtime.
8. Internal classes use `_` prefix: `_SessionManager`, `_ConnectionManager`, `_SubscriptionManager`, `_MessageRouter`.
9. V2 compat shims use `_V2` prefix + `Shim` suffix: `_V2SessionShim`, `_V2EventManagerShim`, etc.
10. Server-level internals (`_SessionManager`) consolidate factory + registry + lifecycle into one class.
11. `MentraSession` and `MiniAppServer` stay thin — complex stateful logic is extracted to `_`-prefixed internals.
12. Binary audio frames bypass JSON routing and go directly to `MicManager.handleBinaryAudio()`.
13. Handler errors are isolated — a buggy handler cannot crash the session, transport, or other managers.

---

## What Is Still Intentionally Open

These details are still allowed to evolve during implementation:

1. whether `MiniAppServer` swaps directly to `MentraSession` or via a compat adapter first
2. exact shape of legacy session shim properties and deprecation helpers
3. whether some managers are gated or partially deferred in the first runtime cutover
4. what minimal additive cloud changes are required for the new runtime to behave safely

---

## Related Documents

| Document                   | Purpose                                                               |
| -------------------------- | --------------------------------------------------------------------- |
| `decisions.md`             | Every decision with rationale — the "why" reference                   |
| `implementation-status.md` | Current build state, bugs, what's left — the "where are we" reference |
| `docs-update-spec.md`      | Plan for developer-facing documentation                               |
| `sdk-release-sop.md`       | Standard operating procedure for SDK releases                         |
| `sdk-cicd-plan.md`         | CI/CD pipeline plan for automated publishing                          |
| `archive/`                 | Pre-implementation spikes — design rationale, not current specs       |

The main remaining unknowns are no longer architectural blind spots. They are implementation and compatibility decisions discovered while wiring the runtime into the active cloud path. See `implementation-status.md` for the specific list of bugs and gaps.
