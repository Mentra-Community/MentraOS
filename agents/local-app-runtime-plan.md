# Local Miniapp Runtime — Implementation Plan

## Goal

Enable third-party mini apps to run locally on the phone (in WebViews inside MentraOS, or external browsers as fallback). Eliminate the cloud hop for display, events, and hardware access. Developers build a static web bundle, ship it as a ZIP, the phone loads it into a WebView, and it talks directly to glasses through the phone.

This mirrors how offline captions works today — the phone consumes events locally and handles routing internally. The cloud has no knowledge of local miniapps.

## Architecture Overview

Two parallel paradigms living side by side:

```
┌─ CLOUD APPS (existing) ────────────────────────────────────┐
│                                                             │
│   App Server                                                │
│   (Node/Bun, uses @mentra/sdk)                              │
│       |                                                     │
│       | WebSocket                                           │
│       v                                                     │
│   MentraOS Cloud                                            │
│       |                                                     │
│       | WebSocket                                           │
│       v                                                     │
│   Phone App ────────> CoreModule / BLE ────> Glasses        │
│                                                             │
└─────────────────────────────────────────────────────────────┘

┌─ LOCAL MINIAPPS (new) ─────────────────────────────────────┐
│                                                             │
│   WebView in MentraOS   |   Safari/Chrome (fallback)        │
│   (uses @mentra/miniapp)|   (uses @mentra/miniapp)          │
│       |                 |       |                           │
│       | postMessage     |       | ws://127.0.0.1:8765       │
│       v                 |       v                           │
│     LocalMiniappRuntime (on phone)                          │
│         |                                                   │
│         v                                                   │
│     CoreModule / BLE ──────────────> Glasses                │
│         |                                                   │
│         | (for STT/translation only)                        │
│         v                                                   │
│     MentraOS Cloud                                          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Packages

| Package                 | Runs in                                    | Purpose                                                                                                                                                                                           | Status                                                                                                                                                                                                                                            |
| ----------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@mentra/sdk`           | Node/Bun (server)                          | Cloud apps — AppServer, AppSession, layouts, events                                                                                                                                               | Runtime untouched. One additive type change in Phase 2.5: a new `GlassesToCloudMessageType.PHONE_SUBSCRIPTION_UPDATE` enum value and matching interface in `cloud/packages/sdk/src/types/`. No existing cloud app uses these, no behavior change. |
| `@mentra/react`         | Browser (existing cloud webview frontends) | Published `@mentra/react` 2.1.2 exports `MentraAuthProvider` and `useMentraAuth` only.                                                                                                            | Published exports stay intact. The unpublished in-branch `useMentraBridge.ts` is deleted.                                                                                                                                                         |
| `@mentra/miniapp`       | Browser / WebView                          | NEW. Local miniapp SDK with React hooks. Browser-native from day one. Defines its own wire protocol enum values in `src/protocol.ts` — no runtime dependency on `@mentra/sdk`.                    | Created by this plan.                                                                                                                                                                                                                             |
| `create-mentra-miniapp` | Dev machine                                | NEW. Scaffolder CLI — generates a Bun Fullstack + React + `@mentra/miniapp` project from a template.                                                                                              | Created by this plan.                                                                                                                                                                                                                             |
| `@mentra/miniapp-cli`   | Dev machine                                | NEW. Dev helper (`mentra-miniapp dev` wraps Bun Fullstack, detects LAN IP, prints QR) and packager (`mentra-miniapp pack` builds a distributable ZIP from `dist/` + `miniapp.json` + `icon.png`). | Created by this plan.                                                                                                                                                                                                                             |

**Invariants:**

- `@mentra/miniapp` is a new package. `@mentra/sdk` is not refactored. Runtime untouched; only additive type additions in `cloud/packages/sdk/src/types/` for the new phone-subscription wire message (Phase 2.5).
- Wire protocol for `@mentra/miniapp` uses fresh `miniapp_*` values defined in `@mentra/miniapp/src/protocol.ts` (Phase 1.3). `LocalMiniappRuntime` translates between miniapp-protocol names and any legacy cloud values at the boundary.
- One package, not two: React hooks live at `@mentra/miniapp/react` as a subpath export. Imperative API (`MiniappSession`) is the default export. React is an optional peer dep.
- Existing cloud apps on `@mentra/sdk` keep working unchanged throughout Phases 1-5.

## Service Map

How each SDK feature maps onto local miniapps.

### Direct on phone (no cloud)

| Service                   | Implementation                                                                                                                                                                                                                                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Display                   | `displayProcessor.processDisplayEvent()` → `CoreModule.displayEvent()`. Same path as `SocketComms.handle_display_event()`.                                                                                                                                                                                                                |
| LED control               | Reuse `SocketComms.handle_rgb_led_control()` → `CoreModule.rgbLedControl(requestId, packageName, action, ...)`.                                                                                                                                                                                                                           |
| Camera FOV/ROI            | Reuse `SocketComms.handle_camera_fov_set()` → updates FOV via `useSettingsStore` (not CoreModule).                                                                                                                                                                                                                                        |
| Audio playback            | `audioPlaybackService.play({audioUrl})` directly. Phone plays via expo-audio, audio routes to glasses as BT A2DP headphones. Same path as `SocketComms.handle_audio_play_request()`.                                                                                                                                                      |
| Audio stop                | `audioPlaybackService.stopForApp(packageName)`. Same as `SocketComms.handle_audio_stop_request()`.                                                                                                                                                                                                                                        |
| Button / touch events     | CoreModule listener → LocalMiniappRuntime → subscribed miniapps.                                                                                                                                                                                                                                                                          |
| Head position             | CoreModule IMU listener.                                                                                                                                                                                                                                                                                                                  |
| Battery (glasses + phone) | Already in glasses/battery stores.                                                                                                                                                                                                                                                                                                        |
| Connection state          | Already in glasses store.                                                                                                                                                                                                                                                                                                                 |
| VAD (voice activity)      | CoreModule detects locally. `SocketComms.sendVadStatus()` currently sends to cloud, but origin is local.                                                                                                                                                                                                                                  |
| Audio chunks (raw mic)    | CoreModule receives mic data (glasses over BLE or phone mic — same path). Phone already has raw audio.                                                                                                                                                                                                                                    |
| Location                  | `expo-location` via `MantleManager`.                                                                                                                                                                                                                                                                                                      |
| Phone notifications       | CoreModule notification listener.                                                                                                                                                                                                                                                                                                         |
| Calendar events           | `expo-calendar`.                                                                                                                                                                                                                                                                                                                          |
| Simple Storage            | Phone-local AsyncStorage keyed by `(userId, packageName, key)`. No cloud sync.                                                                                                                                                                                                                                                            |
| Dashboard                 | **Deferred in v1.** `session.dashboard.setContent()` noops with a console warning. Cloud `DashboardManager` is 825 lines with OS-owned notification ranking, weather, calendar, and multi-profile column layout — too complex to port to phone for v1. Local miniapps use `layouts.showTextWall()` for their own display. See Phase 2.14. |

### Cloud-proxied through phone

The phone subscribes to these cloud services as if it were an app, on behalf of local miniapps.

| Service        | How                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Speech-to-Text | Phone sends `SUBSCRIPTION_UPDATE` for `transcription:*` to cloud over its existing WebSocket. Cloud routes transcription data back to phone. Phone demuxes to local miniapps. Aggregated — 3 miniapps wanting `transcription:en-US` = 1 cloud subscription.                                                                                                                              |
| Translation    | Same pattern as STT, for `translation:*`.                                                                                                                                                                                                                                                                                                                                                |
| TTS            | Mini app calls `session.audio.speak(text, options)` → bridge sends `SPEAK_REQUEST` with text + voice options → LocalMiniappRuntime constructs the cloud TTS URL (phone has cloudUrl + any auth context; miniapp has neither) → `audioPlaybackService.play({audioUrl})` → phone streams MP3 from cloud → BT A2DP to glasses → phone sends completion response back to miniapp via bridge. |
| Telemetry      | Cloud requests logs from app for incident debugging. Cloud sends request via SocketComms → LocalMiniappRuntime forwards to local miniapp → miniapp responds.                                                                                                                                                                                                                             |

### Deferred to Phase 5

| Service                                | Behavior before Phase 5                                                      |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| Photo capture                          | Noop + warning. See Phase 5.                                                 |
| Managed streaming                      | Noop + warning. See Phase 5.                                                 |
| Unmanaged streaming                    | Noop + warning. See Phase 5.                                                 |
| Audio output streaming (binary chunks) | Noop + warning. v1 uses URL-based playback via `AUDIO_PLAY_REQUEST` instead. |

---

## Phase 1: `@mentra/miniapp` Package

**Goal:** Create a new, purpose-built, browser-native SDK for local miniapps. `@mentra/sdk` is not modified.

**Constraints:**

- Every file must run in a WebView / browser JavaScript engine. No `Buffer`, no `process`, no `fs`, no `ws`, no Jimp, no pino. Build target: `browser` / `neutral`.
- Zero runtime dependency on `@mentra/sdk`. All wire protocol enum values are defined in `@mentra/miniapp/src/protocol.ts` (Phase 1.3).
- Non-wire shared types (`Capabilities`, `AppletInterface`, `HardwareType`, etc.) are imported from `@mentra/types` via `import type`.

### 1.1 Package Location and Structure

Create `sdk/miniapp/` (or `mobile/packages/miniapp/` if the monorepo layout prefers mobile-adjacent packages — pick one and stick with it).

```
sdk/miniapp/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                    # Public API: MiniappSession + types
│   ├── session.ts                  # MiniappSession class (imperative API)
│   ├── protocol.ts                 # Wire protocol enums (miniapp-naming, fresh)
│   ├── envelope.ts                 # Bridge envelope format {kind, payload, requestId}
│   ├── transport/
│   │   ├── types.ts                # Transport interface
│   │   ├── postmessage.ts          # WebView postMessage transport
│   │   ├── local-socket.ts         # Browser WebSocket transport
│   │   └── auto.ts                 # Auto-detection
│   ├── modules/
│   │   ├── layouts.ts              # LayoutManager (text wall, card, etc.)
│   │   ├── events.ts               # EventManager with eventemitter3
│   │   ├── audio.ts                # speak(), play()
│   │   ├── camera.ts               # takePhoto() — noop in v1
│   │   ├── dashboard.ts            # DashboardAPI — noop in v1 (deferred)
│   │   ├── led.ts                  # rgbLedControl
│   │   └── storage.ts              # SimpleStorage (on-device via bridge)
│   └── react/
│       ├── index.ts                # Export React hooks
│       ├── useSession.ts           # Zero-config hook
│       └── ...                     # Additional hooks (see 1.9)
└── dist/                           # Build output
```

### 1.2 `package.json`

```json
{
  "name": "@mentra/miniapp",
  "version": "0.1.0",
  "description": "SDK for building MentraOS local miniapps",
  "type": "module",
  "main": "./dist/index.js",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    },
    "./react": {
      "import": "./dist/react/index.js",
      "types": "./dist/react/index.d.ts"
    },
    "./protocol": {
      "import": "./dist/protocol.js",
      "types": "./dist/protocol.d.ts"
    }
  },
  "sideEffects": false,
  "peerDependencies": {
    "react": ">=18.0.0"
  },
  "peerDependenciesMeta": {
    "react": {"optional": true}
  },
  "dependencies": {
    "@mentra/types": "1.0.0-beta.2",
    "eventemitter3": "^5.0.1"
  }
}
```

- React is an optional peer dep. Hooks live at `@mentra/miniapp/react` and only load when imported.
- `sideEffects: false` — tree-shakable.
- Build target: browser-compatible ES modules.
- `@mentra/types` is pinned to published semver, not `workspace:*`, because `mobile/` is not inside the `cloud/` monorepo workspace. Bumping `@mentra/types` requires publishing before updating this pin.
- `./protocol` subpath export is mandatory: `LocalMiniappRuntime` (mobile) imports `MiniappRequestType` from `@mentra/miniapp/protocol`.

### 1.3 Protocol (`src/protocol.ts`)

Fresh enum definitions for the miniapp wire protocol. No inheritance of legacy `tpa_*` naming. These values are the contract between `@mentra/miniapp` and `LocalMiniappRuntime` on the phone.

```typescript
// Miniapp → phone (request, via bridge envelope)
export enum MiniappRequestType {
  CONNECT = "miniapp_connect", // replaces tpa_connection_init
  SUBSCRIBE = "miniapp_subscribe", // replaces subscription_update
  DISPLAY = "miniapp_display", // replaces display_event
  PLAY_AUDIO = "miniapp_play_audio", // replaces audio_play_request
  STOP_AUDIO = "miniapp_stop_audio", // replaces audio_stop_request
  SPEAK = "miniapp_speak", // NEW: phone constructs TTS URL
  RGB_LED = "miniapp_rgb_led",
  LOCATION_POLL = "miniapp_location_poll",
  STORAGE_GET = "miniapp_storage_get",
  STORAGE_SET = "miniapp_storage_set",
  STORAGE_DELETE = "miniapp_storage_delete",
  STORAGE_LIST = "miniapp_storage_list",
  CAMERA_FOV = "miniapp_camera_fov", // trivial settings write, works in v1
  PING = "miniapp_ping", // phone → miniapp liveness probe (Phase 2.12a)
  // Noop in v1 (deferred — see Phase 2.14):
  DASHBOARD_CONTENT_UPDATE = "miniapp_dashboard_content_update",
  // Phase 5 (noop for now):
  PHOTO = "miniapp_photo",
  STREAM_START = "miniapp_stream_start",
  STREAM_STOP = "miniapp_stream_stop",
  MANAGED_STREAM_START = "miniapp_managed_stream_start",
  MANAGED_STREAM_STOP = "miniapp_managed_stream_stop",
}

// Phone → miniapp (response or push)
export enum MiniappResponseType {
  CONNECT_ACK = "miniapp_connect_ack", // response to CONNECT with userId, capabilities
  EVENT = "miniapp_event", // push: streamed event for a subscription
  REQUEST_RESULT = "miniapp_request_result", // response to any request that needs a result
  CAPABILITIES_UPDATE = "miniapp_capabilities_update", // push: glasses changed
  VISIBILITY_CHANGE = "miniapp_visibility_change", // push: foreground ↔ background (Phase 2.12a)
  PONG = "miniapp_pong", // reply to PING (Phase 2.12a, SDK auto-handles)
  ERROR = "miniapp_error", // async error
}

// Stream types a miniapp can subscribe to (fresh naming)
export enum MiniappStreamType {
  BUTTON_PRESS = "button_press",
  TOUCH_EVENT = "touch_event",
  HEAD_POSITION = "head_position", // NB: translated from CoreModule "head_up"
  GLASSES_BATTERY = "glasses_battery",
  PHONE_BATTERY = "phone_battery",
  GLASSES_CONNECTION = "glasses_connection",
  TRANSCRIPTION = "transcription", // language variant: "transcription:en-US"
  TRANSLATION = "translation", // language variant: "translation:en-US"
  AUDIO_CHUNK = "audio_chunk",
  VAD = "vad", // NB: lowercase in miniapp protocol; translated to legacy "VAD" uppercase if needed
  LOCATION_UPDATE = "location_update",
  PHONE_NOTIFICATION = "phone_notification",
  CALENDAR_EVENT = "calendar_event",
  // Phase 5:
  PHOTO_TAKEN = "photo_taken",
  STREAM_STATUS = "stream_status",
}
```

**Translation layer:** `LocalMiniappRuntime` translates between `MiniappStreamType` and legacy cloud / CoreModule names at the boundary. Language-suffixed transcription (`transcription:en-US`) is already consistent between cloud and miniapp so no translation is needed for it. CoreModule event name mappings are listed in Phase 2.6.

### 1.4 Transport Interface

`src/transport/types.ts`:

```typescript
export interface Transport {
  connect(initMessage: object): Promise<ConnectionAck>
  send(message: object): void
  onMessage(handler: (message: object) => void): void
  onDisconnect(handler: (reason: string) => void): void
  disconnect(): void
  isConnected(): boolean
}
```

### 1.5 PostMessageTransport

`src/transport/postmessage.ts` — for WebView miniapps inside MentraOS.

- `send()` → `window.ReactNativeWebView.postMessage(JSON.stringify(envelope))`
- `onMessage()` → assigns `window.receiveNativeMessage = handler`
- No network involved — just the existing MentraOS WebView bridge
- Read `window.MentraOS.packageName`, `window.MentraOS.userId`, and glasses capabilities from the injected globals

### 1.6 LocalSocketTransport

`src/transport/local-socket.ts` — for external-browser fallback.

- Uses browser-native `new WebSocket('ws://127.0.0.1:8765')`
- Same envelope protocol as postMessage
- Used when the SDK detects it's in a browser that isn't inside a MentraOS WebView

### 1.7 Auto-Detection

`src/transport/auto.ts`:

```typescript
export function createTransport(): Transport {
  if (typeof window !== "undefined" && window.ReactNativeWebView && window.MentraOS) {
    return new PostMessageTransport()
  }
  if (typeof window !== "undefined" && typeof window.WebSocket !== "undefined") {
    return new LocalSocketTransport()
  }
  throw new Error("@mentra/miniapp requires a browser environment")
}
```

### 1.8 MiniappSession — Imperative API

`src/session.ts`. Purpose-built session class for local miniapps. Does NOT include:

- App server references
- Server-side auth / API keys
- Cloud WebSocket reconnection logic
- Bitmap conversion (phone SGCs handle it)
- Telemetry upload
- Session IDs / packageName validation (phone provides these via injected globals)

Shape:

```typescript
export class MiniappSession {
  public readonly layouts: LayoutManager
  public readonly events: EventManager
  public readonly audio: AudioModule
  public readonly camera: CameraModule
  public readonly dashboard: DashboardAPI
  public readonly led: LedModule
  public readonly storage: SimpleStorage
  public readonly capabilities: Capabilities | null
  public readonly userId: string
  public readonly packageName: string

  // Visibility state (Phase 2.12a). Backgrounded miniapps keep running but may
  // want to throttle their own animations. Event handlers still fire regardless.
  public readonly visibility: "foreground" | "background"
  onVisibilityChange(handler: (v: "foreground" | "background") => void): () => void

  constructor(transport?: Transport) // optional — defaults to auto-detect
  async connect(): Promise<void> // sends CONNECT, resolves on CONNECT_ACK
  disconnect(): void
  isConnected(): boolean
}
```

No config required. Zero-config. `packageName` and `userId` come from the bridge / injected globals at connect time.

The SDK auto-handles `MiniappRequestType.PING` by replying with `PONG` — developers never see the ping loop. See Phase 2.12a for why it exists.

### 1.9 Modules

- **`LayoutManager`** — `showTextWall`, `showDoubleTextWall`, `showReferenceCard`, `showDashboardCard`, `showBitmapView` (passthrough — phone SGC does conversion), `showBitmapAnimation`, `clearView`. Each method constructs a bridge envelope with `type: MiniappRequestType.DISPLAY` and a payload describing the layout (layoutType, view, text fields, etc.) and calls `transport.send()`. No Jimp. Shared layout payload types are imported from `@mentra/types`.
- **`EventManager`** — `onTranscription`, `onButtonPress`, `onHeadPosition`, `onLocation`, `onPhoneNotification`, `onCalendarEvent`, `onVoiceActivity`, etc. Backed by `eventemitter3`. Subscribe sends `MiniappRequestType.SUBSCRIBE` with the new full subscription list; unsubscribe sends an updated list. Ref-counted internally so multiple handlers for the same stream collapse to one subscription.
- **`AudioModule`** — `play({audioUrl, volume?, stopOtherAudio?})`, `speak(text, options?)`, `stop()`. `speak()` sends a `MiniappRequestType.SPEAK` request over the bridge with `{text, voice_id?, voice_settings?, volume?, stopOtherAudio?}`. The phone's `LocalMiniappRuntime` constructs the actual cloud TTS URL and plays it. The miniapp SDK does NOT know or care about `cloudUrl` — that's a phone concern. `play({audioUrl})` sends `MiniappRequestType.PLAY_AUDIO` with the URL as-is for arbitrary audio. No binary audio streaming in v1.
- **`CameraModule`** — `takePhoto(options)`. V1 noop + console.warn (deferred to Phase 5).
- **`DashboardAPI`** — `setContent(mode, content)`. **V1: noop + console.warn** ("Dashboard API is deferred in v1"). The API surface exists so miniapp developers don't get TypeScript errors, but calls do nothing. See Phase 2.14.
- **`LedModule`** — `setColor(action, color, options)`. Sends `MiniappRequestType.RGB_LED`.
- **`SimpleStorage`** — `get(key)`, `set(key, value)`, `delete(key)`, `list()`. Sends `MiniappRequestType.STORAGE_GET` / `STORAGE_SET` / `STORAGE_DELETE` / `STORAGE_LIST` over the bridge to LocalMiniappRuntime, which reads/writes phone-local AsyncStorage. See Phase 2.13.
- **`SystemModule`** — `share(options)`, `openUrl(url)`, `copyToClipboard(text)`, `download(options)`. Sends `MiniappRequestType.SHARE` / `OPEN_URL` / `COPY_CLIPBOARD` / `DOWNLOAD`. Replaces the legacy bridge handlers that were previously in MiniComms. Handlers in LocalMiniappRuntime use `react-native-share`, `Linking`, `expo-clipboard`, and `expo-file-system`.

### 1.10 React Hooks

V1 ships only `useSession`. Event-specific hooks (`useTranscription`, `useButtonPress`) are not implemented; developers call `session.events.onXxx()` from a `useEffect`.

`src/react/useSession.ts`:

```typescript
let sharedSession: MiniappSession | null = null

export function useSession(): MiniappSession {
  const [session] = useState(() => {
    if (!sharedSession) {
      sharedSession = new MiniappSession()
      sharedSession.connect()
    }
    return sharedSession
  })
  return session
}
```

**Readiness and queueing contract on `MiniappSession`:**

- Exposes `session.ready: boolean`, `session.waitForReady(): Promise<void>`, and a `"ready"` / `"error"` event emitter channel.
- Before `CONNECT_ACK` is received, every `transport.send()` call is buffered in an in-memory FIFO queue. No dropping, no throwing.
- On `CONNECT_ACK`: queue flushes in FIFO order, `ready` flips to `true`, `"ready"` event fires.
- On connect failure (transport error or `CONNECT_ACK` timeout after 10s): `ready` stays `false`, `"error"` event fires, queued calls reject with `NotConnectedError`, subsequent calls reject immediately.
- Pushed events (`MiniappResponseType.EVENT`) are emitted to subscribers only after `CONNECT_ACK`. Pre-ACK there are no subscriptions to queue against.

`src/react/index.ts` exports `useSession` only. The package `exports` map exposes this as `@mentra/miniapp/react`.

### 1.11 Build

Single `tsc` step emitting ES modules. No bundling — consumers bundle `@mentra/miniapp` into their own app via Bun Fullstack (or esbuild/Vite/webpack). Ship compiled TypeScript.

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2020", "DOM"],
    "declaration": true,
    "strict": true,
    "outDir": "./dist",
    "jsx": "react-jsx"
  }
}
```

No Node lib, no Node types. Accidental references to `Buffer` or `process` fail the `tsc` build.

### 1.12 Verification

- `@mentra/miniapp` builds cleanly with `tsc`.
- A minimal test miniapp (`index.html` + a script that imports `MiniappSession` and calls `showTextWall`) bundles with Bun Fullstack (`bun run --hot server.ts`) and loads in a browser without errors.
- Existing cloud apps on `@mentra/sdk` continue to run unchanged.

---

## Phase 2: Phone-Side Runtime

**Goal:** The phone app handles local miniapp requests — display, events, subscriptions, hardware — without the cloud being in the path for most operations.

### 2.1 LocalMiniappRuntime Service

Create `mobile/src/services/LocalMiniappRuntime.ts`.

**Ownership and mounting:**

- Singleton (same pattern as MiniComms, SocketComms, MantleManager).
- Initialized lazily on first access, or explicitly during `MantleManager.init()` after `SocketComms` auth creds are set.
- Depends on: `SocketComms` (for cloud subscriptions), `MiniComms` (for postMessage routing to/from WebViews), `CoreModule` (for hardware events), `DisplayProcessor` (for display output), `audioPlaybackService` (for audio).
- On logout/re-auth: `LocalMiniappRuntime.cleanup()` clears connected miniapps, unsubscribes all cloud streams it had requested, and drops the per-miniapp state. `MantleManager.init()` re-instantiates.

**State:**

```typescript
connectedApps: Map<
  packageName,
  {
    transport: "postmessage" | "websocket"
    clientId?: number // MiniSockets client ID if websocket transport
    subscriptions: Set<ExtendedStreamType>
    installedManifest: AppletInterface // from appletStatusStore
    sendMessage: (msg: object) => void
  }
>

// For demuxing cloud subscriptions to multiple local miniapps
streamSubscribers: Map<ExtendedStreamType, Set<packageName>>
```

**Core methods:**

- `registerApp(packageName, transport, sendFn)` — called when handling CONNECT
- `unregisterApp(packageName)` — cleanup subscriptions, remove from state
- `handleMessage(packageName, sdkMessage)` — dispatch SDK messages (display, subscribe, etc.)
- `forwardEvent(streamType, data)` — fan out to subscribed miniapps
- `subscribe(packageName, stream)` / `unsubscribe(packageName, stream)` — update local state + propagate to cloud if needed

### 2.2 Bridge Message Protocol

Every SDK message uses a typed envelope over postMessage / MiniSockets:

```typescript
// Miniapp → phone
{
  kind: "miniapp";                      // only "miniapp" in v1; legacy bridge messages deleted
  payload: MiniappRequest;              // e.g. {type: MiniappRequestType.CONNECT, ...}
  requestId?: string;                   // for request/response pairing
}

// Phone → miniapp
{
  kind: "miniapp";
  payload: MiniappResponse | MiniappPush;  // response to a request, or pushed event
  requestId?: string;                   // echoed from request if this is a response
}
```

**Legacy bridge messages (`share`, `copy_clipboard`, `open_url`, `download`, `core_fn`):** deleted from `MiniComms.ts` and `@mentra/react`. Replaced by `SystemModule` on the miniapp SDK session object:

- `session.system.share({text?, url?, title?, base64?, mimeType?, filename?})` — OS share sheet
- `session.system.openUrl(url)` — opens in system browser (blocks `javascript:` and `file:` schemes)
- `session.system.copyToClipboard(text)` — copies to OS clipboard
- `session.system.download({url?, base64?, filename?, mimeType?})` — download + OS share sheet for save location

Corresponding `MiniappRequestType` values: `SHARE`, `OPEN_URL`, `COPY_CLIPBOARD`, `DOWNLOAD`. Handlers in `LocalMiniappRuntime` port the same logic from the old MiniComms handlers (react-native-share, expo-clipboard, Linking, expo-file-system).

**Response format for request/response pairs** (CONNECT, LOCATION_POLL, PLAY_AUDIO with wait-for-completion, STORAGE_GET/SET/DELETE/LIST, SPEAK):

- Sender includes a `requestId` in the envelope
- Receiver echoes the `requestId` in the response envelope
- SDK's pending-request map resolves the promise by `requestId`

### 2.3 MiniComms Refactor

`MiniComms.ts` becomes the transport layer for postMessage:

- Receive raw strings from WebView `onMessage`
- Parse as envelope (see Phase 2.2)
- Forward SDK messages to `LocalMiniappRuntime.handleMessage(packageName, payload)`

Delete the legacy bridge handlers (`share`, `copy_clipboard`, `download`, `open_url`, `core_fn`) from `MiniComms.ts` and `@mentra/react`'s `useMentraBridge.ts`.

### 2.4 Miniapp Request Handlers

`LocalMiniappRuntime.handleRequest(packageName, request)` dispatches by `MiniappRequestType` (from `@mentra/miniapp/src/protocol.ts`, Phase 1.3). All values are the fresh miniapp-naming wire values — no legacy `tpa_*` prefix.

**Mobile protocol enum import:** add `"@mentra/miniapp": "file:../sdk/miniapp"` to `mobile/package.json`. Mobile then imports `import { MiniappRequestType } from "@mentra/miniapp/protocol"`. Requires `@mentra/miniapp` to be built (`dist/` present) before mobile's TypeScript pass.

| MiniappRequestType                                                | Action                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONNECT` (`miniapp_connect`)                                     | Validate packageName matches the one the phone injected into `window.MentraOS` (miniapp cannot impersonate another package). Register in `connectedApps` map. Respond with `CONNECT_ACK` carrying `{userId, packageName, capabilities}`. No cloud round-trip.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `SUBSCRIBE` (`miniapp_subscribe`)                                 | Update per-app subscription set. Check permissions against the miniapp's declared manifest (Phase 2.16). For cloud-dependent streams (transcription, translation), recompute aggregated phone subscriptions and send `PHONE_SUBSCRIPTION_UPDATE` to cloud if changed. Update `MicStateCoordinator` if mic-requiring streams changed.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `DISPLAY` (`miniapp_display`)                                     | Call `displayProcessor.processDisplayEvent()` → `CoreModule.displayEvent()`. Same path as `SocketComms.handle_display_event()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `PLAY_AUDIO` (`miniapp_play_audio`)                               | `audioPlaybackService.play({requestId, audioUrl, volume, stopOtherAudio, appId: packageName})` with completion callback that sends `REQUEST_RESULT` response back via bridge.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `STOP_AUDIO` (`miniapp_stop_audio`)                               | `audioPlaybackService.stopForApp(packageName)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `SPEAK` (`miniapp_speak`)                                         | LocalMiniappRuntime constructs the cloud TTS URL using its own `cloudUrl` (from `SocketComms` / settings store — phone-side config). URL is `${cloudUrl}/api/audio/tts?text=${encodeURIComponent(text)}&voice_id=...`. Passes it to `audioPlaybackService.play({audioUrl})`. Errors from the cloud TTS endpoint (non-2xx response — text too long, invalid `voice_id`, ElevenLabs upstream failure, quota) are parsed and forwarded to the miniapp as `REQUEST_RESULT` with `{ok: false, error: {code, message}}`. Success path returns `{ok: true}` after audio playback completes. The miniapp's `session.audio.speak()` Promise rejects with the error object on failure so callers can branch on `error.code` (e.g., `TTS_TEXT_TOO_LONG`, `TTS_INVALID_VOICE`, `TTS_UPSTREAM_ERROR`). |
| `RGB_LED` (`miniapp_rgb_led`)                                     | Reuse the same code path as `SocketComms.handle_rgb_led_control()` → `CoreModule.rgbLedControl(requestId, packageName, action, color, ontime, offtime, count)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `LOCATION_POLL` (`miniapp_location_poll`)                         | Check `LOCATION` permission against miniapp manifest. Use `expo-location` to get current position. Return via `REQUEST_RESULT` response envelope.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `STORAGE_GET` / `STORAGE_SET` / `STORAGE_DELETE` / `STORAGE_LIST` | Phone-local AsyncStorage (Phase 2.13). Return results via `REQUEST_RESULT`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `CAMERA_FOV` (`miniapp_camera_fov`)                               | Reuse `SocketComms.handle_camera_fov_set()` path (updates FOV via `useSettingsStore`). Trivial — just a settings write, no hardware orchestration. Works in v1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `PHOTO`                                                           | Noop + console.warn. Deferred to Phase 5 — photos need cloud coordination for upload.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `STREAM_START` / `STREAM_STOP`                                    | Noop + console.warn. Deferred to Phase 5.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `MANAGED_STREAM_START` / `MANAGED_STREAM_STOP`                    | Noop + console.warn. Deferred to Phase 5.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `DASHBOARD_CONTENT_UPDATE`                                        | Noop + console.warn. Deferred in v1 — see Phase 2.14.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

**TTS note:** `session.audio.speak(text, options)` sends a `SPEAK` request, not `PLAY_AUDIO` with a pre-built URL. The miniapp bundle has no `cloudUrl`; URL construction, cloud call, and playback all run on the phone as one operation.

### 2.5 Cloud Stream Subscription (STT, Translation)

The phone subscribes to cloud streams (transcription, translation) under the reserved `packageName = "__phone__"`. Cloud adds a `PhoneSession` to `AppManager`'s session map, iterated by the subscription delivery path alongside real app sessions. Explicit `__phone__` branches in `AppManager.sendMessageToApp` and `SubscriptionManager.processSubscriptionUpdate` handle routing and permission differences.

Delivery reuses the existing `DataStream` message format (`cloud/packages/sdk/src/types/messages/cloud-to-app.ts` line 224): `{type: "data_stream", streamType: "transcription:en-US", data: ...}`. Only one new wire message is added: `PHONE_SUBSCRIPTION_UPDATE` (glasses → cloud direction).

**Cloud-side changes:**

1. **Wire protocol types (additive):**
   - `cloud/packages/sdk/src/types/message-types.ts`: add `GlassesToCloudMessageType.PHONE_SUBSCRIPTION_UPDATE = "phone_subscription_update"`.
   - `cloud/packages/sdk/src/types/messages/glasses-to-cloud.ts`: add `PhoneSubscriptionUpdate` interface `{type, subscriptions: ExtendedStreamType[]}` and add it to the `GlassesToCloudMessage` discriminated union around line 424.

2. **`AppLikeSession` interface** (`cloud/packages/cloud/src/services/session/AppLikeSession.ts`, NEW file):

   `AppSession` has private members (`AppSession.ts:108`), so TypeScript's private-field brands block structural assignability — a standalone `PhoneSession` cannot be stored in the existing `Map<string, AppSession>` at `AppManager.ts:111`. Define a shared interface that both classes implement:

   ```ts
   export interface AppLikeSession {
     packageName: string
     subscriptions: Set<ExtendedStreamType>
     locationRate: LocationRate | null
     state: AppConnectionState
     isDisposed: boolean
     hasSubscription(sub: ExtendedStreamType): boolean
     getSubscriptions(): ExtendedStreamType[]
     updateSubscriptions(subs: ExtendedStreamType[], locationRate?: LocationRate | null): {applied: boolean}
     enqueue<T>(op: () => Promise<T>): Promise<T>
     cleanup(): void
   }
   ```

   - `AppSession` adds `implements AppLikeSession`. No runtime change.
   - `AppManager.apps` is retyped to `Map<string, AppLikeSession>`.
   - Callers needing `AppSession`-only members (heartbeat, resurrection, `webSocket`) narrow via `if (session instanceof AppSession) { ... }`. Such call sites are all real-app code paths and never touch `__phone__`.
   - `SubscriptionManager.processSubscriptionUpdate()` at `SubscriptionManager.ts:240` is widened from `AppSession` to `AppLikeSession` — it only reads interface members on the hot path.

3. **`AppManager.sendMessageToApp()`** (`cloud/packages/cloud/src/services/session/AppManager.ts`):
   - Define `PHONE_PACKAGE_NAME = "__phone__"` constant at the top of the file.
   - Add a branch at the top of `sendMessageToApp()` (before line 1691): if `packageName === PHONE_PACKAGE_NAME`, call new private `sendToPhoneClient(message)` and return.
   - `sendToPhoneClient(message)`: `this.userSession.websocket.send(JSON.stringify(message))`. The existing `userSession.websocket` field is the single phone↔cloud socket (see Phase 2.5a).
   - The existing WebSocket-reading branch (lines 1691-1713) is unchanged for real app sessions.

4. **`PhoneSession` class** (`cloud/packages/cloud/src/services/session/PhoneSession.ts`, NEW file):
   Standalone class `implements AppLikeSession`. Does NOT extend `AppSession` — `AppSession`'s lifecycle methods (`setupHeartbeat`, `startGracePeriod`) are private and not overridable from a subclass.

   Required surface:
   - `packageName: string` — always `"__phone__"`
   - `subscriptions: Set<ExtendedStreamType>`
   - `locationRate: LocationRate | null`
   - `hasSubscription(sub: ExtendedStreamType): boolean`
   - `getSubscriptions(): ExtendedStreamType[]`
   - `updateSubscriptions(newSubs: ExtendedStreamType[], locationRate?: LocationRate | null): { applied: boolean }`
   - `enqueue<T>(op: () => Promise<T>): Promise<T>` — implementation is `return op()`; only the phone submits updates, no serialization needed.
   - `isDisposed: boolean` — `false` until `cleanup()` is called
   - `state: AppConnectionState` — always `RUNNING`
   - `cleanup(): void` — clears the subscription Set on UserSession teardown

   Not implemented: `webSocket`, `handleConnect`/`handleDisconnect`/`startConnecting`/`markStopping`/`markStopped`/`markDormant`/`markResurrecting`, heartbeat, grace period, resurrection.

5. **`AppManager.getOrCreateAppSession()`** (`cloud/packages/cloud/src/services/session/AppManager.ts`):
   - Add explicit branch: if `packageName === PHONE_PACKAGE_NAME`, return a cached `PhoneSession` instance, creating it on first call.
   - Store the `PhoneSession` in `this.apps` alongside real app sessions so iteration paths (e.g., `SubscriptionManager.getSubscribedApps()`) find it. This works because `apps` is now typed as `Map<string, AppLikeSession>`.
   - Audit all methods that iterate `this.apps` and expose state to users (e.g., `getRunningAppNames()`, `getAllAppSessions()` and callers) and add an explicit `packageName !== PHONE_PACKAGE_NAME` filter so the synthetic phone session is not surfaced as a "running app" in user-facing state.

6. **`SubscriptionManager.processSubscriptionUpdate()`** (`cloud/packages/cloud/src/services/session/SubscriptionManager.ts`, around line 271):
   - Add a branch at the top (before the `App.findOne({packageName})` lookup): if `packageName === PHONE_PACKAGE_NAME`, skip the DB permission check and set `allowedProcessed = processed` (accept all requested subscriptions). The phone enforces declared-permission checks itself before sending `PHONE_SUBSCRIPTION_UPDATE`.
   - The rest of the method (storing subscriptions on the session, calling `onSubscriptionsChanged`) runs normally.

7. **`glasses-message-handler.ts`** (`cloud/packages/cloud/src/services/session/handlers/`):
   - Add a case for `GlassesToCloudMessageType.PHONE_SUBSCRIPTION_UPDATE`:
     - `userSession.appManager.getOrCreateAppSession(PHONE_PACKAGE_NAME)` (idempotent — creates on first use)
     - `userSession.subscriptionManager.updateSubscriptions(PHONE_PACKAGE_NAME, message.subscriptions)`

8. **Delivery path — no changes to `TranscriptionManager` / `TranslationManager`:** they already iterate subscribers via `SubscriptionManager.getSubscribedApps()` (line 76) and call `appManager.sendMessageToApp(packageName, dataStreamMsg)`. When `__phone__` is in the subscriber list, the step 3 branch routes to the client WebSocket automatically.

**`DataStream` message shape** (`cloud/packages/sdk/src/types/messages/cloud-to-app.ts` line 224, unchanged — already exists):

```typescript
interface DataStream extends BaseMessage {
  type: CloudToAppMessageType.DATA_STREAM // wire value: "data_stream"
  streamType: ExtendedStreamType // e.g. "transcription:en-US"
  data: unknown // shape depends on streamType
}
```

`TranscriptionManager` constructs messages in this shape today and sends them via `appManager.sendMessageToApp(subscriber, message)`. When `subscriber === __phone__`, the branch from step 2 above routes the message to the phone's client WebSocket.

**Phone-side flow:**

1. Local miniapp calls `session.events.onTranscription('en-US', handler)`.
2. `@mentra/miniapp` sends `MiniappRequestType.SUBSCRIBE` via bridge with stream list including `"transcription:en-US"`.
3. `LocalMiniappRuntime.handleSubscription()`:
   - Checks the miniapp's declared manifest permissions for mic-requiring streams (`MICROPHONE` in `miniapp.json`).
   - If denied: send `MiniappResponseType.ERROR` via bridge.
   - If allowed: add `transcription:en-US` to the app's subscriptions and to the aggregated `streamSubscribers: Map<stream, Set<packageName>>`.
4. `LocalMiniappRuntime.recomputeMicRequirements()` calls `MicStateCoordinator.setLocalRequirements({ lc3: true })`.
5. `LocalMiniappRuntime` recomputes the aggregated subscription list and calls `socketComms.updatePhoneSubscriptions(aggregatedStreams)`.
6. `SocketComms` sends `PHONE_SUBSCRIPTION_UPDATE` over the client WebSocket with the full current list.
7. Cloud handles it per steps 5-6 of the Cloud-side changes above.
8. `TranscriptionManager` delivers transcription data to `__phone__` via the existing subscriber iteration; data flows over the client WebSocket as a `data_stream` message.
9. `SocketComms.handle_message()` routes `data_stream` → `localMiniappRuntime.forwardEvent(msg.streamType, msg.data)`.
10. `LocalMiniappRuntime` fans out to all subscribed miniapps via their bridge transport.

**Unsubscribe:** when the last local miniapp unsubscribes from a stream, `LocalMiniappRuntime` recomputes the aggregated list, calls `socketComms.updatePhoneSubscriptions()` with the new list, and calls `recomputeMicRequirements()`. If no miniapp needs mic, `MicStateCoordinator.setLocalRequirements({ lc3: false })` is called; the coordinator turns mic off unless cloud is also holding it.

### 2.5a Phone-Cloud WebSocket Reference

There is a single WebSocket between phone and cloud:

- Cloud side: `userSession.websocket`, registered via `glasses-message-handler.ts`. The cloud codebase names it "glasses WebSocket" because real glasses connect BLE to the phone, not directly to cloud.
- Phone side: owned by `mobile/src/services/WebSocketManager.ts`, used by `SocketComms.ts:56` (`ws.connect(url, this.coreToken)`).

Existing messages on this connection: `audio_play_request`, `display_event`, `microphone_state_change`, `keep_alive_ack`, photo responses, VAD status. Phase 2.5 adds: `PHONE_SUBSCRIPTION_UPDATE` (outbound) and inbound `data_stream` messages routed to `__phone__`. No new WebSocket, no parallel connection.

### 2.6 Event Forwarding

`LocalMiniappRuntime` registers event listeners on CoreModule, MantleManager, and SocketComms. Each event is mapped to a `MiniappStreamType` value (Phase 1.3) before being fanned out to subscribed miniapps.

**CoreModule event name translation table:**

| CoreModule event           | MiniappStreamType    | Notes                                                                                                                                                                            |
| -------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `button_press`             | `BUTTON_PRESS`       | Same                                                                                                                                                                             |
| `touch_event`              | `TOUCH_EVENT`        | Same                                                                                                                                                                             |
| `head_up`                  | `HEAD_POSITION`      | **Name mismatch — translate.** CoreModule emits `head_up` (see `mobile/modules/core/src/Core.types.ts` line 255). Miniapp protocol uses `HEAD_POSITION`.                         |
| `glasses_battery_update`   | `GLASSES_BATTERY`    | Minor rename                                                                                                                                                                     |
| `glasses_connection_state` | `GLASSES_CONNECTION` | Minor rename                                                                                                                                                                     |
| `audio_chunk`              | `AUDIO_CHUNK`        | Raw mic PCM. See Phase 2.9 for mic enablement.                                                                                                                                   |
| `vad`                      | `VAD`                | **Legacy wire value is uppercase `"VAD"`** (see `cloud/packages/sdk/src/types/streams.ts` line 24). Miniapp protocol uses lowercase `vad` internally, translate at the boundary. |
| `photo_taken`              | `PHOTO_TAKEN`        | Phase 5 — noop for now                                                                                                                                                           |
| `stream_status`            | `STREAM_STATUS`      | Phase 5 — noop for now                                                                                                                                                           |

Register CoreModule event listeners in `LocalMiniappRuntime` during initialization. Each listener calls `this.forwardEvent(miniappStreamType, data)` after translating the name and optionally the payload shape.

**From MantleManager (phone sensors, no cloud):**

| Source                                 | MiniappStreamType    | Notes                                                                                 |
| -------------------------------------- | -------------------- | ------------------------------------------------------------------------------------- |
| `MantleManager` location tracking      | `LOCATION_UPDATE`    | Already forwards to `RestComms.sendLocationData`; also forward to LocalMiniappRuntime |
| Phone battery listener                 | `PHONE_BATTERY`      | Already in battery store; tap into it                                                 |
| Notification listener (via CoreModule) | `PHONE_NOTIFICATION` | From the Android notification listener service                                        |
| `expo-calendar` sync                   | `CALENDAR_EVENT`     | From `MantleManager` calendar sync path                                               |

Hook into MantleManager: when it receives these, it also calls `localMiniappRuntime.forwardEvent(miniappStreamType, data)`.

**From cloud (via SocketComms):**

Transcription, translation, and any other cloud-delivered streams arrive as `data_stream` messages on the client WebSocket (see Phase 2.5). `SocketComms.handle_message()` gets a new case:

```typescript
case "data_stream": {
  const streamType = msg.streamType;  // e.g., "transcription:en-US"
  localMiniappRuntime.forwardEvent(streamType, msg.data);
  break;
}
```

No translation needed for cloud-delivered streams: the language-suffixed naming (`transcription:en-US`) is preserved between cloud and miniapp protocols.

### 2.7 Subscription Lifecycle

**Important:** "user navigates away from the miniapp" is NOT the same as "WebView unmounts". Per Phase 2.12a, navigating away moves the miniapp's WebView offscreen but keeps it mounted and running in the background so it can continue receiving events and driving glasses. This section only covers real teardown: user explicitly closes the miniapp, MentraOS logout, or the WebView is evicted by the `MiniappHost`.

**Miniapp closed by user (capsule-menu close button):**

- `MiniappHost` unmounts the WebView for that `packageName`.
- Unmount handler calls `localMiniappRuntime.unregisterApp(packageName)`.
- `unregisterApp` drops all subscriptions and calls `unsubscribePhoneStream()` for any streams with no remaining subscribers across all still-running miniapps.

**MentraOS logout / re-auth:**

- `LocalMiniappRuntime.cleanup()` is called from `MantleManager` during logout.
- Every connected miniapp is unregistered, every WebView in `MiniappHost` is unmounted.

**WebView crashes:**

- `onContentProcessDidTerminate` (iOS) / `onError` (Android) fires on the affected WebView.
- `MiniappHost` tears it down, calls `unregisterApp(packageName)`.
- When the user next foregrounds the miniapp, it is mounted cold and sends a fresh `CONNECT`.

**WebView evicted by LRU cap (Phase 2.12a):**

- Same as crash: unregister, full unmount, next foreground is a cold start.
- Pre-eviction hook calls the miniapp's `beforeevict` envelope (if the miniapp SDK registered one) so the miniapp can flush state to `session.storage`. Best-effort, 500ms timeout.

**Multi-miniapp reference counting:**

- `streamSubscribers: Map<streamType, Set<packageName>>` tracks who wants what.
- Subscribe: add `packageName` to the set. If set size goes from 0 to 1, subscribe from cloud.
- Unsubscribe: remove `packageName` from the set. If set becomes empty, unsubscribe from cloud.

**Keepalive PING / orphan detection:**

- `LocalMiniappRuntime` sends a bridge `PING` envelope to every registered miniapp every 5 seconds (both foreground and background). See Phase 2.12a for why this exists — it is both a liveness keeper and an orphan probe.
- Miniapp SDK (`@mentra/miniapp`) auto-replies with `PONG` from a handler attached at `connect()` time. The dev never sees this.
- If a miniapp misses N consecutive pings (default N=3, so ~15 seconds of silence), `LocalMiniappRuntime` treats it as dead: calls `unregisterApp(packageName)`, tells `MiniappHost` to tear down the WebView, logs a warning. Next open is a cold start.

### 2.8 Auth

Three distinct auth stories. Do not conflate them.

**Bundled local miniapp (postMessage transport, WebView loads HTML from `Paths.document/lmas/`):**

The phone is fully in control of the WebView. The WebView loads static HTML from the phone's filesystem. There is no remote server, no cross-origin concern, no need for JWT auth tokens. The phone already knows the user is authenticated (because the user is logged in to MentraOS and launched the miniapp from within the app).

LocalMiniappRuntime trusts the WebView implicitly based on:

- The phone injected `window.MentraOS.packageName` before the content loaded — the bundled miniapp cannot lie about its identity
- The miniapp is running in-process inside the MentraOS app, under the user's MentraOS session

No tokens passed. No signature verification. Identity is established by the injection.

**Dev miniapp (postMessage transport, WebView loads HTML from `http://<LAN-IP>:3000`):**

Same trust model as bundled. The user explicitly scanned a QR code from the Miniapp Developer screen to load this URL, consenting to treat it as trusted. The phone injects `window.MentraOS.packageName` before content loads, same as a bundled miniapp. The only differences are the source URL scheme (HTTP instead of `file://`) and the `miniappDeveloperMode: true` flag in the injected globals (see Phase 3.3 for terminology — this is NOT the internal "Mentra Developer Mode" flag). No tokens, no cross-origin handling beyond the Android cleartext HTTP exception (see Phase 2.12).

The existing `aos_signed_user_token` / `aos_temp_token` flow used by cloud webview apps under `@mentra/sdk`'s `/webview/` routes is a separate system and is not used by local bundled or dev miniapps.

**External browser miniapp (LocalSocketTransport, Safari/Chrome fallback):**

Here auth matters because MentraOS launches Safari with the miniapp URL, and the connection from Safari to the phone's localhost WebSocket is separate from the MentraOS app process.

Flow:

1. User taps "Open App" in MentraOS
2. MentraOS generates a short-lived local session token bound to (userId, packageName, current timestamp)
3. MentraOS opens Safari with URL: `https://miniapp.example.com/?aos_package=com.example.myapp&aos_local_token=<token>`
4. `@mentra/miniapp` running in Safari reads the token from the URL, passes it in the `CONNECT` request over MiniSockets
5. LocalMiniappRuntime validates the token against its in-memory list of issued tokens, extracts userId + packageName
6. Token is consumed (single-use) or has a short TTL (e.g., 5 minutes)

Token issuer and verifier are both the phone (no cloud round-trip). Implementation: HMAC-signed blob with a phone-local secret.

### 2.9 Mic Enablement Lifecycle

Subscribing to `transcription:*`, `translation:*`, `audio_chunk`, or `vad` delivers data only while the microphone is capturing. Today mic enable/disable is driven by the cloud sending `microphone_state_change` → `CoreModule.update(...)` (`SocketComms.ts` line 454), so a local miniapp subscribing with no cloud driver receives nothing.

`MicStateCoordinator` unions cloud-driven and local-driven mic requirements, and is the sole caller of `CoreModule.update("core", ...)` for mic state.

**Mic-requiring streams:**

- `transcription:*`
- `translation:*`
- `audio_chunk`
- `vad`

**Ref count logic (lives in `MicStateCoordinator`, not directly in `LocalMiniappRuntime`):**

```typescript
class MicStateCoordinator {
  private cloudWantsPcm = false
  private cloudWantsLc3 = false
  private cloudWantsTranscript = false
  private cloudBypassVad = false

  private localWantsPcm = false
  private localWantsLc3 = false

  // Called by SocketComms.handle_microphone_state_change() instead of calling CoreModule.update directly
  public setCloudRequirements(req: {pcm; lc3; transcript; bypass_vad}): void {
    this.cloudWantsPcm = req.pcm
    this.cloudWantsLc3 = req.lc3
    this.cloudWantsTranscript = req.transcript
    this.cloudBypassVad = req.bypass_vad
    this.applyUnion()
  }

  // Called by LocalMiniappRuntime when local subscriptions change
  public setLocalRequirements(req: {pcm; lc3}): void {
    this.localWantsPcm = req.pcm
    this.localWantsLc3 = req.lc3
    this.applyUnion()
  }

  private applyUnion(): void {
    CoreModule.update("core", {
      should_send_pcm: this.cloudWantsPcm || this.localWantsPcm,
      should_send_lc3: this.cloudWantsLc3 || this.localWantsLc3,
      should_send_transcript: this.cloudWantsTranscript, // only cloud apps get cloud-delivered transcripts
      bypass_vad: this.cloudBypassVad,
    })
  }
}
```

**LocalMiniappRuntime mic state recompute:**

```typescript
class LocalMiniappRuntime {
  private recomputeMicRequirements(): void {
    let anyPcm = false
    let anyLc3 = false
    for (const [stream, subscribers] of this.streamSubscribers) {
      if (subscribers.size === 0) continue
      if (stream === "audio_chunk") anyPcm = true
      // Use miniapp protocol names — LocalMiniappRuntime stores subscriptions in miniapp-protocol form
      if (stream.startsWith("transcription:") || stream.startsWith("translation:") || stream === "vad") anyLc3 = true
    }
    micStateCoordinator.setLocalRequirements({pcm: anyPcm, lc3: anyLc3})
  }
}
```

**SocketComms refactor:** `SocketComms.handle_microphone_state_change()` at line 454 currently calls `CoreModule.update("core", {...})` directly. Refactor to call `micStateCoordinator.setCloudRequirements({...})` instead. This is the only call site that touches mic state on `core`.

**Subscription-to-mic-mode mapping:**

- `transcription:*` / `translation:*` / `vad` → LC3 audio sent to cloud (via the existing phone→cloud UDP pipe). Set `localWantsLc3 = true`.
- `audio_chunk` (raw PCM in local miniapp) → Set `localWantsPcm = true`. LocalMiniappRuntime taps into the CoreModule PCM event and fans out to subscribed local miniapps.

**Edge cases:**

- If cloud turns mic off but a local miniapp still wants it, the union logic keeps it on.
- If the local miniapp unsubscribes and cloud isn't driving it, mic goes off.
- VAD events come from CoreModule for free whenever mic is active — no separate enable path.

### 2.10 Local Miniapp Bundle Format and Installation

**Bundle format:**

A local miniapp is a ZIP archive containing a static web bundle. After install, the unzipped bundle lives at `Paths.document/lmas/<packageName>/<version>/` and contains:

- `miniapp.json` — manifest (packageName, version, name, declared permissions, hardware requirements)
- `icon.png` — app icon
- `index.html` — entry point loaded into the WebView
- JS / CSS / assets

No server component. Persistent state lives in Simple Storage (AsyncStorage, Phase 2.13).

**`miniapp.json` schema:**

```json
{
  "packageName": "com.example.myapp",
  "version": "1.2.3",
  "name": "My App",
  "description": "What the app does",
  "permissions": ["CAMERA", "MICROPHONE", "LOCATION"],
  "hardwareRequirements": []
}
```

**Legacy `app.json` fallback:** install flow accepts either `miniapp.json` or `app.json` at bundle read time, but always writes `miniapp.json` to disk. Existing on-disk bundles keep loading via the fallback read path.

**Composer.ts rewrite.** The existing `Composer.ts` is a prototype (duplicate `fanOutPcm` method, empty `initialize()`, hardcoded empty permissions, ad-hoc error handling). Rewrite as the canonical local miniapp installer / bundle manager.

Public API:

- `initialize(): Promise<void>` — called during `MantleManager.init()`. First calls `installBundledMiniapps()` to install/update first-party miniapps from `mobile/assets/miniapps/`. Then scans `Paths.document/lmas/`, builds `ClientAppletInterface` entries from each bundle's `miniapp.json`, populates `appletStatusStore` with `{local: true, permissions: [...]}` entries.
- `installBundledMiniapps(): Promise<void>` — reads ZIP files from the React Native assets folder (`mobile/assets/miniapps/`), compares each bundled manifest version against the installed version in `lmas/`, and installs or overwrites if the bundled version is newer or not yet installed. One packageName = one slot, no duplicates.
- `installFromUrl(url: string): AsyncResult<{packageName: string, version: string}, InstallError>` — downloads ZIP, unzips, validates `miniapp.json`, moves to `lmas/<packageName>/<version>/`. Returns the installed package info. Replaces the current `installMiniApp` + `downloadAndInstallMiniApp`.
- `uninstall(packageName: string, version?: string): AsyncResult<void, Error>` — if `version` is omitted, removes all versions. Removes empty parent directory. Updates `appletStatusStore`.
- `getInstalledMiniapps(): InstalledMiniapp[]` — returns the cached list (source of truth is `appletStatusStore` after init).
- `getBundleDir(packageName: string, version: string): Result<string, Error>` — returns the absolute filesystem path to the installed bundle (`Paths.document/lmas/<packageName>/<version>`). The WebView loads `file://<bundleDir>/index.html` directly — Composer does not read or return HTML strings (see Phase 2.12 bundle loading).
- `getMiniappManifest(packageName: string, version: string): Result<MiniappManifest, Error>` — parses `miniapp.json`.

Remove `fanOutPcm` entirely — audio fan-out is `LocalMiniappRuntime`'s job now, not `Composer`'s.

Permissions from `miniapp.json` must be surfaced into `ClientAppletInterface.permissions`. The current `getLocalApplets()` hardcodes `permissions: []` at line 342 — fix this to parse from the manifest. `LocalMiniappRuntime` reads these for permission checks before allowing hardware access.

**Load flow (rewrite `local.tsx` and `LocalMiniApp.tsx`):**

1. User opens a local miniapp from the launcher
2. Router navigates to `/applet/local?packageName=...&version=...`
3. `local.tsx` reads the manifest and the bundle directory path via `Composer.getMiniappManifest()` / `Composer.getBundleDir()`
4. `LocalMiniApp.tsx` mounts a WebView with `source={{ uri: \`file://${bundleDir}/index.html\` }}`and`injectedJavaScriptBeforeContentLoaded`for the`window.MentraOS` globals (packageName, userId, glasses capabilities — see Phase 2.10)
5. WebView loads `index.html` from disk, relative asset paths (`./assets/*.js`, `./styles.css`) resolve against the bundle directory, miniapp JS imports the SDK, SDK auto-detects transport, sends `CONNECT` request
6. `LocalMiniappRuntime` receives it, responds with `CONNECT_ACK`
7. Miniapp is live

`mobile/src/app/applet/local.tsx` and `mobile/src/components/home/LocalMiniApp.tsx` are currently stubs. Rewrite both to match the Phase 2.12 lifecycle and route through `LocalMiniappRuntime` (Phase 2.1). Keep `MiniAppCapsuleMenu` as the close/back UI.

**Install lifecycle and persistence:**

- **Install**: `Composer.installFromUrl(url)` downloads and unzips to `Paths.document/lmas/<packageName>/<version>/`. `Paths.document` is persistent app storage (`expo-file-system`); it survives force-quits, OS reboots, and app updates.
- **Bundled first-party miniapps**: first-party miniapp ZIPs (e.g., Live Captions) ship in the React Native assets folder at `mobile/assets/miniapps/`. During `Composer.initialize()`, each bundled ZIP is installed (or re-installed) into `lmas/<packageName>/`. One packageName = one home screen entry — re-installing overwrites the existing slot, never creates duplicates. This is also the update path: ship a new APK/IPA with an updated ZIP, it overwrites on next launch. `Composer.initialize()` compares the bundled manifest version against the installed version and only re-installs if the bundled version is newer (or if no installed version exists).
- **Launch repopulation**: `Composer.initialize()` runs during `MantleManager.init()` on every app launch. It first installs/updates bundled miniapps from assets, then scans `Paths.document/lmas/`, reads each bundle's `miniapp.json`, and writes one `ClientAppletInterface` entry per installed bundle into `appletStatusStore`. The filesystem is the authoritative source of truth — there is no separate persisted store.
- **Home screen**: each entry appears in `AppsGrid` alongside cloud and offline apps. Bundled miniapps are visible on the home screen across restarts without any extra work.
- **Uninstall**: `Composer.uninstall(packageName, version?)` deletes the bundle directory on disk and updates `appletStatusStore`. The next launch scans a reduced (or empty) `lmas/` tree, so the entry stays gone. Note: bundled miniapps will be re-installed on next app launch since they ship in assets — uninstalling a bundled miniapp is effectively a "reset to factory" for that app.
- **Dev-mode miniapps (Phase 3.3) are NOT persisted**. QR-loaded dev miniapps live only in-memory on `appletStatusStore` and are cleared on app restart; ZIP-installed miniapps persist.
- **When data IS lost**: only when the user uninstalls MentraOS itself or the OS clears app data. No MentraOS code path clears `Paths.document/lmas/` beyond explicit `Composer.uninstall()` calls.

**Out of scope for v1 bundle handling:**

- **Auto-update**: `installFromUrl(url)` downloads exactly the given URL. No version-check polling. One-shot install only.
- **Store integration**: wiring `Composer.installFromUrl()` to a store UI is a separate workstream.
- **Signature verification**: not implemented in v1.

### 2.11 Three Distinct Concepts — Capabilities, Bridge Capabilities, Permissions

- **Glasses capabilities**: `Capabilities` typed object from `@mentra/types` describing the currently-connected glasses hardware (camera, mic, display resolution, speaker). LocalMiniappRuntime reads from `glassesStore` / `CoreModule` and sends to the miniapp in `CONNECT_ACK` and on `CAPABILITIES_UPDATE` whenever glasses change.
- **Legacy bridge capabilities**: `['share', 'open_url', 'copy_clipboard', 'download']` injected by `webview.tsx`. Unrelated to glasses capabilities. Phase 2.3 deletes these.
- **Miniapp permissions**: declared in `miniapp.json` (CAMERA, MICROPHONE, LOCATION, etc.). Per-miniapp. Phone checks against user OS grants before allowing hardware access.

### 2.12 WebView Lifecycle and Bundle Loading

**Lifecycle:** `mobile/src/app/applet/webview.tsx` currently waits for cloud-side app start confirmation before fading in. Local miniapps have no cloud handshake.

Changes to `webview.tsx`:

- Derive `isLocal` flag from the app's definition in `useAppletStatusStore`.
- When `isLocal`:
  - Skip the cloud handshake.
  - Fade in on WebView `onLoad`.
  - Keep `MiniAppCapsuleMenu` as the close/back UI.
  - Handle `CONNECT` request from the miniapp via `LocalMiniappRuntime`, respond with `CONNECT_ACK` containing `userId`, `packageName`, and current glasses capabilities.

**Bundle loading — file URI:**

The miniapp bundle is a set of files at `Paths.document/lmas/<packageName>/<version>/`. The WebView loads `index.html` via a `file://` URI so relative paths (`./assets/main-abc123.js`, `./styles.css`) resolve against the bundle directory.

**Implementation:**

The `<WebView>` itself is owned by `MiniappHost` (Phase 2.12a), not by `local.tsx` or `LocalMiniApp.tsx`. `MiniappHost` creates one `<WebView>` per running miniapp and keeps it mounted across route transitions. The shape of each WebView element:

```tsx
// Inside MiniappHost, one per running miniapp.
import {WebView} from "react-native-webview"

const bundleDir = `${Paths.document}/lmas/${packageName}/${version}`
const htmlUri = `file://${bundleDir}/index.html`

;<WebView
  source={{uri: htmlUri}}
  originWhitelist={["*"]} // needed for file:// and relative resolution
  allowFileAccess={true} // Android — required for file:// source
  allowFileAccessFromFileURLs={true} // Android — needed for fetch() on relative assets
  // allowUniversalAccessFromFileURLs is NOT set (defaults to false). See "Security" below.
  javaScriptEnabled={true}
  domStorageEnabled={true}
  injectedJavaScriptBeforeContentLoaded={`
    window.MentraOS = {
      packageName: ${JSON.stringify(packageName)},
      platform: ${JSON.stringify(Platform.OS)},
      ${isMiniappDeveloperMode ? "miniappDeveloperMode: true," : ""}
    };
    true;
  `}
  onMessage={handleWebViewMessage}
  onContentProcessDidTerminate={handleEviction} // iOS OOM kill — see Phase 2.12a
  onError={handleEviction} // Android crash
/>
```

**iOS specifics:** `react-native-webview` on iOS resolves file URIs via `WKWebView.loadFileURL(url, allowingReadAccessTo: bundleDir)` automatically when given a `file://` source. `allowingReadAccessTo` must be the parent directory so the WebView can read sibling assets.

**Android specifics:** The three `allowFileAccess*` flags must be explicitly `true`. Default is `false` in newer versions of react-native-webview for security, so they must be set per-WebView.

**Security model (v1):**

The OS sandbox isolates the MentraOS app's private data directory from other apps on both iOS and Android. Within MentraOS's own sandbox:

- **iOS**: `WKWebView.loadFileURL(url, allowingReadAccessTo: bundleDir)` scopes read access to the specific bundle directory. A miniapp cannot read sibling miniapp bundles or MentraOS storage via `fetch('file://...')`. Enforced natively by WKWebView.
- **Android**: with `allowFileAccessFromFileURLs = true`, a miniapp can `fetch('file://...')` any file readable by the MentraOS process (sibling bundles, `Paths.document`, AsyncStorage backing files). This is a v1 trade-off — miniapps on Android have the same on-disk read access as the MentraOS process. `allowUniversalAccessFromFileURLs` stays `false` so cross-origin network fetches from `file://` are blocked.

v1 mitigations: store distribution + manual review. v2 hardening (out of scope): per-miniapp localhost HTTP server with scoped routing, single-file HTML bundling with `allowFileAccessFromFileURLs=false`, or bundle signature verification.

**Injected globals:** only `packageName`, `platform`, and (in miniapp developer mode) `miniappDeveloperMode: true`. `userId`, `capabilities`, and `cloudUrl` are delivered via `CONNECT_ACK` in response to `CONNECT`, not as injected globals — capabilities can change mid-session when glasses switch.

**Two loading modes — bundled vs dev server:**

`LocalMiniApp.tsx` accepts EITHER a bundled source OR a dev server URL:

```tsx
// Bundled miniapp (installed from ZIP)
<LocalMiniApp
  packageName="com.example.myapp"
  bundleDir={`${Paths.document}/lmas/${packageName}/${version}`}
/>

// Dev miniapp (loaded from developer's Bun Fullstack server via QR scan)
<LocalMiniApp
  packageName="com.dev.myapp"
  devUrl="http://192.168.1.50:3000"
/>
```

Internally:

- Bundled: WebView `source={{ uri: 'file://' + bundleDir + '/index.html' }}`
- Dev: WebView `source={{ uri: devUrl }}`
- Bundled: inject `window.MentraOS = {packageName, platform}`
- Dev: inject `window.MentraOS = {packageName, platform, miniappDeveloperMode: true}`
- Dev mode also allows HTTP (not just HTTPS) URLs since LAN IPs are HTTP

The `miniappDeveloperMode: true` flag is informational. Log forwarding is already handled by Bun Fullstack's `console: true` over the HMR WebSocket — the SDK does not do any log wrapping. The flag can be used by the SDK to opt into verbose internal logging or skip caching if needed.

**Android HTTP cleartext exception:** Loading an HTTP dev URL into the WebView requires the Android manifest to allow cleartext traffic for the dev URL. The simplest approach is adding `android:usesCleartextTraffic="true"` to the app manifest for debug builds (already true in most RN dev builds) OR adding a network security config that allows cleartext for LAN IP ranges. For production builds loading a dev URL would be unusual — dev mode is primarily for internal Mentra developer builds and dogfood testers, not end users.

**Local miniapp route rewrite:**

- `mobile/src/app/applet/local.tsx` — rewrite to read manifest + bundle directory from `Composer`, mount `LocalMiniApp.tsx`. Accepts `?devUrl=...` query param for dev-mode path.
- `mobile/src/components/home/LocalMiniApp.tsx` — rewrite for file URI / dev URL loading and envelope protocol (Phase 2.2).

Keep `MiniAppCapsuleMenu` in both `webview.tsx` and `local.tsx`.

### 2.12a Background Execution and `MiniappHost`

**Contract:** once opened, a local miniapp stays running in the background until the user explicitly closes it, the OS kills the MentraOS process, or the WebView is evicted. Backgrounded miniapps continue to receive events (transcription, button presses, location, etc.), can call SDK methods, and can drive the glasses display. This matches how cloud apps already behave — a running cloud app keeps running regardless of which screen the user is looking at.

This applies to every miniapp by default. There is no opt-in manifest flag. Miniapps that do not want to do work in the background should gate their own logic on `session.visibility` (see below).

**`MiniappHost` component** (`mobile/src/components/miniapp/MiniappHost.tsx`, NEW file):

A top-level component mounted once inside `AllProviders` in `mobile/src/app/_layout.tsx`. It holds a `Map<packageName, MountedMiniapp>` of every currently-running miniapp WebView. WebViews are mounted once when a miniapp first opens and stay mounted across navigation until explicitly unregistered.

Layout strategy:

- All WebViews live inside a single full-screen `View` that `MiniappHost` owns. Never inside an expo-router screen — router screens get unmounted on navigation, which would defeat the whole point.
- Exactly one WebView is foreground at a time, sized to fill the applet route view. The foreground one is the miniapp the user is currently looking at.
- All other WebViews are backgrounded: moved to `position: absolute; left: -10000; top: -10000; width: 1; height: 1; opacity: 0; pointerEvents: 'none'`. They stay in the view hierarchy so their JS contexts keep running.
- Do NOT use `display: none`. On some Android WebView versions `display: none` triggers JS-context eviction. `opacity: 0` + offscreen positioning is the reliable pattern.
- Do NOT use `pointerEvents: 'none'` alone — a WebView with a `width: 1, height: 1` footprint and touch events disabled reliably stays alive on both platforms.

When the applet route in expo-router mounts, it does NOT mount a fresh WebView — it registers its render target with `MiniappHost`, which moves the appropriate existing WebView into that target. When the applet route unmounts (user navigates away), `MiniappHost` moves the WebView back to its offscreen parking position. The WebView component itself is never unmounted in this flow.

**Lifecycle events:**

| Event                                                     | Action                                                                                                                                                                                                                                                    |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| User opens miniapp for first time                         | `MiniappHost.mount(packageName, bundleDir)` creates a new WebView, registers it with `LocalMiniappRuntime`, waits for `CONNECT`, makes it foreground.                                                                                                     |
| User navigates away (back button, open another app, home) | `MiniappHost` moves the current WebView to its offscreen parking position. WebView stays mounted. `session.visibility` → `"background"` event fires.                                                                                                      |
| User opens a different (already-running) miniapp          | Previous miniapp moves offscreen, new miniapp moves onscreen. Both keep running.                                                                                                                                                                          |
| User explicitly closes miniapp (capsule menu close)       | `MiniappHost.unmount(packageName)` — real WebView unmount, calls `localMiniappRuntime.unregisterApp(packageName)`.                                                                                                                                        |
| MentraOS process is killed by OS                          | Everything dies at once. Next launch is a cold start for all miniapps. No persistence of in-memory state (miniapps must use `session.storage` for anything they need across process restarts).                                                            |
| WebView JS runtime evicted by OS (memory pressure)        | Treated the same as a crash. `MiniappHost` unmounts, `LocalMiniappRuntime.unregisterApp`, next foreground is a cold start. On iOS, surface this via an alert box in debug builds so it's visible during development — see "iOS eviction debugging" below. |

**`session.visibility` API (SDK side):**

`@mentra/miniapp` adds a new observable on `MiniappSession`:

```ts
session.visibility: "foreground" | "background"
session.onVisibilityChange(handler: (v: "foreground" | "background") => void): () => void
```

The phone pushes `MiniappResponseType.VISIBILITY_CHANGE` envelopes whenever a miniapp's state changes. The SDK maintains the current value. Well-behaved miniapps wrap their expensive UI work (animations, video, heavy re-renders) in a visibility check so they throttle themselves when backgrounded. Event handlers still fire regardless of visibility state — the miniapp can choose to ignore them or not.

**Page Visibility API disambiguation.** The `document.visibilityState` DOM property is NOT used to signal miniapp-backgrounded-ness, because a hidden-`document.visibilityState` causes the browser to throttle `requestAnimationFrame` and `setTimeout` aggressively — exactly the behavior we are trying to prevent to keep the bridge alive. The offscreen WebView keeps `document.visibilityState === "visible"` (because the layer is in the view hierarchy with `opacity: 0`, which does not trigger the browser's page-hidden heuristic). `session.visibility` is a separate, miniapp-controllable signal.

**Keepalive PING cadence:**

`LocalMiniappRuntime` sends a bridge `PING` envelope to every registered miniapp every 5 seconds. Miniapp SDK auto-replies with `PONG`. This has two purposes:

1. Keeps the JS event loop active inside the WebView, which on iOS especially is important for preventing WKWebView from throttling timers on a view that has no other reason to run.
2. Liveness probe — if a miniapp misses 3 consecutive pings (~15 seconds of silence), treat it as dead (see Phase 2.7).

Cadence is tunable via a constant in `LocalMiniappRuntime`.

**No concurrent miniapp cap.** Miniapps stay alive until the OS reclaims memory. There is no LRU eviction policy in `MiniappHost` — if you have 20 miniapps open, you have 20 WebViews mounted, until the OS kicks in. This matches the cloud-app model where N running apps = N live AppSessions. Users with memory pressure will see the OS evict WebViews (handled via the crash path); users without won't.

**Process-level keepalive (Android):** the existing glasses BLE foreground service keeps the MentraOS process alive in the background. Nothing new needed. If the user disconnects glasses AND backgrounds MentraOS, the OS will eventually kill the process — accept this. Miniapps cold-start when the user returns.

**Process-level keepalive (iOS):** the existing BLE central background mode for the glasses connection holds the process. When the user disconnects glasses, iOS kills the whole app within ~1 minute regardless of what the miniapps are doing. This is acceptable — without glasses there is nothing useful for a miniapp to do. On return, all miniapps cold-start.

**iOS eviction debugging:**

WKWebView can evict a backgrounded WebView's JS context under memory pressure even while the host process is alive. This should be rare in practice with offscreen-but-mounted placement, but when it happens we want to know. In debug builds (`__DEV__`):

- `onContentProcessDidTerminate` fires.
- `MiniappHost` shows a native `Alert.alert("Miniapp WebView evicted", \`iOS killed ${packageName}'s JS context while backgrounded. Investigate aggressive keepalive.\`)` — blocks so a developer notices it immediately.
- In release builds, log-only via Sentry breadcrumb; no user-visible alert.
- Future work if this turns out to be frequent: add an audio session activation on miniapp open to raise the process priority, similar to how music apps stay alive while backgrounded. Not in v1.

**Files touched:**

- `mobile/src/components/miniapp/MiniappHost.tsx` — NEW. Top-level mount for all miniapp WebViews.
- `mobile/src/contexts/AllProviders.tsx` — add `MiniappHost` to the provider tree.
- `mobile/src/app/applet/local.tsx` — do NOT mount a WebView directly. Instead, register a render target with `MiniappHost` and move the existing WebView into it. Unregister on unmount to move the WebView back offscreen.
- `mobile/src/components/home/LocalMiniApp.tsx` — becomes a thin wrapper around `MiniappHost.getOrCreate(packageName, bundleDir)` rather than hosting the `<WebView>` directly.
- `sdk/miniapp/src/session.ts` — add `visibility`, `onVisibilityChange`, `PONG` auto-reply handler.
- `sdk/miniapp/src/protocol.ts` — add `MiniappResponseType.VISIBILITY_CHANGE`, `MiniappRequestType.PING`, `MiniappResponseType.PONG` enum values.
- `mobile/src/services/LocalMiniappRuntime.ts` — add ping loop, missed-ping tracking, `MiniappHost` integration, visibility state management.

### 2.13 Simple Storage (AsyncStorage)

LocalMiniappRuntime handles SDK `SimpleStorage` calls via phone-local AsyncStorage. No cloud.

- Key format: `mentraos_localstorage_${userId}_${packageName}_${key}`
- Scope: installed app, current user
- API: `get(key)`, `set(key, value)`, `delete(key)`, `list()`
- On user logout: clear all keys matching the user's prefix

Cloud apps keep using the existing cloud-hosted simple-storage API. Local miniapps use on-device storage only — no cross-device sync in v1.

### 2.14 Dashboard API — Deferred in v1

`session.dashboard.setContent()` noops and logs `console.warn("Dashboard API is deferred for local miniapps in v1")`. The API surface exists in `@mentra/miniapp` so TypeScript compiles; calls have no effect on the display.

Rationale: `cloud/packages/cloud/src/services/session/dashboard/DashboardManager.ts` is 825 lines owning LLM-ranked notifications, weather, calendar, multi-device profile spacing, native token resolution, widget rotation, and the debounced render cycle. Porting to phone is out of scope for v1. Local miniapps use `layouts.showTextWall()` / `showReferenceCard()` for their own display needs. The OS dashboard continues running on cloud unchanged.

**Future work:** route local miniapp `DASHBOARD_CONTENT_UPDATE` messages through the Phase 2.5 `__phone__` path into the existing cloud `DashboardManager`. Out of scope for v1.

### 2.15 Settings API (Not Covered)

The old per-app settings API (cloud-hosted settings via `session.settings`) is deprecated. Local miniapps do NOT support it. Use Simple Storage (Phase 2.13) for any persistent state instead.

### 2.16 Permissions

Permissions declared in `miniapp.json` map to phone OS permissions. Local miniapps reuse the same launcher permission gate as cloud apps and offline apps — no new permission infrastructure on the phone. Phone OS permission state is the source of truth for grants; revocation goes through OS settings.

**Existing infrastructure reused:**

- `mobile/src/utils/PermissionsUtils.tsx` `askPermissionsUI(app, theme): Promise<number>` at line 679 — computes missing phone OS permissions from `app.permissions`, shows the prompt, requests grants, re-checks. Returns 1 (proceed) / 0 (missing) / -1 (cancelled).
- `mobile/src/components/home/AppsGrid.tsx` `handlePress()` at lines 414-422 calls `askPermissionsUI(app, theme)` before `startApplet(app)` for every app type.
- `ClientAppletInterface.permissions: AppletPermission[]` exists on every entry in `appletStatusStore`.

**Required changes:**

1. **`Composer` populates `permissions` from `miniapp.json`** (currently hardcoded to `[]` at `Composer.ts:342`). Phase 2.10 Composer rewrite reads `miniapp.json.permissions` and writes:

   ```ts
   permissions: miniappJson.permissions.map((type) => ({type, required: true}))
   ```

   `type` must be one of `AppPermissionType`: `MICROPHONE`, `LOCATION`, `CAMERA`, `CALENDAR`, `POST_NOTIFICATIONS`, `READ_NOTIFICATIONS`, `BACKGROUND_LOCATION`.

2. **`LocalMiniappRuntime` enforces declared permissions at subscribe time.** In the `SUBSCRIBE` handler, reject any mic-requiring stream (`transcription:*`, `translation:*`, `audio_chunk`, `vad`) unless `connectedApps.get(packageName).installedManifest.permissions` includes `MICROPHONE`. Same check for `LOCATION` streams against `LOCATION`. Rejection payload: `MiniappResponseType.ERROR` with `{code: "PERMISSION_NOT_DECLARED"}`.

**Out of scope for v1:** per-miniapp grant/revoke UI inside MentraOS settings. OS-level permission management is sufficient.

---

## Phase 3: Developer Tooling — `create-mentra-miniapp`, Dev Loop, QR Sideload

**Goal:** One-command scaffold + hot reload + terminal log streaming + production ZIP packaging.

**Tooling stack:** Bun Fullstack. `Bun.serve({ development: { hmr: true, console: true } })` routes `console.log` / `warn` / `error` from the loaded page back to the Bun terminal over the HMR WebSocket. No SDK-side code needed to stream logs from a phone WebView to the developer's laptop.

### 3.1 `create-mentra-miniapp` Scaffolder

A new CLI package (`sdk/create-mentra-miniapp/`) that scaffolds a working miniapp project.

```bash
bunx create-mentra-miniapp my-app
cd my-app
bun install
bun dev
```

Generated project structure (no `vite.config.ts` — this uses Bun Fullstack):

```
my-app/
├── package.json            # scripts: dev, build. deps: @mentra/miniapp, react, react-dom
├── tsconfig.json           # react-jsx target
├── miniapp.json            # manifest template with packageName placeholder
├── icon.png                # default icon
├── index.html              # entry point — imports src/main.tsx
├── server.ts               # Bun.serve() dev entry — imports index.html, configures HMR + console
├── src/
│   ├── main.tsx            # mounts the React app into #root
│   └── App.tsx             # starter component using useSession
└── bunfig.toml             # tailwind plugin config if enabled
```

`server.ts` is the Bun Fullstack entry:

```typescript
import homepage from "./index.html"
import manifest from "./miniapp.json"

Bun.serve({
  hostname: "0.0.0.0", // bind to LAN so the phone can reach it
  port: parseInt(process.env.PORT ?? "3000"),
  routes: {
    "/": homepage,
    // Serve the miniapp manifest so the phone can fetch declared permissions
    // before loading the WebView. Phone scanner flow relies on this (Phase 3.2 / 3.3).
    "/miniapp.json": () => Response.json(manifest),
  },
  development: {
    hmr: true,
    console: true, // ← forwards browser console.log to bun terminal over HMR WebSocket
  },
})
```

Starter `App.tsx`:

```tsx
import {useSession} from "@mentra/miniapp/react"

export default function App() {
  const session = useSession()

  return (
    <button
      onClick={() => {
        console.log("Button tapped") // will stream back to `bun dev` terminal automatically
        session.layouts.showTextWall("Hello glasses!")
      }}>
      Show on glasses
    </button>
  )
}
```

Starter `index.html`:

```html
<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>My Miniapp</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./src/main.tsx"></script>
  </body>
</html>
```

Starter `package.json`:

```json
{
  "name": "my-app",
  "scripts": {
    "dev": "mentra-miniapp dev",
    "build": "bun build ./index.html --outdir=./dist --target=browser",
    "pack": "mentra-miniapp pack"
  },
  "dependencies": {
    "@mentra/miniapp": "^0.1.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@mentra/miniapp-cli": "^0.1.0"
  }
}
```

**Dependency rules:**

- `@mentra/miniapp` is a normal dependency (bundled into developer build output).
- `@mentra/miniapp-cli` is a devDependency (provides `mentra-miniapp dev` and `mentra-miniapp pack`).
- Template `package.json` uses published npm semver ranges (e.g., `^0.1.0`), not `workspace:*`. Scaffolder copies the template verbatim.
- The scaffolder's own `package.json` in `sdk/create-mentra-miniapp/` uses `workspace:*` for its own deps (monorepo-internal).
- Publication order: `@mentra/miniapp` and `@mentra/miniapp-cli` must be on npm before `create-mentra-miniapp` is published. For internal pre-publication testing, swap the template deps to `"file:../../miniapp"` while running from the sdk/ workspace.

**Scaffolder script:** `sdk/create-mentra-miniapp/bin/index.ts` — Bun script that copies `template/` to target path, replaces `{{packageName}}` placeholders in `miniapp.json`, prints next-step instructions.

### 3.2 Dev Loop — QR Sideload with Log Streaming

**Flow:**

1. Developer runs `bun dev`, which invokes `mentra-miniapp dev`:
   - Spawns `bun run --hot server.ts` as a child process (Bun Fullstack with HMR + console forwarding).
   - Waits for Bun to listen on its port (default 3000).
   - Detects the developer's LAN IP via `os.networkInterfaces()` (first non-loopback IPv4).
   - Constructs a dev URL: `mentra-miniapp://dev?url=http%3A%2F%2F192.168.1.50%3A3000&name=my-app&package=com.dev.my-app`.
   - Prints a terminal QR code via `qrcode-terminal` and the raw URL as a fallback.
   - Relays the child Bun server's stdout/stderr to the developer's terminal.
2. Developer scans the QR from the phone app's "Miniapp Developer" screen (Phase 3.3).
3. MentraOS parses the URL, opens a WebView at `http://192.168.1.50:3000`, injects `window.MentraOS = { packageName, platform, miniappDeveloperMode: true }`.
4. WebView loads `index.html` → `main.tsx` → React mount → miniapp SDK auto-detects PostMessage transport → sends `CONNECT`.
5. `LocalMiniappRuntime` responds with `CONNECT_ACK`.
6. On file save, Bun HMR pushes the update over its WebSocket. WebView re-renders. SDK reconnects via `CONNECT`.
7. `console.log` calls from the miniapp are captured by Bun's injected HMR client and sent back to the Bun server over the HMR WebSocket. Terminal output:
   ```
   [15:42:01] [my-app] Button tapped
   [15:42:01] [my-app] Showing text on glasses
   ```

**Log forwarding mechanism:** Bun Fullstack's `console: true` injects a client script into served HTML that wraps `console.log` / `warn` / `error` / `info` and streams messages to the Bun server over the HMR WebSocket. React Native WebView supports standard WebSockets, so the HMR connection (`ws://192.168.1.50:3000/_bun/hmr`) runs from the WebView back to the developer's laptop. `@mentra/miniapp` does not wrap `console` and implements no log forwarding — Bun handles everything.

**Permissions for dev miniapps:** the Bun Fullstack template in Phase 3.1 serves `miniapp.json` at `/miniapp.json`. On dev URL load, MentraOS fetches `http://<LAN-IP>:3000/miniapp.json`, reads declared permissions, and passes them to `askPermissionsUI` before mounting the WebView. Same launcher gate as bundled miniapps.

### 3.3 Phone-Side Miniapp Developer Screen

**Terminology:** "Miniapp Developer" (screen name, for third-party developers loading a WIP miniapp) is distinct from the existing "Mentra Developer Mode" (internal Mentra Labs flag). Do not conflate in code, UI copy, or settings paths.

**v1 gating:** the Miniapp Developer screen is hidden inside the existing Mentra Developer Mode settings. Entry point: `Settings → Mentra Developer Mode → Miniapp Developer`. Add a `// TODO(miniapp-public-release): remove this gate` comment at the gating site. On public release, move the screen to a top-level settings entry.

**Screen UI (`mobile/src/app/miniapps/settings/miniapp-developer.tsx`, new file):**

- **Button: "Scan QR from dev server"** — navigates to the QR scanner page (`miniapp-developer-scanner.tsx`). Fullscreen QR scanner via `expo-camera` (already in `mobile/package.json` as `~55.0.9`). Uses `CameraView` with `barcodeScannerSettings={{ barcodeTypes: ['qr'] }}` and `onBarcodeScanned`.
- **Button: "Install from URL"** — navigates to a separate page (`miniapp-developer-install.tsx`). Text input for a ZIP URL. On submit, calls `Composer.installFromUrl(url)`, shows progress/success/error, and on success the miniapp appears in the home screen grid immediately. For internal testing and dogfooding before the store exists.
- **List: "Recent dev miniapps"** — last 5 scanned. Persisted in AsyncStorage. Tap to relaunch.
- **Reload button** on each recent entry — reloads the current WebView.

**Scanner flow:**

1. User taps "Scan QR from dev server"
2. Scanner opens
3. QR decoded → URL parsed
4. If the URL scheme is `mentra-miniapp://dev`, extract `url`, `name`, `package` params
5. If scheme is anything else (`http://`, bare URL, etc.), treat as a dev URL directly and prompt for packageName
6. Fetch `<url>/miniapp.json` to read declared permissions (dev helper serves this — see 3.2)
7. Call the shared `askPermissionsUI(dummyApp, theme)` helper with a synthetic `ClientAppletInterface` built from the fetched manifest
8. If permissions OK, navigate to the WebView route with the dev URL, marking it `isLocal: true` and `isMiniappDev: true`
9. WebView mounts at the dev URL with `window.MentraOS = { packageName, platform, miniappDeveloperMode: true }` injected

**Dev miniapp in the launcher:** dev miniapps appear in `AppsGrid` with a `[dev]` tag and a distinct icon tint, backed by an in-memory `ClientAppletInterface` list on `appletStatusStore`. Cleared on app restart (ZIP-installed miniapps persist).

**URL scheme handler in `DeeplinkContext.tsx`:** optional. If enabled, handles `mentra-miniapp://dev?...` URLs opened from outside the app (e.g., a QR tapped in a preview app) by navigating directly to the dev screen with the URL pre-filled. The in-app QR scanner is the primary path and works without this.

### 3.4 `@mentra/miniapp-cli` — Dev Helper and Packager

New package at `sdk/miniapp-cli/`. Commands: `dev` and `pack`.

**`mentra-miniapp dev`** — invoked by the scaffolder's `package.json` as `"dev": "mentra-miniapp dev"`:

1. Spawns `bun run --hot server.ts` as a child process. Bun Fullstack starts listening on port 3000 (or whatever `PORT` env is set to).
2. Waits for the port to be reachable (simple retry loop).
3. Detects the developer's LAN IP via `os.networkInterfaces()` (first non-loopback IPv4 matching the default gateway interface).
4. Constructs a dev URL: `mentra-miniapp://dev?url=http%3A%2F%2F<LAN-IP>%3A3000&name=<name from miniapp.json>&package=<packageName from miniapp.json>`
5. Prints a terminal QR code using `qrcode-terminal`.
6. Prints the raw URL as a fallback for manual entry.
7. Pipes the child Bun server's stdout/stderr to the developer's terminal — so HMR messages and forwarded browser console logs appear inline.
8. On SIGINT/SIGTERM, cleanly shuts down the Bun server child process.
9. Monitors for LAN IP changes (e.g., WiFi network switch). If the IP changes, regenerates and re-prints the QR code.

A single `bun dev` spawns the Bun Fullstack server, detects the LAN IP, prints the QR, handles IP changes, and unifies terminal output for HMR + forwarded console logs.

**`mentra-miniapp pack`** — invoked as `"pack": "mentra-miniapp pack"`. Does:

1. Verifies `dist/` exists (developer has run `bun run build` first).
2. Copies `miniapp.json` and `icon.png` from project root into `dist/`.
3. Validates `miniapp.json` against the schema (required fields: `packageName`, `version`, `name`, `permissions` array).
4. Validates declared permissions against a runtime allowlist. `AppPermissionType` in `cloud/packages/types/src/applet.ts:15` is a TypeScript `type` alias (not an enum), so the CLI defines its own runtime constant:

   ```ts
   // sdk/miniapp-cli/src/manifest.ts
   const ALLOWED_PERMISSIONS = [
     "MICROPHONE",
     "CAMERA",
     "CALENDAR",
     "LOCATION",
     "BACKGROUND_LOCATION",
     "READ_NOTIFICATIONS",
     "POST_NOTIFICATIONS",
   ] as const satisfies readonly AppPermissionType[]
   ```

   The `satisfies` clause makes the TS compiler fail if `AppPermissionType` gains a value that's not in this list. `"ALL"` is deliberately excluded — it is an internal wildcard, not a miniapp-declarable permission. `LocalMiniappRuntime` reuses this same constant at install time (Phase 2.16).

5. Creates `<packageName>-<version>.zip` (e.g., `com.example.myapp-1.2.3.zip`) in the project root.
6. Prints the output path.

Implementation: Bun script using Bun file APIs, `qrcode-terminal`, and Bun's child_process wrapper for spawning the dev server.

### 3.5 Production Build + ZIP Packaging

```bash
bun run build     # bun build ./index.html --outdir=./dist --target=browser
bun run pack      # invokes mentra-miniapp-pack
```

Output: `<packageName>-<version>.zip` ready to install via `Composer.installFromUrl()` or publish to the store.

### 3.6 Installing Dev Builds on a Test Device

Two paths:

1. **Dev server + QR** (Phase 3.2/3.3) — hot reload, terminal log streaming. Primary workflow.
2. **Install ZIP** — `bun run build && bun run pack`, upload the ZIP to any HTTP host, use an "Install from URL" dev screen in MentraOS to install via `Composer.installFromUrl()`. Exercises the full production bundle path.

### 3.7 Advanced Debugging (Doc-Only)

For cases where terminal `console.log` is insufficient (breakpoints, network inspection, DOM inspection, React DevTools), USB WebView debugging is the fallback. Document in the scaffolder's generated README:

**Android (Chrome DevTools):**

1. Plug phone into laptop with USB, enable USB debugging
2. Chrome → `chrome://inspect/#devices`
3. Find the WebView entry, click "inspect"
4. Full Chrome DevTools attached

**iOS (Safari Web Inspector):**

1. Plug phone into Mac with USB
2. iPhone: Settings → Safari → Advanced → Web Inspector → ON
3. Safari (Mac): Preferences → Advanced → Show Develop menu in menu bar
4. Develop menu → [iPhone name] → [miniapp WebView]

Requires MentraOS built in debug mode. Dev builds are WebView-debuggable by default on both iOS and Android via React Native WebView. No extra flags or implementation work.

---

## Phase 4: Web App Fallback (Apple Safety Net) — Exploratory, Android-First

**Status:** Exploratory. Android-first implementation; iOS viability is an open investigation — see 4.5.

**Goal:** If Apple forces webviews out of the native app, local miniapps can run in Safari and still talk to MentraOS over a localhost WebSocket.

### 4.1 Start MiniSockets

`mobile/src/services/MiniSockets.ts` defines a WebSocket server on `ws://127.0.0.1:8765` but `start()` is never called. Start it in `MantleManager.init()` conditionally (only if the user has at least one installed third-party local miniapp).

Handle background/foreground lifecycle: stop on background (iOS may suspend), restart on foreground.

### 4.2 Protocol Routing

Phase 2.3's envelope protocol works over MiniSockets the same way it works over postMessage. In `MiniSockets.ts`:

- When a text frame arrives, parse as envelope
- Route to `LocalMiniappRuntime.handleMessage(packageName, payload)`
- Add `sendToClient(clientId, message)` method (currently only has broadcast `sendMessage`)
- LocalMiniappRuntime tracks `clientId` per connected miniapp

### 4.3 App Launch Flow

1. User taps "Open App" in MentraOS
2. MentraOS opens Safari with the app's URL + auth tokens as query params
3. App loads, SDK detects browser environment (no `window.ReactNativeWebView`), connects to `ws://127.0.0.1:8765`
4. `CONNECT` request with auth token in the payload
5. LocalMiniappRuntime handles it identically to a postMessage miniapp

### 4.4 Limitations

- Only same-device (localhost)
- Safari must be open — no background execution
- Slight latency vs postMessage (TCP vs direct bridge)
- iOS may prompt for local network permission (already configured in `app.config.ts`)

### 4.5 iOS Viability — Open Investigation

A localhost WebSocket server inside MentraOS is unreliable on iOS when Safari is foregrounded and the RN app is backgrounded. iOS kills the listening socket shortly after background entry unless MentraOS holds a long-lived background task for an approved reason (audio, VoIP, location, etc.).

Open questions that must be answered before Phase 4 ships on iOS:

1. **Background suspension behavior**: install a MiniSockets build on a device, launch a miniapp in Safari, background MentraOS, observe whether the WebSocket stays connected after 30s / 2min / 10min.
2. **BLE keep-alive effect**: MentraOS already holds a BLE connection for glasses. Verify whether that alone keeps the listening socket alive across background entry.
3. **Fallback options** if (1) and (2) fail: (a) wake MentraOS via universal links when a miniapp sends a message, (b) require the user to foreground MentraOS before launching the miniapp, (c) drop iOS from Phase 4 and ship WebView-only for iOS.

Phase 4 is **Android-first**. On Android, foreground services + the existing BLE service keep MentraOS alive, so the localhost WebSocket survives background. iOS is blocked on the investigation above.

---

## Phase 5: Photos and Streaming

Phase 5 adds photo capture and streaming to local miniapps. All three sub-phases (5.1 photos, 5.2 unmanaged streaming, 5.3 managed streaming) follow the same pattern:

1. Phone sends requests over the existing phone↔cloud WS with `packageName: "__phone__"`.
2. Cloud handlers add `__phone__` bypasses to skip `isAppRunning` / installed-app lookups.
3. Response traffic flows back via `AppManager.sendMessageToApp("__phone__", ...)`, whose Phase 2.5 bypass rewrites app-bound messages into `phone_*` envelopes on `userSession.websocket`.
4. `LocalMiniappRuntime` translates `phone_*` envelopes into `miniapp_response` / `miniapp_stream` frames to the originating miniapp.

Cloudflare API keys and R2 credentials stay on cloud — phone is just another requester identity, same trust level as a cloud app.

Until Phase 5 ships, photo/streaming methods on a local miniapp noop:

```
console.warn("Photo requests not yet supported for local miniapps (deferred to Phase 5)")
```

### 5.1 Photo Requests (Cloud-Hosted Upload)

#### Transport

Local miniapps have no server, so glasses cannot upload to an app-hosted webhook the way the cloud-app photo flow does (`PhotoManager.requestPhoto` → `${app.publicUrl}/photo-upload`). Cloud-hosted upload is the only transport that works across all connectivity combinations:

| Glasses         | Phone         | Path                                                      | Works |
| --------------- | ------------- | --------------------------------------------------------- | ----- |
| WiFi            | WiFi          | Glasses → cloud direct                                    | ✅    |
| WiFi            | Cellular      | Glasses → cloud direct                                    | ✅    |
| Cellular tether | any           | Glasses → cloud direct                                    | ✅    |
| BLE-only        | WiFi/Cellular | Glasses → phone (BLE) → cloud via `BlePhotoUploadService` | ✅    |

#### End-to-end flow

```
┌─────────────┐  1 request photo    ┌──────────────────────┐
│  Miniapp    ├────────────────────►│ LocalMiniappRuntime  │
│  (WebView)  │                     │ (phone)              │
└──────┬──────┘                     └──────────┬───────────┘
       │                                       │ 2 permission check
       │                                       │ (phone-local, via askPermissionsUI)
       │                                       │
       │                                       │ 3 POST /api/client/miniapp-photo/request
       │                                       │    { requestId, packageName, size, compress }
       │                                       ▼
       │                             ┌──────────────────────┐
       │                             │ Cloud REST handler   │
       │                             │  - mint signed       │
       │                             │    upload URL        │
       │                             │  - register pending  │
       │                             │    request           │
       │                             └──────────┬───────────┘
       │                                       │ 4 PHOTO_REQUEST (existing wire type)
       │                                       │    webhookUrl = signed cloud URL
       │                                       │    authToken  = upload token
       │                                       ▼
       │                             ┌──────────────────────┐
       │                             │ Smart glasses        │
       │                             └──────────┬───────────┘
       │                                       │ 5a direct WiFi upload       ┌───────────┐
       │                                       ├────────────────────────────►│ Cloud     │
       │                                       │                             │ /upload   │
       │                                       │ 5b BLE fallback             │ (R2)      │
       │                                       │    glasses → phone →        │           │
       │                                       │    BlePhotoUploadService →  │           │
       │                                       │    same cloud /upload       │           │
       │                                       │                             └─────┬─────┘
       │                                       │                                   │ 6 store in R2
       │                                       │                                   │   mark request done
       │                                       │                                   │
       │                                       │     7 phone_photo_ready           │
       │                                       │◄──────────────────────────────────┘
       │                                       │    (over existing phone↔cloud WS)
       │                                       │    { requestId, photoUrl }
       │                                       │
       │ 8 miniapp_response (photo.taken)      │
       │◄──────────────────────────────────────┘
       ▼
```

**Step key:**

1. Miniapp calls `session.camera.takePhoto({ size, compress })` → returns a `Promise<PhotoTaken>` where `photo` is a URL string (not a Buffer — miniapp is browser-side).
2. `LocalMiniappRuntime` checks `appletStatusStore.manifest.permissions` for `CAMERA`; if missing, rejects immediately without hitting cloud.
3. Phone calls new cloud REST endpoint. Auth: existing `coreToken` (same as other phone↔cloud REST calls).
4. Cloud mints a short-TTL signed upload URL + upload token, registers the pending request in `userSession.phonePhotoManager.pendingRequests` (keyed by `requestId`), and sends the existing `PHOTO_REQUEST` message to glasses — same wire format as cloud apps use — with the signed URL as `webhookUrl`.
5. Glasses upload over their available transport:
   - **Direct WiFi**: glasses POST multipart JPEG to the signed cloud URL. No phone involvement.
   - **BLE fallback**: MentraLive routes photo bytes to the phone over BLE. `BlePhotoUploadService.processAndUploadPhoto()` decodes AVIF→JPEG and POSTs to `webhookUrl`. The `webhookUrl` is opaque from BlePhotoUploadService's perspective, so the cloud URL requires no phone-side code changes.
6. Cloud `/upload` handler verifies the upload token, writes to R2 under `miniapp_photos/{userId}/{requestId}-{filename}`, resolves the pending request.
7. Cloud sends `phone_photo_ready` over `userSession.websocket` (the single phone↔cloud socket, Phase 2.5a). Payload: `{ requestId, photoUrl, mimeType, size }`.
8. `LocalMiniappRuntime` looks up `requestId` → matching pending request → sends `miniapp_response` envelope to the originating miniapp WebView with `{ photoUrl }`. Miniapp Promise resolves.

#### New cloud surface

**REST endpoint: `POST /api/client/miniapp-photo/request`**

- Auth: `coreToken`
- Body: `{ requestId: string, packageName: string, size: "small"|"medium"|"large", compress?: string, saveToGallery?: boolean, sound?: boolean }`
- Response: `{ accepted: true, requestId }`. Cloud holds the signed upload URL and `uploadToken` internally; phone never sees them. Phone waits for `phone_photo_ready` over the WS.

**REST endpoint: `POST /api/client/miniapp-photo/upload/:requestId`**

- Auth: `Bearer <uploadToken>` minted in step 4 (separate from `coreToken`, single-use, 2-minute TTL)
- Body: multipart `photo` file (same format `BlePhotoUploadService` already sends)
- Action: verify token, upload to R2 via `R2StorageService`, resolve the pending request, emit `phone_photo_ready` on `userSession.websocket`.
- Reuse `photos.routes.ts` scaffolding, add a new handler that diverges from the glasses JWT path.

**Route registration (all three steps required):**

1. Create `cloud/packages/cloud/src/api/hono/client/miniapp-photo.api.ts` — default-exports a Hono app with `/request` and `/upload/:requestId` routes.
2. Add to the barrel in `cloud/packages/cloud/src/api/hono/client/index.ts`: `export { default as miniappPhotoApi } from "./miniapp-photo.api";`
3. Mount in `cloud/packages/cloud/src/hono-app.ts` near line 315 (alongside `app.route("/api/client/photo", photoApi)`): `app.route("/api/client/miniapp-photo", miniappPhotoApi);`

**New WS message: `phone_photo_ready`**

- Direction: cloud → phone client
- Payload: `{ type: "phone_photo_ready", requestId, photoUrl, mimeType, size, timestamp }`
- Add to the `CloudToGlassesMessage` discriminated union (cloud-to-phone direction on the single glasses-ws, which IS the phone client socket on the phone side — see Phase 2.5a).

**New cloud component: `PhonePhotoManager`** (`cloud/packages/cloud/src/services/session/PhonePhotoManager.ts`, NEW file)

- Owned by `UserSession` as `userSession.phonePhotoManager`. Parallel to `UserSession.photoManager` but scoped to phone-initiated requests.
- Tracks pending miniapp photo requests: `Map<requestId, { packageName, timestamp, uploadToken }>`.
- Sends `PHOTO_REQUEST` to glasses via `userSession.websocket.send(...)`.
- On upload completion, emits `phone_photo_ready` on `userSession.websocket`.

#### Storage

- **Backend**: `R2StorageService`, new object key prefix `miniapp_photos/{userId}/{requestId}-{timestamp}.jpg`. Existing R2 credentials and bucket (`R2_BUCKET_NAME`).
- **TTL**: R2 lifecycle rule on `miniapp_photos/` prefix → 24h expiration. Document in `@mentra/miniapp` `camera.takePhoto()` JSDoc that photos are not persisted beyond 24h.
- **URL model**: public R2 custom domain (`${R2_PUBLIC_URL}/miniapp_photos/...`). Path contains a UUID; URL is treated as a capability token.

#### Auth model

Two distinct tokens:

1. **coreToken** — gates `POST /miniapp-photo/request`. Proves the phone is a legitimate MentraOS client.
2. **uploadToken** — gates `POST /miniapp-photo/upload/:requestId`. Minted by cloud, sent to glasses as `authToken` in `PHOTO_REQUEST`, valid for one upload within 2 minutes, scoped to a single `requestId`. Implementation: signed JWT with `{ requestId, userId, exp }` using a new `MINIAPP_PHOTO_UPLOAD_SECRET` env var.

#### Error paths

| Failure                   | Detection                             | Behavior                                                                                                                                   |
| ------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Permission not declared   | Phone, step 2                         | Reject Promise with `PERMISSION_DENIED` before network call                                                                                |
| Glasses disconnected      | Cloud, step 4                         | Cloud returns 503 on `/request`; phone rejects Promise                                                                                     |
| Glasses capture timeout   | Cloud, 30s timer on pending request   | Cloud emits `phone_photo_ready` with `error: "TIMEOUT"`                                                                                    |
| Upload fails (network)    | Cloud, no upload within TTL           | Same 30s timer → `error: "UPLOAD_FAILED"`                                                                                                  |
| BLE fallback decode fails | Phone `BlePhotoUploadService` onError | Phone POSTs `/miniapp-photo/upload/:requestId?error=DECODE_FAILED` (new error reporting param), cloud emits `phone_photo_ready` with error |
| Upload token expired      | Cloud `/upload` handler               | Returns 401; glasses-side retry is a future concern                                                                                        |

#### Permission check location

Phone-side only:

- Installation flow populates `appletStatusStore` with `permissions` from `miniapp.json`.
- `askPermissionsUI` maps `AppletPermission[]` → OS permission prompts at install.
- `LocalMiniappRuntime.handleCameraRequest` re-checks the manifest before calling cloud. If the miniapp never declared `CAMERA`, reject without round-tripping.

Cloud does not re-validate permissions for `__phone__` requests.

#### Files touched

**Cloud (new):**

- `cloud/packages/cloud/src/services/session/PhonePhotoManager.ts` — new file, mirrors `PhotoManager.ts` but scoped to phone-initiated miniapp photo requests. Owned by `UserSession`, not by `PhoneSession`.
- `cloud/packages/cloud/src/api/hono/client/miniapp-photo.api.ts` — new file with `/request` and `/upload/:requestId` handlers
- `cloud/packages/cloud/src/services/storage/r2-storage.service.ts` — add `uploadMiniappPhoto()` helper
- `cloud/packages/cloud/src/api/hono/index.ts` — register new route at `/api/client/miniapp-photo`

**Cloud (modified):**

- `cloud/packages/cloud/src/services/session/UserSession.ts` — instantiate `phonePhotoManager: PhonePhotoManager` in the constructor alongside the existing `photoManager` field
- `cloud/packages/cloud/src/api/hono/routes/photos.routes.ts` — or new file, add miniapp upload handler parallel to glasses `/upload`

**Mobile (new):**

- `mobile/src/services/miniapp/MiniappPhotoHandler.ts` — new file, handles `camera.takePhoto` request from miniapp, posts to `/api/client/miniapp-photo/request`
- `mobile/src/services/SocketComms.ts` — add `handle_phone_photo_ready` case in the WS message switch, routes to `LocalMiniappRuntime.resolvePhotoRequest(requestId, photoUrl)`

**Miniapp SDK (new):**

- `sdk/miniapp/src/modules/camera.ts` — `CameraModule.takePhoto()` sends `miniapp_request` with `type: "camera.take_photo"`, waits for `miniapp_response`

**Env:**

- `MINIAPP_PHOTO_UPLOAD_SECRET` — new secret for upload JWT signing
- R2 lifecycle rule on `miniapp_photos/` prefix → 24h expiration (cloud infra config, not code)

#### What does NOT change

- `BlePhotoUploadService.java` / `MentraLive.swift` — already POST to whatever webhook URL they receive; the cloud URL is opaque from their perspective.
- Existing cloud app photo flow (`PhotoManager.requestPhoto`) — unchanged.
- `PHOTO_REQUEST` wire format to glasses — unchanged (same fields, different webhook URL).
- `PHOTO_RESPONSE` from glasses to cloud — unchanged.

### 5.2 Unmanaged Streaming

Phone sends `stream_request` (`AppToCloudMessageType.STREAM_REQUEST`) and `stream_stop` (`STREAM_STOP`) over the phone↔cloud WS with `packageName: "__phone__"`. Cloud routes them to `UnmanagedStreamingExtension` unchanged.

Status flows back via `UnmanagedStreamingExtension.sendStreamStatusToApp` at line 601, which already routes through `AppManager.sendMessageToApp(...)` — the Phase 2.5 `__phone__` bypass handles it without any `UnmanagedStreamingExtension` refactor.

#### End-to-end flow

```
Miniapp  ──►  LocalMiniappRuntime ──►  Cloud (UnmanagedStreamingExtension) ──►  Glasses
   │              │  stream_request                                            │
   │              │  { packageName: "__phone__", streamUrl, video, audio }     │
   │              │                                                            │
   │              │                                                    RTMP to
   │              │                                                    app-provided URL
   │              │                                                            │
   │              │◄─────── phone_stream_status ───────────────────────────────┤
   │◄─────────────┤
   │  miniapp_stream
```

#### Cloud changes

**`UnmanagedStreamingExtension.startStream`** (line 88): add `__phone__` bypass before `isAppRunning` check:

```ts
if (packageName !== "__phone__" && !this.userSession.appManager.isAppRunning(packageName)) {
  throw new Error(`App ${packageName} is not running`)
}
```

Same bypass in `stopStream` (line 538) and any other ownership checks.

**New dispatcher cases in `glasses-message-handler.ts`** for `stream_request` / `stream_stop` received from the phone client WS: construct `StreamRequest` / `StreamStopRequest` with `packageName: "__phone__"` and call `userSession.unmanagedStreamingExtension.startStream(...)` / `stopStream(...)`. Same internal shape as `handleStartStream` / `handleStopStream` in `app-message-handler.ts:428,456`.

**`AppManager.sendMessageToApp("__phone__", statusMessage)`** — Phase 2.5 bypass rewrites the outbound envelope: `STREAM_STATUS` → `phone_stream_status` and sends via `userSession.websocket`. Drop the legacy `rtmp_stream_status` duplicate on the `__phone__` path (phone wants one message per status change).

#### Phone changes

**`LocalMiniappRuntime.handleStreamRequest(miniappRequest)`**:

- Maps `stream.startUnmanaged` → sends `stream_request` over phone client WS with `packageName: "__phone__"`, `requestId: miniappRequest.requestId`, and the miniapp-provided RTMP URL
- Maps `stream.stop` → sends `stream_stop`
- Forwards any incoming `phone_stream_status` to the originating miniapp as `miniapp_stream` envelope with stream lifecycle events

**`SocketComms.ts`**: add case for `phone_stream_status` → `LocalMiniappRuntime.handleStreamStatus(statusMessage)`

**Keep-alive**: `UnmanagedStreamingExtension` runs its own keep-alive loop per stream. Phone sends start/stop only; it never pumps keep-alives.

#### Miniapp SDK

**`sdk/miniapp/src/modules/stream.ts`** — `StreamModule.startUnmanaged(rtmpUrl, options)` returns `AsyncIterable<StreamStatus>` (or a Promise+event-emitter, matching current `@mentra/sdk` shape). Waits for the first `ACTIVE` status before resolving.

---

### 5.3 Managed Streaming

`ManagedStreamingExtension` orchestrates Cloudflare provisioning server-side. Cloudflare API keys never leave cloud. Phone sends `managed_stream_request`, cloud provisions via `CloudflareStreamService`, cloud returns HLS/DASH/WebRTC URLs, phone forwards them to the miniapp.

#### Design

Identical pattern to 5.2 but routed to `ManagedStreamingExtension` instead. Phone sends:

- `managed_stream_request` with `packageName: "__phone__"`, `streamId` (client-generated UUID), and optional `restreamDestinations` (array of RTMP URLs — miniapp can still push to its own destinations)
- `managed_stream_stop` with the same `streamId`

Cloud returns via `phone_managed_stream_status` on the phone client WS. Status payload contains the cloud-managed URLs (`hlsUrl`, `dashUrl`, `webrtcUrl`) — same as today for cloud apps.

#### Cloud changes

**`ManagedStreamingExtension.startManagedStream`** (line 67): add `__phone__` bypass for any `isAppRunning`-style ownership checks. Accept `packageName === "__phone__"` as a valid requester.

**`StreamRegistry`**: multi-app viewing already works for managed streams (one requester, many viewers). `__phone__` is just another requester/viewer identity.

**Refactor required — `ManagedStreamingExtension.sendStatusToApp` at line 1079.** Currently reads `userSession.appWebsockets.get(packageName)` directly, bypassing `AppManager.sendMessageToApp`. Refactor to route all status delivery through `sendMessageToApp`:

```ts
// Before (line 1079):
const appWs = userSession.appWebsockets.get(packageName);
if (!appWs || appWs.readyState !== WebSocket.OPEN) { ... return; }
// ... constructs statusMessage, calls appWs.send(JSON.stringify(statusMessage))

// After:
const result = await userSession.appManager.sendMessageToApp(packageName, statusMessage);
if (!result.sent) {
  this.logger.warn({ packageName, streamId }, "Status delivery failed");
  const statusKey = `${streamId}:${packageName}`;
  this.lastSentStatus.delete(statusKey);
  return;
}
```

After the refactor, the Phase 2.5 `__phone__` bypass in `AppManager.sendMessageToApp` rewrites `MANAGED_STREAM_STATUS` → `phone_managed_stream_status` on the outbound `userSession.websocket`. Cloud apps see no behavior change — they already receive `MANAGED_STREAM_STATUS` on their app WS, just via `sendMessageToApp` instead of a direct socket write.

**New dispatcher cases in `glasses-message-handler.ts`** for `managed_stream_request` / `managed_stream_stop` that call `userSession.managedStreamingExtension.startManagedStream(...)` / `stopManagedStream(...)` with `packageName: "__phone__"`.

**Restream destinations**: existing `ManagedStreamRequest.restreamDestinations` field works unchanged. Phone passes them through from the miniapp.

#### Phone changes

Same `LocalMiniappRuntime` changes as 5.2, mapping `stream.startManaged` → `managed_stream_request` and handling `phone_managed_stream_status` on the return trip.

#### Miniapp SDK

**`StreamModule.startManaged(options)`** — mirrors `@mentra/sdk`'s `ManagedStreamRequest`. Returns playback URLs once the cloud has provisioned the Cloudflare Live Input.

#### Files touched for 5.2 + 5.3

**Cloud (modified):**

- `cloud/packages/cloud/src/services/session/UnmanagedStreamingExtension.ts` — `__phone__` bypasses in `startStream` / `stopStream`. Status path already routes through `sendMessageToApp` (line 601) so no refactor here.
- `cloud/packages/cloud/src/services/streaming/ManagedStreamingExtension.ts` — (a) `__phone__` bypasses in `startManagedStream` / `stopManagedStream`, (b) **refactor `sendStatusToApp` at line 1079** to route through `userSession.appManager.sendMessageToApp(packageName, statusMessage)` instead of reading `appWebsockets.get(packageName)` directly. This is required for the Phase 2.5 `__phone__` bypass to apply, and also aligns managed streaming's messaging path with unmanaged streaming.
- `cloud/packages/cloud/src/services/session/handlers/glasses-message-handler.ts` — new cases for `stream_request` / `stream_stop` / `managed_stream_request` / `managed_stream_stop` when received from the phone client WS, constructing requests with `packageName: "__phone__"` and calling the same extension methods `app-message-handler.ts` calls.
- `cloud/packages/cloud/src/services/session/AppManager.ts` — the `sendMessageToApp` `__phone__` bypass (already introduced in Phase 2.5 for data streams and photo) adds message-type rewrites for streaming: `STREAM_STATUS` → `phone_stream_status`, `MANAGED_STREAM_STATUS` → `phone_managed_stream_status`. Drops the legacy `rtmp_stream_status` duplicate on the `__phone__` path.

**Mobile (modified):**

- `mobile/src/services/miniapp/LocalMiniappRuntime.ts` — new stream request/status mapping
- `mobile/src/services/SocketComms.ts` — cases for `phone_stream_status` and `phone_managed_stream_status`

**Miniapp SDK (new):**

- `sdk/miniapp/src/modules/stream.ts` — `StreamModule.startUnmanaged`, `startManaged`, `stop`

#### What does NOT change

- `CloudflareStreamService` — untouched. Cloud still holds the API key.
- Glasses wire protocol (`CloudToGlassesMessageType.START_STREAM = "start_stream"` from cloud to glasses, etc. — see `cloud/packages/sdk/src/types/message-types.ts:89`) — untouched. Glasses don't know a phone vs app is requesting.
- Existing cloud-app stream path — the `ManagedStreamingExtension.sendStatusToApp` refactor is a pure internal routing change with identical observable behavior for cloud apps (they receive `MANAGED_STREAM_STATUS` the same way, just through `sendMessageToApp` instead of direct socket write).
- Keep-alive pumping — cloud handles it per-stream, phone never touches it.

---

## Phase 6: Cloud Apps → Local Miniapps Migration

Migration of existing cloud apps is out of scope for this plan. `@mentra/sdk` and all cloud apps continue to work unchanged throughout Phases 1-5. Per-app migration path (performed by the app owners):

1. Create a new miniapp project via `create-mentra-miniapp`.
2. Port UI and logic to `@mentra/miniapp/react` and the static bundle format.
3. Remove the server backend, or keep it as a separate service for cloud-specific features.
4. Submit the new miniapp ZIP to the store.
5. Deprecate the old cloud app once users migrate.

Archiving `@mentra/sdk` and `@mentra/react` is out of scope.

---

## Implementation Order

Phases are numbered for organization, not strict sequencing. Phase 1 and Phase 2 can be built in parallel once the protocol enums in `@mentra/miniapp/src/protocol.ts` (1.3) are defined.

1. **Phase 1** — Create `@mentra/miniapp` package (`protocol.ts`, transports, `MiniappSession`, modules, React hooks) in `sdk/miniapp/`. Add `build:miniapp` to `sdk/package.json`. No phone or cloud changes in this phase.
2. **Phase 2** — Phone runtime:
   - 2.1 `LocalMiniappRuntime` singleton, initialized during `MantleManager.init()` after `SocketComms` auth
   - 2.2 Envelope protocol + 2.3 MiniComms refactor + 2.4 request handlers
   - 2.5 Cloud stream subscription via synthetic `__phone__` AppSession (cloud-side work)
   - 2.6 Event forwarding + translation table
   - 2.9 Mic lifecycle via `MicStateCoordinator`
   - 2.10 Composer rewrite with `miniapp.json` parsing + permission population
   - 2.12 WebView lifecycle + file URI bundle loading + `local.tsx` / `LocalMiniApp.tsx` rewrite
   - 2.12a `MiniappHost` offscreen WebView ownership + keepalive ping + visibility API + iOS eviction debugging
   - 2.13 Simple Storage
   - 2.16 Permission gate
   - 2.14 Dashboard is a noop (no work)
3. **Phase 3** — Developer tooling:
   - 3.1 `create-mentra-miniapp` scaffolder
   - 3.4 `@mentra/miniapp-cli` `dev` + `pack` commands
   - 3.3 Phone-side "Miniapp Developer" screen + QR scanner
   - 3.2 Dev loop verification end-to-end
4. **Phase 4** — Web app fallback (Android-first; iOS exploratory per 4.5).
5. **Phase 5** — Photos + streaming.

**Minimum viable subset for first runnable test miniapp:** 2.1, 2.2, 2.3, 2.4 (display), 2.10 (loading), 2.12 (WebView lifecycle), 2.12a (`MiniappHost` — needed from day one because route-owned WebViews would unmount on back-navigation). Mic, subscriptions, and storage can land afterward.

---

## Testing

E2E verification is human-driven for v1. No E2E automation.

**Targeted unit tests required:**

1. **Envelope parsing** (`sdk/miniapp/src/envelope.test.ts`) — encode/decode round-trip, malformed input rejection, `requestId` handling, binary base64.
2. **Composer manifest validation** (`mobile/src/services/__tests__/Composer.test.ts`) — valid `miniapp.json`, missing fields, legacy `app.json` fallback, invalid permissions.
3. **Synthetic `__phone__` routing** (`cloud/packages/cloud/src/services/session/__tests__/AppManager.phone.test.ts`) — `sendMessageToApp("__phone__", ...)` routes to client WebSocket, `getOrCreateAppSession("__phone__")` is idempotent, `SubscriptionManager.processSubscriptionUpdate` skips DB lookup for `__phone__`.
4. **MicStateCoordinator state machine** (`mobile/src/services/__tests__/MicStateCoordinator.test.ts`) — union of cloud + local requirements, enable/disable transitions.
5. **Protocol enum wire values** (`sdk/miniapp/src/protocol.test.ts`) — assert enum values match expected strings. Catches rename drift.

**Human verification checkpoints:**

1. **Phase 1:** `@mentra/miniapp` builds cleanly (`tsc` exits 0). A minimal consumer project imports `MiniappSession`, bundles with Bun Fullstack, runs in Chrome without crashing. Existing cloud apps continue to work.
2. **Phase 2 display:** drop a test miniapp into `Paths.document/lmas/com.test.hello/1.0.0/`, open it, verify `session.layouts.showTextWall("hello")` renders on glasses.
3. **Phase 2 subscriptions:** a miniapp calling `session.events.onTranscription(...)` receives transcription data via the synthetic `__phone__` AppSession path.
4. **Phase 3:** `bunx create-mentra-miniapp test-app && cd test-app && bun dev` runs, prints a QR code. Scanning the QR from MentraOS (Mentra Developer Mode → Miniapp Developer) loads the miniapp on glasses, `console.log` streams to the terminal, code edits hot-reload.
5. **Phase 4:** the miniapp opens in Safari with a generated auth token and connects through MiniSockets end-to-end.

---

## Key Files

### New package: `@mentra/miniapp`

| File                                        | Change                                                                                                                                                                                                                                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sdk/miniapp/package.json`                  | NEW — miniapp SDK package manifest (see Phase 1.2)                                                                                                                                                                                                                                             |
| `sdk/miniapp/tsconfig.json`                 | NEW — browser-targeted TS config (no Node lib, no Node types)                                                                                                                                                                                                                                  |
| `sdk/miniapp/src/index.ts`                  | NEW — public exports (MiniappSession + types)                                                                                                                                                                                                                                                  |
| `sdk/miniapp/src/session.ts`                | NEW — `MiniappSession` class                                                                                                                                                                                                                                                                   |
| `sdk/miniapp/src/protocol.ts`               | NEW — wire protocol enums (`MiniappRequestType`, `MiniappResponseType`, `MiniappStreamType`). Fresh miniapp-naming, no legacy `tpa_*`. See Phase 1.3.                                                                                                                                          |
| `sdk/miniapp/src/envelope.ts`               | NEW — bridge envelope format `{kind, payload, requestId}`                                                                                                                                                                                                                                      |
| `sdk/miniapp/src/transport/types.ts`        | NEW — Transport interface                                                                                                                                                                                                                                                                      |
| `sdk/miniapp/src/transport/postmessage.ts`  | NEW — WebView bridge transport                                                                                                                                                                                                                                                                 |
| `sdk/miniapp/src/transport/local-socket.ts` | NEW — browser WebSocket transport                                                                                                                                                                                                                                                              |
| `sdk/miniapp/src/transport/auto.ts`         | NEW — auto-detection                                                                                                                                                                                                                                                                           |
| `sdk/miniapp/src/modules/layouts.ts`        | NEW — LayoutManager                                                                                                                                                                                                                                                                            |
| `sdk/miniapp/src/modules/events.ts`         | NEW — EventManager (eventemitter3)                                                                                                                                                                                                                                                             |
| `sdk/miniapp/src/modules/audio.ts`          | NEW — `play()`, `speak()` (sends SPEAK request — phone constructs TTS URL)                                                                                                                                                                                                                     |
| `sdk/miniapp/src/modules/camera.ts`         | NEW — `takePhoto()` noop+warn in v1                                                                                                                                                                                                                                                            |
| `sdk/miniapp/src/modules/dashboard.ts`      | NEW — `DashboardAPI.setContent()` noop+warn in v1 (deferred)                                                                                                                                                                                                                                   |
| `sdk/miniapp/src/modules/led.ts`            | NEW — LedModule                                                                                                                                                                                                                                                                                |
| `sdk/miniapp/src/modules/storage.ts`        | NEW — SimpleStorage (bridge to phone AsyncStorage)                                                                                                                                                                                                                                             |
| `sdk/miniapp/src/react/index.ts`            | NEW — React hooks exports (v1: only `useSession`)                                                                                                                                                                                                                                              |
| `sdk/miniapp/src/react/useSession.ts`       | NEW — zero-config session hook                                                                                                                                                                                                                                                                 |
| `sdk/package.json`                          | NEW — SDK workspace root. `"workspaces": ["*"]`, `"build:miniapp": "cd miniapp && bun run build"`, `"build": "bun run build:miniapp"`, `"test": "cd miniapp && bun test"`. Cloud's `package.json` does NOT reference miniapp — SDK packages are built from the `sdk/` workspace independently. |

### Unit tests (Phase 1 + Phase 2)

| File                                                                           | Change                                                              |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| `sdk/miniapp/src/envelope.test.ts`                                             | NEW — envelope parse/serialize roundtrip, malformed input rejection |
| `sdk/miniapp/src/protocol.test.ts`                                             | NEW — assert wire values match expected strings                     |
| `mobile/src/services/__tests__/Composer.test.ts`                               | NEW — `miniapp.json` validation, legacy `app.json` fallback         |
| `mobile/src/services/__tests__/MicStateCoordinator.test.ts`                    | NEW — state machine tests                                           |
| `cloud/packages/cloud/src/services/session/__tests__/AppManager.phone.test.ts` | NEW — `__phone__` routing and idempotence                           |

### New package: `create-mentra-miniapp` (scaffolder)

| File                                               | Change                                                                                                                                   |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `sdk/create-mentra-miniapp/package.json`           | NEW — scaffolder CLI package manifest, `bin` entry for `create-mentra-miniapp`                                                           |
| `sdk/create-mentra-miniapp/bin/index.ts`           | NEW — scaffolder entry point. Copies `template/` to target path, replaces `{{packageName}}` placeholders, prints next-step instructions. |
| `sdk/create-mentra-miniapp/template/package.json`  | NEW — starter project package.json with `dev`/`build`/`pack` scripts, `@mentra/miniapp` + `react` + `react-dom` deps                     |
| `sdk/create-mentra-miniapp/template/server.ts`     | NEW — `Bun.serve({ development: { hmr: true, console: true } })` entry with HTML import                                                  |
| `sdk/create-mentra-miniapp/template/index.html`    | NEW — HTML entry with `<script type="module" src="./src/main.tsx">`                                                                      |
| `sdk/create-mentra-miniapp/template/src/main.tsx`  | NEW — React root mount                                                                                                                   |
| `sdk/create-mentra-miniapp/template/src/App.tsx`   | NEW — starter component using `useSession` from `@mentra/miniapp/react`                                                                  |
| `sdk/create-mentra-miniapp/template/miniapp.json`  | NEW — manifest template with `{{packageName}}` placeholder                                                                               |
| `sdk/create-mentra-miniapp/template/icon.png`      | NEW — default icon                                                                                                                       |
| `sdk/create-mentra-miniapp/template/tsconfig.json` | NEW — react-jsx target                                                                                                                   |

### New package: `@mentra/miniapp-cli` (dev helper + packager)

| File                              | Change                                                                                                                                                                                                                                  |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sdk/miniapp-cli/package.json`    | NEW — CLI package manifest, `bin` entries for `mentra-miniapp` command                                                                                                                                                                  |
| `sdk/miniapp-cli/src/index.ts`    | NEW — CLI entry point with `dev` and `pack` subcommands                                                                                                                                                                                 |
| `sdk/miniapp-cli/src/dev.ts`      | NEW — `mentra-miniapp dev` implementation: detect LAN IP via `os.networkInterfaces()`, construct `mentra-miniapp://dev?url=...` URL, print QR code to terminal via `qrcode-terminal`, print URL as fallback, monitor for LAN IP changes |
| `sdk/miniapp-cli/src/pack.ts`     | NEW — `mentra-miniapp pack` implementation: verify `dist/` exists, copy `miniapp.json` + `icon.png` into `dist/`, validate manifest schema + permissions, create `<packageName>-<version>.zip`                                          |
| `sdk/miniapp-cli/src/qr.ts`       | NEW — QR code generation helper using `qrcode-terminal`                                                                                                                                                                                 |
| `sdk/miniapp-cli/src/manifest.ts` | NEW — `miniapp.json` schema validation + `AppPermissionType` validation                                                                                                                                                                 |

### Existing SDK packages

| File                                              | Change                                                                                                                                                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cloud/packages/sdk/`                             | Runtime untouched. Only additive type additions in Phase 2.5 (see Cloud section below).                                                                                                                |
| `cloud/packages/react-sdk/src/useMentraBridge.ts` | **Delete.** Not in the published `@mentra/react` 2.1.2 tarball (`dist/index.d.ts` exports only `MentraAuthProvider`, `useMentraAuth`, `AuthState`). The in-branch version was never published.         |
| `cloud/packages/react-sdk/src/index.ts`           | Remove the `useMentraBridge` re-export line. Keep `MentraAuthProvider` and `useMentraAuth`.                                                                                                            |
| `cloud/packages/react-sdk/dist/`                  | Rebuild after the source delete: `cd cloud/packages/react-sdk && bun run build`. The committed `dist/useMentraBridge.*` files become stale after the source delete and must be regenerated or removed. |
| `cloud/packages/react-sdk/package.json`           | Unchanged.                                                                                                                                                                                             |

### Shared types (`@mentra/types`)

| File                                | Change                                                                                                                                                                                                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud/packages/types/src/index.ts` | No change. `@mentra/miniapp` defines its own wire enums in `src/protocol.ts` (Phase 1.3) and imports non-wire shared types (`Capabilities`, `AppletInterface`, `AppletPermission`, `AppPermissionType`, `HardwareType`, `HardwareRequirementLevel`) from `@mentra/types` via `import type`. |

### Cloud (synthetic `__phone__` AppSession)

| File                                                                            | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cloud/packages/sdk/src/types/message-types.ts`                                 | Add `GlassesToCloudMessageType.PHONE_SUBSCRIPTION_UPDATE = "phone_subscription_update"`. No new cloud-to-glasses enum needed — delivery reuses existing `DataStream` message format (`cloud-to-app.ts` line 224).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `cloud/packages/sdk/src/types/messages/glasses-to-cloud.ts`                     | Add `PhoneSubscriptionUpdate` interface: `{type: PHONE_SUBSCRIPTION_UPDATE, subscriptions: ExtendedStreamType[]}`. **Also add `PhoneSubscriptionUpdate` to the `GlassesToCloudMessage` discriminated union** at the bottom of the file (around line 424) so typed message handlers see it cleanly. Without this, TypeScript won't narrow `PHONE_SUBSCRIPTION_UPDATE` correctly in the handler switch.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `cloud/packages/cloud/src/services/session/AppLikeSession.ts`                   | NEW — shared interface implemented by both `AppSession` and `PhoneSession`. Needed because `AppSession`'s private members block structural assignability. Interface surface: `packageName`, `subscriptions: Set<ExtendedStreamType>`, `locationRate`, `state`, `isDisposed`, `hasSubscription`, `getSubscriptions`, `updateSubscriptions`, `enqueue`, `cleanup`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `cloud/packages/cloud/src/services/session/AppSession.ts`                       | Add `implements AppLikeSession` to the class declaration. No runtime change — the class already exposes all required members.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `cloud/packages/cloud/src/services/session/PhoneSession.ts`                     | NEW — `class PhoneSession implements AppLikeSession`. Does NOT extend `AppSession`. Surface: `packageName: "__phone__"`, `subscriptions: Set<ExtendedStreamType>`, `locationRate`, `hasSubscription(sub)`, `getSubscriptions()`, `updateSubscriptions(newSubs, locationRate?)`, `enqueue(op) { return op() }`, `isDisposed: false`, `state: AppConnectionState.RUNNING`, `cleanup()`. Constructor takes a logger.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `cloud/packages/cloud/src/services/session/AppManager.ts`                       | (a) Retype `apps` from `Map<string, AppSession>` to `Map<string, AppLikeSession>`. Narrow with `instanceof AppSession` at any call site that needs `AppSession`-only members. (b) Add `PHONE_PACKAGE_NAME = "__phone__"` constant. (c) Branch at top of `sendMessageToApp()` (before line 1691): if `packageName === PHONE_PACKAGE_NAME`, call new private `sendToPhoneClient(message)` which does `this.userSession.websocket.send(JSON.stringify(message))`. For Phase 5 streaming, `sendToPhoneClient` also rewrites the outbound type: `CloudToAppMessageType.STREAM_STATUS` → `phone_stream_status`, `CloudToAppMessageType.MANAGED_STREAM_STATUS` → `phone_managed_stream_status`. Photo responses do NOT go through this path — `phone_photo_ready` is emitted directly by the `/upload` handler (see Phase 5.1). (d) Branch in `getOrCreateAppSession()`: if `packageName === PHONE_PACKAGE_NAME`, return/create a cached `PhoneSession` stored in `this.apps`. (e) Filter `__phone__` out of user-facing iteration: `getRunningAppNames()` and any other method exposing running-app state to the client must `.filter(name => name !== PHONE_PACKAGE_NAME)`. `SubscriptionManager.getSubscribedApps()` iteration must NOT filter — the phone session is a real subscriber. |
| `cloud/packages/cloud/src/services/session/SubscriptionManager.ts`              | (a) Widen `processSubscriptionUpdate()` parameter type from `AppSession` to `AppLikeSession` at line 240 (only reads interface members). (b) Explicit branch in `processSubscriptionUpdate()` around line 271: if `packageName === "__phone__"`, skip the `App.findOne()` MongoDB lookup. Set `allowedProcessed = processed` (accept all). Rest of method runs normally (stores subscriptions on the PhoneSession via the existing path).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `cloud/packages/cloud/src/services/session/handlers/glasses-message-handler.ts` | Phase 2.5: new case for `PHONE_SUBSCRIPTION_UPDATE` → call `userSession.appManager.getOrCreateAppSession(PHONE_PACKAGE_NAME)` then `userSession.subscriptionManager.updateSubscriptions(PHONE_PACKAGE_NAME, msg.subscriptions)`. Phase 5: new cases for `stream_request` / `stream_stop` / `managed_stream_request` / `managed_stream_stop` that dispatch to the streaming extensions with `packageName: "__phone__"`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `cloud/packages/cloud/src/services/streaming/ManagedStreamingExtension.ts`      | (Phase 5.3) Refactor `sendStatusToApp` at line 1079 to route through `userSession.appManager.sendMessageToApp(packageName, statusMessage)` instead of reading `userSession.appWebsockets.get(packageName)` directly. Required for the Phase 2.5 `__phone__` bypass to apply to managed stream status. Also adds the `__phone__` ownership bypass in `startManagedStream` / `stopManagedStream`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `cloud/packages/cloud/src/services/session/UnmanagedStreamingExtension.ts`      | (Phase 5.2) Add `__phone__` bypass in `startStream` line 88 and `stopStream` line 538 before `isAppRunning` / ownership checks. Status path already routes through `sendMessageToApp` (line 601), no refactor needed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

### Mobile — SGC native changes for G1 bitmap

| File                                                                     | Change                                                                                                                                                                                         |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mobile/modules/core/ios/Source/sgcs/G1.swift`                           | Add `convertToG1Bmp()` mirroring G2.swift's `convertToG2Bmp()`. Accept arbitrary image data, scale + pad + convert to 1-bit BMP natively. Route local-miniapp bitmap events through this path. |
| `mobile/modules/core/android/src/main/java/com/mentra/core/sgcs/G1.java` | Same for Android                                                                                                                                                                               |

### Mobile services

| File                                              | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mobile/src/services/LocalMiniappRuntime.ts`      | NEW singleton. State: `connectedApps: Map<packageName, {installedManifest, subscriptions, sendMessage, lastPongAt, ...}>`, ref-counted `streamSubscribers: Map<stream, Set<packageName>>`. Responsibilities: bridge envelope routing, miniapp request dispatch (Phase 2.4), TTS URL construction from phone `cloudUrl`, CoreModule event name translation (Phase 2.6), declared-permission check at SUBSCRIBE time (rejects with `MiniappResponseType.ERROR` + `code: "PERMISSION_NOT_DECLARED"`), mic state updates via `MicStateCoordinator`, ping loop with 5s cadence and 3-miss timeout (Phase 2.12a), visibility state management per-miniapp. Initialized in `MantleManager.init()` after `SocketComms.setAuthCreds()`. |
| `mobile/src/components/miniapp/MiniappHost.tsx`   | NEW. Top-level component mounted in `AllProviders`. Holds `Map<packageName, MountedMiniapp>`, one WebView per running miniapp. Foreground WebView renders in the active applet route; backgrounded ones are offscreen (`position: absolute; left: -10000; width: 1; height: 1; opacity: 0`, NOT `display: none`). Exposes `mount(packageName, bundleDir\|devUrl)`, `unmount(packageName)`, `setForeground(packageName)`, `setBackground(packageName)`. Handles `onContentProcessDidTerminate` / `onError` → tear down + `localMiniappRuntime.unregisterApp(packageName)`. In `__DEV__`, shows an `Alert.alert` on eviction so it's visible during development (Phase 2.12a).                                                   |
| `mobile/src/contexts/AllProviders.tsx`            | Mount `<MiniappHost />` inside the provider tree.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `mobile/src/services/MicStateCoordinator.ts`      | NEW — unions cloud-driven and local-miniapp-driven mic requirements, applies final state via `CoreModule.update()`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `mobile/src/services/MiniComms.ts`                | Parse envelope format, route SDK messages to LocalMiniappRuntime. Delete legacy bridge message handlers (`share`, `copy_clipboard`, `download`, `open_url`, `core_fn`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `cloud/packages/react-sdk/src/useMentraBridge.ts` | Duplicate of the entry in "Existing SDK packages" above — see there.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `mobile/src/services/MiniSockets.ts`              | Start from `MantleManager.init()` (conditional). Add `sendToClient(clientId, msg)`. Route incoming text frames through the envelope parser to LocalMiniappRuntime.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `mobile/src/services/SocketComms.ts`              | Add new case in `handle_message()` for incoming `data_stream` messages (transcription/translation deliveries) → dispatch to `localMiniappRuntime.forwardEvent(streamType, data)`. Add `updatePhoneSubscriptions(subs)` method that sends `PHONE_SUBSCRIPTION_UPDATE` to cloud over the client WebSocket. Refactor `handle_microphone_state_change()` (line 454) to call `micStateCoordinator.setCloudRequirements(...)` instead of calling `CoreModule.update("core", {...})` directly.                                                                                                                                                                                                                                        |
| `mobile/src/services/MantleManager.ts`            | Forward local sensor events (location, notifications, calendar) to LocalMiniappRuntime. Initialize LocalMiniappRuntime and MicStateCoordinator. Start MiniSockets conditionally.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `mobile/src/services/DisplayProcessor.ts`         | Already handles display — LocalMiniappRuntime reuses it. No changes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `mobile/src/services/Composer.ts`                 | Rewrite per Phase 2.10. Public API: `initialize()`, `installFromUrl(url)`, `uninstall(packageName, version?)`, `getInstalledMiniapps()`, `getBundleDir(packageName, version)`, `getMiniappManifest(packageName, version)`. Reads `miniapp.json` (with `app.json` fallback). At line 342 replace `permissions: []` with `permissions: miniappJson.permissions?.map(type => ({type, required: true})) ?? []`. Remove duplicate `fanOutPcm` method. Wire `initialize()` from `MantleManager.init()`.                                                                                                                                                                                                                              |

### Mobile UI

| File                                                             | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mobile/src/app/applet/webview.tsx`                              | Branch lifecycle: for local miniapps, skip cloud handshake and fade in on WebView `onLoad`. Inject `window.MentraOS` with packageName + platform. Accept both bundled miniapp paths (file://) and dev server URLs (http://LAN-IP:3000). When loading a dev URL, inject `miniappDeveloperMode: true` in `window.MentraOS`.                                                                                                                                                                                                              |
| `mobile/src/app/applet/local.tsx`                                | Rewrite. Route `/applet/local?packageName=...&version=...` does NOT mount a WebView directly. On mount, calls `MiniappHost.setForeground(packageName, bundleDir\|devUrl)` which either creates the WebView (first open) or moves an existing one into the foreground render target. On unmount (user navigates away), calls `MiniappHost.setBackground(packageName)` which parks the WebView offscreen — the WebView keeps running. Close button in `MiniAppCapsuleMenu` calls `MiniappHost.unmount(packageName)` for a real teardown. |
| `mobile/src/components/home/LocalMiniApp.tsx`                    | Thin wrapper that resolves `packageName` + `bundleDir` or `devUrl` and delegates to `MiniappHost`. Does not own the `<WebView>` directly — ownership lives in `MiniappHost` so the WebView survives route unmounts.                                                                                                                                                                                                                                                                                                                    |
| `mobile/src/app/miniapps/settings/miniapp-developer.tsx`         | NEW — "Miniapp Developer" screen (Phase 3.3). Hidden behind the existing Mentra Developer Mode flag for v1. Buttons: "Scan QR from dev server", "Enter dev URL manually". List of recently-scanned dev miniapps persisted in AsyncStorage.                                                                                                                                                                                                                                                                                             |
| `mobile/src/app/miniapps/settings/miniapp-developer-scanner.tsx` | NEW — Fullscreen QR scanner using `expo-camera`'s `CameraView` with `barcodeScannerSettings={{ barcodeTypes: ['qr'] }}` and `onBarcodeScanned`. Already in `mobile/package.json` (`expo-camera ~55.0.9`). Decodes QR, parses `mentra-miniapp://dev?url=...&name=...&package=...`, fetches `<url>/miniapp.json` for permissions, calls `askPermissionsUI`, navigates to webview route with `isMiniappDev: true`.                                                                                                                        |
| `mobile/src/contexts/DeeplinkContext.tsx`                        | Optional for v1. Only needed for OS-level `mentra-miniapp://` deeplink handling. The v1 flow uses the in-app QR scanner and does not require deeplink changes. If enabled: add scheme detection at the top of `findMatchingRoute()` — if `parsedUrl.protocol === "mentra-miniapp:"`, route to the miniapp developer screen with URL params pre-filled.                                                                                                                                                                                 |
| `mobile/app.config.ts`                                           | Optional for v1. Only needed if OS-level `mentra-miniapp://` handling is enabled. Change `scheme: "com.mentra"` (line 16) to `scheme: ["com.mentra", "mentra-miniapp"]`. Requires a native rebuild.                                                                                                                                                                                                                                                                                                                                    |
| `mobile/src/app/miniapps/settings/miniapp-developer-install.tsx` | NEW — "Install from URL" page. Text input for a ZIP URL, submit button, progress/success/error feedback. On submit calls `Composer.installFromUrl(url)`. On success the miniapp appears in the home screen grid immediately (via `appletStatusStore` update). Accessible from `miniapp-developer.tsx`.                                                                                                                                                                                                                                 |
| `mobile/src/app/miniapps/settings/`                              | Add a "Miniapp Developer" menu item inside the existing Mentra Developer Mode settings screen, linking to `miniapp-developer.tsx`.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `mobile/src/stores/applets.ts`                                   | Add in-memory dev miniapps list (cleared on app restart). Extend `ClientAppletInterface` with `devUrl?: string` and `isMiniappDev?: boolean`. Extend `startApplet()` around line 870: when `applet.isMiniappDev === true`, push to `/applet/local` with `{packageName, devUrl, appName, transition: "zoom"}`. Add this branch before the existing `applet.local` branch.                                                                                                                                                               |

---

## Out of Scope

- **On-device STT fallback**: wiring local Whisper (`STTModelManager.ts`) into LocalMiniappRuntime is a separate workstream.
- **Binary audio output streaming**: v1 uses URL-based playback only.
- **App-to-app messaging** between local miniapps.
- **Settings API**: deprecated, not supported for local miniapps.
- **Cloud miniapp migration**: per-app manual rewrite, see Phase 6.
- **App Store compliance (Apple 4.7)**: parallel workstream.
- **E2E automation**: no scripted phone + glasses + dev server test harness. The five unit test areas in the Testing section are in scope; everything beyond is human verification.
