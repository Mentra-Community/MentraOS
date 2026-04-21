# SDK v3 — Remaining Work Before Implementation

**Issue:** 048
**Related:** All spikes in this directory
**Status:** Pre-implementation checklist
**Date:** 2026-03-17

---

## Purpose

This document catalogs everything that still needs to be spiked, discussed, or decided before we start implementing SDK v3. It's the "what's left" checklist after the brainstorm session that produced the 6 spikes in this directory.

**Spikes completed:**

| Spike                                                                      | Covers                                                                                         | Status      |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------- |
| [spike.md](./spike.md)                                                     | Core SDK v3 — MentraSession, managers, MiniAppServer, compat shims, translation, transcription | ✅ Complete |
| [client-sdk-spike.md](./client-sdk-spike.md)                               | Local runtime — Hermes, MentraJS framework, build pipeline, TranscriptionCapabilities          | ✅ Complete |
| [reconnection-architecture-spike.md](./reconnection-architecture-spike.md) | Reconnection, resurrection, session identity, subscription sync, multi-cloud, userId/email     | ✅ Complete |
| [session-camera-spike.md](./session-camera-spike.md)                       | Camera — photos, streaming unification, video recording (future), error propagation            | ✅ Complete |
| [session-speaker-spike.md](./session-speaker-spike.md)                     | Speaker — audio output, TTS, audio streaming, priority/conflict                                | ✅ Complete |
| [session-state-spike.md](./session-state-spike.md)                         | Typed shared state — session.state\<T\>, webview hooks, transport                              | ✅ Complete |
| [session-mic-spike.md](./session-mic-spike.md)                             | Mic — raw PCM audio, VAD, mic↔transcription relationship, audio routing                       | ✅ Complete |
| [session-device-spike.md](./session-device-spike.md)                       | Device — Observable state, hardware events, WiFi, capabilities, gestures                       | ✅ Complete |
| [session-phone-spike.md](./session-phone-spike.md)                         | Phone — notifications, calendar, phone battery, sub-scoped managers                            | ✅ Complete |

---

## Spiked (Previously "Needs Its Own Spike")

These were complex enough that they needed dedicated spikes. All three are now complete.

### 1. `session.mic` — Audio Input ✅

**Spike:** [session-mic-spike.md](./session-mic-spike.md)

**Key decisions:**

- Mic and transcription are **independent subscriptions on a shared resource**. Subscribing to transcription does NOT give you raw audio, and vice versa. Either enables the hardware mic.
- `MicManager` wraps binary frames with metadata (always-present `sampleRate`, `channels`, `timestamp`) — fixes the v2 inconsistency where `sampleRate` was optional and missing from one of two code paths.
- VAD `status: boolean | "true" | "false"` mixed type is normalized to a clean `isSpeaking: boolean` by the `MicManager`.
- `session.mic.isActive` is **per-app** (reflects whether THIS app has a `onChunk` subscription), not global mic state.
- Transport abstraction handles local vs cloud routing — `MicManager` doesn't know or care where audio comes from.
- Wire protocol: **zero changes**. All v3 work is SDK-side.

### 2. `session.device` — Hardware & Device State ✅

**Spike:** [session-device-spike.md](./session-device-spike.md)

**Key decisions:**

- **Keep `Observable<T>` pattern** as-is. It's working, well-tested, and has the right semantics (sync read, reactive subscribe, cleanup function, change detection, error isolation).
- **Do NOT flatten `device.state`** (overrides 039 D14). Too many other things on `session.device` (events, actions, capabilities) to also dump observables there.
- **Kill `getWifiStatus()` and `isWifiConnected()`** — the Observable `session.device.state.wifiConnected` is the single source. Legacy methods become deprecated shims.
- **Fix `subscribeToGestures` subscription leak** — v3 registers proper handlers internally instead of bypassing EventManager.
- **Keep VPS coordinates** — dormant but costs nothing. Fix the double-subscribe bug, move to `session.device.onVpsCoordinates()`, mark as experimental.
- **Battery: keep both Observable and event** — Observable for "what is battery now?", event for apps that need `timeRemaining` or every update.
- Wire protocol: **zero changes**.

### 3. `session.phone` — Phone Events ✅

**Spike:** [session-phone-spike.md](./session-phone-spike.md)

**Key decisions:**

- **Sub-scoped managers**: `session.phone.notifications` and `session.phone.calendar` are lightweight sub-managers with their own `.on()`, `.hasPermission`, and handler tracking. Better discoverability and scales better than flat methods.
- **Phone battery stays permission-free** — battery level isn't sensitive data. No gate where none is needed.
- **No notification caching in v3.0** — notifications are transient real-time alerts, not a queryable set. Calendar caching + replay stays (cloud's `CalendarManager` already does this).
- **Clean up `NotificationDismissedEvent`** — remove unreliable `title`/`content` fields that the REST path doesn't populate.
- **Normalize calendar field names**: `dtStart` → `start`, `dtEnd` → `end`, `timeStamp` → `timestamp`.
- **Fix `phone_battery_update` category** — recategorize from `HARDWARE` to `PHONE` for consistency.
- Wire protocol: **zero changes**.

---

## Doesn't Need a Full Spike — Implement from 039 API Map

These are straightforward renames/restructures that can be implemented directly from the [039 API map](../039-sdk-v3-api-surface/v2-v3-api-map.md) without a separate spike.

### 4. `session.permissions` — Centralized Permission Checks

```typescript
class PermissionsManager {
  has(permission: PermissionType): boolean;
  getAll(): Record<PermissionType, boolean>;
  onUpdate(handler): () => void;
}
type PermissionType = "location" | "microphone" | "camera" | "notifications" | "calendar";
```

Straightforward. Individual managers expose `.hasPermission` as a getter that reads from this central store. No open design questions.

### 5. `session.location` — GPS

Already exists as `LocationManager`. Changes:

- `subscribeToStream()` → `onUpdate(handler)`
- `getLatestLocation()` → cached `lat` / `lng` / `accuracy` / `timestamp` read-only properties
- Add `hasPermission`
- Add `requestUpdate()` for one-shot
- Add `stop()`

No open design questions. The 039 map has the full API.

### 6. `session.led` — LED Control

No changes from v2. Keep as-is.

### 7. `session.storage` — Key-Value Storage

Rename from `session.simpleStorage`. Methods:

- `get(key)`, `set(key, value)`, `delete(key)`, `clear()`, `keys()`, `has(key)`, `getAll()`, `setMultiple(data)`, `flush()`

Rename `hasKey` → `has`, `getAllData` → `getAll`. No other changes.

### 8. `session.time` — Timezone Utils

New in v3. Simple stateless namespace:

```typescript
session.time.zone          // IANA timezone string
session.time.now()         // Date in user's timezone
session.time.toLocal(date) // convert UTC → user local
session.time.format(date, opts?) // Intl.DateTimeFormat wrapper
```

No open design questions. The user's timezone comes from `userSession.userTimezone` (already available).

### 9. `session.dashboard` — Dashboard Widget

```typescript
session.dashboard.showText(text: string | string[])
session.dashboard.clear()
```

Already implemented on the cloud side in issue 047. SDK just needs the two methods. No open questions.

### 10. `session.display` — Display / Text Formatting

Rename from `session.layouts`. Key additions from 039:

- `showText(text: string | string[])` — accepts pre-wrapped arrays
- `wrap(text, opts?)` — pure text formatting, returns `string[]`
- `maxLines`, `widthPx`, `profile` — device info read-only properties
- `createScrollView()` — ScrollView integration

The 039 API map §3b has the full spec including the two-layer wrapping model.

---

## Needs Discussion But Not a Full Spike

### 11. Route Namespacing (`/api/_mentraos/`)

The 039 map specifies moving all SDK endpoints behind `/api/_mentraos/`:

| v2 path         | v3 path                       |
| --------------- | ----------------------------- |
| `/webhook`      | `/api/_mentraos/webhook`      |
| `/tool`         | `/api/_mentraos/tool`         |
| `/health`       | `/api/_mentraos/health`       |
| `/settings`     | `/api/_mentraos/settings`     |
| `/photo-upload` | `/api/_mentraos/photo-upload` |

Legacy aliases at root paths for backward compat.

**What needs team input:** The cloud hardcodes these paths in `AppManager.ts`, `app.service.ts`, `PhotoManager.ts`, `app-settings.routes.ts`, `system-app.api.ts`. When does the cloud switch to the new paths? Same PR as SDK v3? Separate cloud PR? Can the cloud auto-detect which paths the SDK supports (via `sdkVersion`)?

### 12. `mentra` CLI Tool

We designed `mentra dev / build / publish` in the client SDK spike. Before building it:

- Is it a separate npm package (`@mentra/cli`)? Or bundled with `@mentra/sdk`?
- How does `mentra dev` discover `mentra.config.ts`?
- Does `mentra build` bundle `hermesc` or call it externally?
- Does `mentra publish` authenticate with the dev console? How?
- Is this v3.0 scope or v3.1+?

Probably v3.1+ — the CLI is for local apps which depend on the mobile runtime work. v3.0 is the cloud SDK refactor.

### 13. Open Questions from All Spikes

Each spike has open questions. These should be reviewed and decided before or during implementation:

**From spike.md (core SDK):**

- Remove `session.events` entirely in v3.0 or keep as deprecated shim?
- v3.1 shim removal timeline?
- ISO 639-1 codes in wire protocol — does cloud accept both `en` and `en-US`?
- Captions app: migrate to v3 API or keep on compat shim?

**From reconnection-architecture-spike.md:**

- Event buffering during TRANSPORT_DOWN (5s) — buffer or drop?
- Cloud-side deferred app socket registry placement and implementation — implement to spec
- RECONNECT retry strategy for non-booting failures — implement the default `1s, 1s, 2s, 2s, then cap at 5s`
- userId transition plan (email → MongoDB \_id)
- Kill old sessionId format entirely?
- Subscription comparison algorithm
- v2 backport of `resurrected: true` flag

**From session-camera-spike.md:**

- Video recording TTL (24h? configurable?)
- SRT support timeline
- Photo upload path for local apps (no cloud intermediary?)
- Concurrent photo + stream operations
- Video max file size / duration limits

**From session-speaker-spike.md:**

- Audio priority model (priority levels? OS mixer? last-writer-wins?)
- Track system expansion (more than 3 tracks?)
- PCM encoding — SDK or cloud responsibility?
- `flush()` naming (too aggressive? `interrupt()`? `clear()`?)

**From session-state-spike.md:**

- Webview without active session — show stale data? "App not running" screen?
- Storage access without active session
- Grace period before "no-session" fires
- Auto-restart — SDK or OS concern?

**From client-sdk-spike.md:**

- Hermes context isolation (one instance per app or shared?)
- JSI `fetch` availability in standalone Hermes
- Hermes bytecode versioning (server vs phone mismatch)
- iOS App Store review for JS bundle execution
- Shared vs dedicated BLE connection

---

## Suggested Implementation Order

This is a suggestion, not a decision — the team should prioritize based on what matters most:

**Phase 1 — Core refactor (unblocks everything else):**

- `MentraSession` (renamed from AppSession)
- `Transport` interface + `WebSocketTransport`
- `MiniAppServer` (callback pattern)
- `AppServer` compat shim
- Message dispatch refactor (DataStreamRouter)
- `@mentra/sdk/session` entrypoint
- `sdkVersion` in CONNECTION_INIT

**Phase 2 — Managers (the bulk of the work):**

- `TranscriptionManager` (with `forLanguage(string | string[])`)
- `TranslationManager` (with `to(string | string[])`)
- `DisplayManager` (rename from layouts, add wrap/showText)
- `SpeakerManager` (rename from AudioManager, audio streaming)
- `MicManager` (new — audio input, see [session-mic-spike.md](./session-mic-spike.md))
- `DeviceManager` (new — hardware events, WiFi, capabilities, see [session-device-spike.md](./session-device-spike.md))
- `PhoneManager` (new — notifications, calendar, see [session-phone-spike.md](./session-phone-spike.md))
- `PermissionsManager`, `LocationManager`, `StorageManager`, `TimeUtils`, `DashboardManager`
- `CameraManager` (unified streaming, photo cleanup)

**Phase 3 — Reconnection (fixes active bugs):**

- `RECONNECT` message type
- `TRANSPORT_DOWN` state (preserve AppSession)
- Subscription sync protocol (ACK includes subs, SDK compares)
- `sessionId` as UUID
- `cloudHostname` in webhooks
- Backward compat for v2 SDKs

**Phase 4 — Shared state + compat:**

- `session.state<T>` (typed shared state)
- WebSocket transport for state sync
- `useMentraState<T>()` React hook
- `LegacyEventShim` (v2 compat)
- Deprecated getters on MentraSession
- `AppSession` type alias

**Phase 5 — Polish:**

- `userId` → MongoDB `_id` migration
- Route namespacing (`/api/_mentraos/`)
- WebSocket path renames (`/ws/client`, `/ws/miniapp`)
- Dead code removal (app-to-app, old DashboardAPI, TpaServer/TpaSession)
- Bug fixes from the spike tables
- Migration guide, README, examples
- Publish `3.0.0`

**Phase 6 (v3.1) — Cleanup + advanced:**

- Remove all compat shims
- Remove legacy route aliases
- `mentra` CLI
- Video recording (when ASG client supports it)
- Audio priority system
- SRT streaming support
