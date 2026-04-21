# SDK v3 — Implementation Status

**Issue:** 048
**Branch:** `cloud/issues-048`
**Last updated:** 2026-03-19

---

## Purpose

This is the "where are we right now" document. It replaces `remaining-work.md` (now in `archive/`). Check this before starting any v3 work to avoid duplicating effort or missing context.

---

## What's Built

### Transport Layer ✅

| File                                  | Lines | Status                                           |
| ------------------------------------- | ----- | ------------------------------------------------ |
| `src/transport/Transport.ts`          | ~130  | Complete — interface, states, utilities          |
| `src/transport/WebSocketTransport.ts` | ~280  | Complete — wraps `ws`, only file that imports it |

### Session Core ✅

| File                              | Lines | Status                                                                        |
| --------------------------------- | ----- | ----------------------------------------------------------------------------- |
| `src/session/MentraSession.ts`    | ~340  | Complete — thin orchestrator, all 14 managers                                 |
| `src/session/DataStreamRouter.ts` | ~340  | Complete — `MessageHandlerRegistry` + `DataStreamRouter` with prefix matching |
| `src/session/index.ts`            | 1     | Complete — barrel re-export                                                   |

### Internal Session Subsystems ✅

| File                                               | Lines | Status   | Notes                                                                                                   |
| -------------------------------------------------- | ----- | -------- | ------------------------------------------------------------------------------------------------------- |
| `src/session/internal/_MessageRouter.ts`           | ~50   | Complete | Owns both registries, parses raw JSON                                                                   |
| `src/session/internal/_SessionLifecycleManager.ts` | ~195  | Complete | Reconnect, ping, backoff, parked timeout. **To rename → `_ConnectionManager`** (see decisions.md D-005) |
| `src/session/internal/_SubscriptionManager.ts`     | ~65   | Complete | Ref-counted subscription Set. **Bug: sends update per add/remove, should batch**                        |

### V2 Compat Shims ✅

| File                                                      | Lines | Status          | Notes                                                                             |
| --------------------------------------------------------- | ----- | --------------- | --------------------------------------------------------------------------------- |
| `src/session/internal/_CompatMentraSessionAdapter.ts`     | ~160  | Mostly complete | **To rename → `_V2SessionShim`**. Missing ~15 v2 utility methods (see gaps below) |
| `src/session/internal/_CompatEventManagerAdapter.ts`      | ~120  | Complete        | **To rename → `_V2EventManagerShim`**                                             |
| `src/session/internal/_CompatCameraAdapter.ts`            | ~165  | Complete        | **To rename → `_V2CameraShim`**                                                   |
| `src/session/internal/_CompatSettingsAdapter.ts`          | ~95   | Complete        | **To rename → `_V2SettingsShim`**                                                 |
| `src/session/internal/_CompatAudioOutputStreamAdapter.ts` | ~55   | Complete        | **To rename → `_V2AudioStreamShim`**                                              |

### Managers (all 14) ✅

| File                      | Lines | Status          | Notes                                                                                      |
| ------------------------- | ----- | --------------- | ------------------------------------------------------------------------------------------ |
| `TranscriptionManager.ts` | ~310  | Complete        | `on()`, `forLanguage()`, `configure()`, `stop()`                                           |
| `TranslationManager.ts`   | ~310  | Complete        | `on()`, `to()`, `fromTo()`, `stop()`                                                       |
| `DisplayManager.ts`       | ~250  | Complete        | `showText()`, `showTextWall()`, `clear()`, etc.                                            |
| `SpeakerManager.ts`       | ~726  | Complete        | `play()`, `speak()`, `createStream()`, `stop()`                                            |
| `MicManager.ts`           | ~320  | Complete        | `onChunk()`, `onVoiceActivity()`, `isSpeaking`, `isActive`                                 |
| `CameraManager.ts`        | ~440  | Complete        | `takePhoto()`, `onPhotoTaken()`, streaming. **Bug: requestId correlation in stream check** |
| `DeviceManager.ts`        | ~655  | Complete        | 13 Observables, hardware events, WiFi, capabilities                                        |
| `PhoneManager.ts`         | ~549  | Complete        | Sub-scoped notifications + calendar, battery                                               |
| `PermissionsManager.ts`   | ~290  | Complete        | `has()`, `getAll()`, `onUpdate()`                                                          |
| `LocationManager.ts`      | ~420  | Mostly complete | **Bug: memory leak in `onUpdate()` — `updateCleanup` not stored**                          |
| `LedManager.ts`           | ~190  | Complete        | `setColor()`, `off()`                                                                      |
| `StorageManager.ts`       | ~609  | Complete        | Full HTTP-backed key-value store with RAM cache + debounced writes                         |
| `DashboardManager.ts`     | ~180  | Complete        | `showText()`, `clear()`                                                                    |
| `TimeUtils.ts`            | ~275  | Complete        | `now()`, `toLocal()`, `format()`, `zone`                                                   |

### Server Layer ✅

| File                                           | Lines | Status   | Notes                                                                                           |
| ---------------------------------------------- | ----- | -------- | ----------------------------------------------------------------------------------------------- |
| `src/MiniAppServer.ts`                         | ~130  | Complete | Extends `AppServer`, overloaded `onSession`/`onStop`/`onToolCall`, delegates to v3 runtime      |
| `src/internal/_MiniAppServerRuntime.ts`        | ~130  | Complete | Webhook → session lifecycle. **To consolidate into `_SessionManager`** (see decisions.md D-007) |
| `src/internal/_MentraSessionServerFactory.ts`  | ~60   | Complete | Creates MentraSession + WebSocketTransport. **To merge into `_SessionManager`**                 |
| `src/internal/_MiniAppServerCallbackBridge.ts` | ~50   | Complete | Stores handlers. **To rename → `_CallbackManager` or merge into `_SessionManager`**             |
| `src/internal/_MiniAppSessionRegistry.ts`      | ~60   | Complete | Tracks sessions. **To merge into `_SessionManager`**                                            |

### Other ✅

| File                           | Lines      | Status                                                             |
| ------------------------------ | ---------- | ------------------------------------------------------------------ |
| `src/utils/error-utils.ts`     | ~195       | Complete — `toErrorMessage`, `warnOnce`, `safeExec`, `timeout`     |
| `packages/apps/v3-smoke-test/` | ~600 total | Complete — working app using `MiniAppServer` + `MentraSession` API |
| `src/index.ts`                 | updated    | Exports `MiniAppServer` and `MentraSession` alongside v2 exports   |

---

## What's NOT Built

| Item                                | Priority | Notes                                                                                                      |
| ----------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `src/session.ts` entrypoint         | High     | The server-free import path: `import { MentraSession } from "@mentra/sdk/session"`. Needed for local apps. |
| `AppSession` type alias             | High     | `export type AppSession = MentraSession` for v2 import compat                                              |
| `package.json` `"./session"` export | High     | Needs new entry in the `exports` field pointing to `dist/session.js`                                       |

---

## Known Bugs

### 🔴 Must fix before merge

| #   | Location                                                   | Bug                                                                                                                                                                   | Fix                                                                                             |
| --- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1   | `LocationManager.ts`                                       | Memory leak — `onUpdate()` creates a `location_update` router registration whose cleanup is never stored or called                                                    | Store `updateCleanup` in the `Registration` struct and call it in the returned cleanup function |
| 2   | `_SubscriptionManager.ts`                                  | Sends `SUBSCRIPTION_UPDATE` on every single `add()`/`remove()` call. If `onSession` registers 5 subscriptions synchronously, that's 5 WebSocket messages instead of 1 | Add debounce: collect changes within a microtask/tick, send one batched update                  |
| 3   | `_V2SessionShim` (currently `_CompatMentraSessionAdapter`) | Missing ~15 v2 utility methods that real v2 apps use (see list below)                                                                                                 | Add the missing methods as delegations to MentraSession/managers                                |

### 🟡 Should fix

| #   | Location              | Bug                                                                                                                                 | Fix                                                                           |
| --- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 4   | `CameraManager.ts`    | `handleStreamCheckResponse()` uses `.entries().next()` to pop first pending entry regardless of `requestId` — concurrent calls race | Match on `requestId` from response before resolving                           |
| 5   | `SpeakerManager.ts`   | `speak()` builds a relative URL `/api/tts?...` — implicit dependency on cloud resolving it                                          | Validate against actual cloud TTS handler; may need absolute URL construction |
| 6   | `DataStreamRouter.ts` | `deriveSubscriptions()` is exported but never called — dead code                                                                    | Either wire it into `_SubscriptionManager.sync()` or delete it                |

---

## Missing V2 Compat Methods

These methods exist on the old `AppSession` but are NOT on `_V2SessionShim`. Needed for backward compatibility:

| Method                              | Delegates to                                                                  | Effort   |
| ----------------------------------- | ----------------------------------------------------------------------------- | -------- |
| `subscribe(stream)`                 | `_SubscriptionManager.add()` + handle `LocationStreamRequest`                 | Low      |
| `unsubscribe(stream)`               | `_SubscriptionManager.remove()`                                               | Low      |
| `on(event, handler)`                | Route through `_V2EventManagerShim.on()`                                      | Low      |
| `getSettings()`                     | `session.settingsData`                                                        | Trivial  |
| `getSetting(key)`                   | `_V2SettingsShim.get(key)`                                                    | Trivial  |
| `setSubscriptionSettings(opts)`     | Complex — settings-based subscription auto-update                             | Medium   |
| `getConfig()`                       | `session.appConfig`                                                           | Trivial  |
| `loadConfigFromJson(json)`          | Parse + validate + store on session                                           | Low      |
| `getServerUrl()`                    | `session.getServerUrl()`                                                      | Trivial  |
| `getHttpsServerUrl()`               | Convert WS URL → HTTPS                                                        | Low      |
| `getDefaultSettings()`              | Read from `appConfig.settings`                                                | Low      |
| `getSettingSchema(key)`             | Read from `appConfig.settings`                                                | Low      |
| `getWifiStatus()`                   | `session.device.state.wifiConnected.value`                                    | Low      |
| `isWifiConnected()`                 | `session.device.state.wifiConnected.value === true`                           | Trivial  |
| `requestWifiSetup(reason)`          | `session.device.requestWifiSetup(reason)`                                     | Trivial  |
| `onGlassesConnectionState(handler)` | `session.device.state.connected.onChange()`                                   | Low      |
| `subscribeToGestures(gestures)`     | `session.device.subscribeToGestures(gestures)`                                | Trivial  |
| `sendMessage(msg)`                  | `session.sendMessage(msg)`                                                    | Trivial  |
| `sendBinary(data)`                  | `session.sendBinary(data)`                                                    | Trivial  |
| `connect(sessionId)`                | Already handled by `_SessionManager` — may not be needed on the shim          | Evaluate |
| `capabilities` (property)           | `session.capabilities`                                                        | Trivial  |
| `_audioStreamReadyHandlers`         | Internal to SpeakerManager now — may need bridge for AudioOutputStream compat | Evaluate |

---

## Renames Pending

These renames were decided in this conversation (see `decisions.md` D-005, D-006, D-007) but have NOT been applied to the code yet:

| Current file                         | New name                                                           | Decision    |
| ------------------------------------ | ------------------------------------------------------------------ | ----------- |
| `_CompatMentraSessionAdapter.ts`     | `_V2SessionShim.ts`                                                | D-006       |
| `_CompatEventManagerAdapter.ts`      | `_V2EventManagerShim.ts`                                           | D-006       |
| `_CompatCameraAdapter.ts`            | `_V2CameraShim.ts`                                                 | D-006       |
| `_CompatSettingsAdapter.ts`          | `_V2SettingsShim.ts`                                               | D-006       |
| `_CompatAudioOutputStreamAdapter.ts` | `_V2AudioStreamShim.ts`                                            | D-006       |
| `_SessionLifecycleManager.ts`        | `_ConnectionManager.ts`                                            | D-005       |
| `_MiniAppServerRuntime.ts`           | Merge into `_SessionManager.ts`                                    | D-007       |
| `_MentraSessionServerFactory.ts`     | Merge into `_SessionManager.ts`                                    | D-007       |
| `_MiniAppServerCallbackBridge.ts`    | Merge into `_SessionManager.ts` or rename to `_CallbackManager.ts` | D-005/D-007 |
| `_MiniAppSessionRegistry.ts`         | Merge into `_SessionManager.ts`                                    | D-007       |

---

## Compatibility Risk: CONNECTION_INIT Handshake

**This is the #1 risk for v3 working against the current cloud.**

The v3 `MentraSession.sendConnectionInit()` sends:

```json
{"type": "tpa_connection_init", "packageName": "...", "apiKey": "...", "sdkVersion": "3.0.0", "timestamp": "..."}
```

The v2 `AppSession.sendConnectionInit()` sends:

```json
{
  "type": "tpa_connection_init",
  "sessionId": "user@email.com-com.example.app",
  "packageName": "...",
  "apiKey": "...",
  "timestamp": "..."
}
```

The v3 version does **not send `sessionId`**. The current cloud's `bun-websocket.ts` parses `sessionId` from `CONNECTION_INIT` to extract the userId on the legacy path. However, the v3 factory (`_MentraSessionServerFactory`) passes `userId` via HTTP headers (`x-user-id`, `x-session-id`) during WebSocket upgrade. This works IF the cloud supports header-based auth for the app WebSocket path.

**Must verify:** Does the cloud's app WebSocket upgrade handler check for `x-user-id` / `x-session-id` headers? The `handleAppUpgrade` in `bun-websocket.ts` may or may not support this. If it only supports JWT auth or `CONNECTION_INIT` parsing, the v3 SDK will fail to authenticate.

---

## What To Do Next (Priority Order)

1. **Verify the handshake works** — test `MiniAppServer` + `MentraSession` against the real cloud. This validates or invalidates the entire approach. If headers don't work, we need to add `sessionId` back to `CONNECTION_INIT`.
2. **Fix the three must-fix bugs** — LocationManager leak, SubscriptionManager batching, missing v2 compat methods.
3. **Apply the renames** — `_Compat*` → `_V2*Shim`, consolidate factory/registry/manager.
4. **Create `src/session.ts`** entrypoint + update `package.json` exports.
5. **Run the smoke test end-to-end** against cloud-debug.
6. **Verify v2 compat** — run the captions app or sdk-test app against `MiniAppServer` and confirm it works with zero code changes.

---

## File Structure (Current)

```
packages/sdk/src/
├── index.ts                          # Updated — exports MiniAppServer + MentraSession
├── MiniAppServer.ts                  # v3 server host (extends AppServer)
├── display-utils.ts                  # Unchanged
│
├── internal/                         # Server-level internals (to consolidate)
│   ├── _MiniAppServerRuntime.ts      # → merge into _SessionManager
│   ├── _MentraSessionServerFactory.ts # → merge into _SessionManager
│   ├── _MiniAppServerCallbackBridge.ts # → merge into _SessionManager
│   └── _MiniAppSessionRegistry.ts    # → merge into _SessionManager
│
├── transport/
│   ├── Transport.ts                  # Interface (no server deps)
│   └── WebSocketTransport.ts         # ws wrapper (only ws import)
│
├── session/
│   ├── index.ts                      # Re-exports MentraSession
│   ├── MentraSession.ts              # Core orchestrator (~340 lines)
│   ├── DataStreamRouter.ts           # Two-level message dispatch
│   ├── internal/
│   │   ├── _MessageRouter.ts
│   │   ├── _SessionLifecycleManager.ts  # → rename _ConnectionManager
│   │   ├── _SubscriptionManager.ts
│   │   ├── _CompatMentraSessionAdapter.ts  # → rename _V2SessionShim
│   │   ├── _CompatEventManagerAdapter.ts   # → rename _V2EventManagerShim
│   │   ├── _CompatCameraAdapter.ts         # → rename _V2CameraShim
│   │   ├── _CompatSettingsAdapter.ts       # → rename _V2SettingsShim
│   │   └── _CompatAudioOutputStreamAdapter.ts # → rename _V2AudioStreamShim
│   └── managers/
│       ├── TranscriptionManager.ts
│       ├── TranslationManager.ts
│       ├── DisplayManager.ts
│       ├── SpeakerManager.ts
│       ├── MicManager.ts
│       ├── CameraManager.ts
│       ├── DeviceManager.ts
│       ├── PhoneManager.ts
│       ├── PermissionsManager.ts
│       ├── LocationManager.ts
│       ├── LedManager.ts
│       ├── StorageManager.ts
│       ├── DashboardManager.ts
│       └── TimeUtils.ts
│
├── app/                              # OLD v2 code (still used by MiniAppServer compat)
│   ├── server/index.ts               # AppServer (v2)
│   ├── session/index.ts              # AppSession (v2)
│   ├── session/events.ts             # EventManager (v2)
│   ├── session/layouts.ts            # LayoutManager (v2)
│   ├── session/settings.ts           # SettingsManager (v2)
│   ├── session/dashboard.ts          # DashboardManager (v2)
│   ├── session/device-state.ts       # DeviceState (v2)
│   ├── session/modules/              # v2 modules
│   ├── token/
│   └── webview/
│
├── utils/
│   ├── error-utils.ts                # NEW
│   ├── Observable.ts                 # Unchanged (used by DeviceManager)
│   └── ...existing utils
│
├── types/                            # Updated with new message types
├── logging/                          # Unchanged
└── constants/                        # Unchanged
```

---

## Related Documents

| Document                          | Purpose                        | Status                                   |
| --------------------------------- | ------------------------------ | ---------------------------------------- |
| `decisions.md`                    | Every decision with rationale  | Living — update as decisions are made    |
| `private-runtime-architecture.md` | Internal architecture spec     | Needs update to reflect naming decisions |
| `docs-update-spec.md`             | Plan for developer-facing docs | Forward-looking, still valid             |
| `sdk-release-sop.md`              | Release process                | Forward-looking, still valid             |
| `sdk-cicd-plan.md`                | CI/CD pipeline plan            | Forward-looking, still valid             |
| `archive/`                        | Pre-implementation spikes      | Design rationale, not current specs      |
