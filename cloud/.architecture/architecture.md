# MentraOS Cloud Architecture

- author: Isaiah Ballah
- last updated: March 2, 2026

> End-to-end architecture of MentraOS — from smart glasses hardware to developer mini apps.

---

## Table of Contents

- [High-Level Overview](#high-level-overview)
- [The Four Hops](#the-four-hops)
  - [Hop 1: Glasses → Phone (BLE)](#hop-1-glasses--phone-ble)
  - [Hop 2: Phone → Cloud (WebSocket)](#hop-2-phone--cloud-websocket)
  - [Hop 3: Cloud → SDK (Webhook + WebSocket)](#hop-3-cloud--sdk-webhook--websocket)
  - [Hop 4: SDK → Developer Code (Callbacks)](#hop-4-sdk--developer-code-callbacks)
- [Cloud Internals](#cloud-internals)
  - [Entry Points](#entry-points)
  - [UserSession — The Hub](#usersession--the-hub)
  - [Manager Architecture](#manager-architecture)
  - [Message Routing](#message-routing)
- [SDK Internals](#sdk-internals)
  - [AppServer (Hono-based)](#appserver-hono-based)
  - [AppSession](#appsession)
  - [Module System](#module-system)
- [Key Flows](#key-flows)
  - [App Startup Flow](#app-startup-flow)
  - [Data Flow: Glasses → App (Downstream)](#data-flow-glasses--app-downstream)
  - [Data Flow: App → Glasses (Upstream)](#data-flow-app--glasses-upstream)
  - [Subscription System](#subscription-system)
  - [App Lifecycle States](#app-lifecycle-states)
  - [Photo Request/Response Flow](#photo-requestresponse-flow)
  - [Audio Pipeline](#audio-pipeline)
- [WebSocket Protocols](#websocket-protocols)
  - [Glasses ↔ Cloud Messages](#glasses--cloud-messages)
  - [App ↔ Cloud Messages](#app--cloud-messages)
- [Stream Types Reference](#stream-types-reference)
- [Mentra Live: Camera-Equipped Glasses](#mentra-live-camera-equipped-glasses)
  - [Two Types of Glasses](#two-types-of-glasses)
  - [The SGCManager Abstraction](#the-sgcmanager-abstraction)
  - [BLE for Commands, WiFi for Media](#ble-for-commands-wifi-for-media)
  - [Photo Flow (Mentra Live)](#photo-flow-mentra-live)
  - [RTMP Streaming Flow (Mentra Live)](#rtmp-streaming-flow-mentra-live)
  - [Managed Streaming (Cloud-Mediated)](#managed-streaming-cloud-mediated)
  - [CameraNeo: The Camera Service](#cameranneo-the-camera-service)
  - [Camera Web Server (AsgCameraServer)](#camera-web-server-asgcameraserver)
  - [asg_client Directory Map](#asg_client-directory-map)
- [Authentication](#authentication)
- [Directory Map](#directory-map)

---

## High-Level Overview

```
┌──────────────┐     BLE      ┌──────────────┐   WebSocket    ┌──────────────┐  Webhook+WS   ┌──────────────┐
│  asg_client  │◄────────────►│    mobile     │◄──────────────►│    cloud     │◄─────────────►│     SDK      │
│  (Glasses)   │              │   (Phone)     │  /glasses-ws   │   (Backend)  │   /app-ws     │ (Mini App)   │
│              │              │              │                │              │  /webhook     │              │
│ Android app  │              │ React Native │                │  Bun server  │               │ Hono server  │
│ android_core │              │    Expo      │                │  TypeScript  │               │  TypeScript  │
└──────────────┘              └──────────────┘                └──────────────┘               └──────────────┘
     Hardware                     Bridge                      Central Hub                   Developer Code
```

**MentraOS** is a smart glasses operating system. The architecture consists of four layers connected by two protocols (BLE and WebSocket/HTTP). The **cloud** acts as the central hub — it bridges data from the user's glasses to any number of third-party mini apps.

---

## The Four Hops

### Hop 1: Glasses → Phone (BLE)

| Component | Location | Language |
|-----------|----------|----------|
| `asg_client` | `/asg_client` | Java/Android |
| `android_core` | `/android_core` | Java/Android (shared library) |
| `mobile` (iOS native) | `/mobile/ios` | Swift |
| `mobile` (RN bridge) | `/mobile/modules/core` | TypeScript + Native |

The `asg_client` is an Android app running directly on the smart glasses hardware. It uses `android_core` as a library for common functionality (display rendering, BLE communication, sensor access).

The phone runs the **MentraOS mobile app** (React Native/Expo) which connects to the glasses via **Bluetooth Low Energy**. The phone acts as a bridge — all sensor data (audio PCM, IMU/head position, button presses, touch gestures, camera photos, battery state) flows from glasses → phone.

### Hop 2: Phone → Cloud (WebSocket)

The phone opens a persistent WebSocket connection to the cloud:

```
wss://{backend_host}/glasses-ws
```

**Authentication:** JWT token sent via `Authorization: Bearer {token}` header or `?token=` query parameter during the WebSocket upgrade handshake.

**What flows over this connection:**
- **Phone → Cloud:** Audio (binary PCM), transcription results, button presses, head position, touch events, VAD signals, battery updates, location updates, glasses connection state, photo responses, RTMP stream status, app start/stop requests
- **Cloud → Phone:** Connection ACK, display events (text/bitmaps for the AR display), app state changes, microphone state, settings updates, photo/audio/LED requests, RTMP stream control, dashboard updates

### Hop 3: Cloud → SDK (Webhook + WebSocket)

This is a **two-phase handshake**:

1. **Webhook (HTTP POST):** Cloud calls the developer's app server at `{publicUrl}/webhook` with session info
2. **WebSocket (bidirectional):** The SDK connects back to the cloud at `wss://{cloud_host}/app-ws`

The webhook payload tells the SDK *where* to connect:

```json
{
  "type": "session_request",
  "sessionId": "user@email.com-com.developer.myapp",
  "userId": "user@email.com",
  "timestamp": "2025-01-01T00:00:00.000Z",
  "mentraOSWebsocketUrl": "wss://api.mentra.glass/app-ws"
}
```

**Why two phases?** The cloud initiates the connection (push model — it tells the app "a user wants to use you"), but the app connects back (pull model — it establishes its own WebSocket for bidirectional communication). This means apps can be hosted anywhere with a public URL.

### Hop 4: SDK → Developer Code (Callbacks)

The SDK translates WebSocket messages into a clean developer API:

```typescript
class MyApp extends AppServer {
  protected async onSession(session: AppSession, sessionId: string, userId: string) {
    // A user started your app — set up your handlers
    session.onTranscription((data) => {
      session.layouts.showTextWall(data.text);
    });
  }
}
```

---

## Cloud Internals

### Entry Points

The cloud is a **Bun** server exposing both HTTP routes and WebSocket endpoints.

| Path | Protocol | Purpose | Handler |
|------|----------|---------|---------|
| `/glasses-ws` | WebSocket | Phone/glasses connections | `bun-websocket.ts` → `GlassesWebSocketService` |
| `/app-ws` | WebSocket | SDK/mini app connections | `bun-websocket.ts` → `AppWebSocketService` |
| `/api/*` | HTTP | REST APIs (auth, apps, settings, photos) | Hono routes |

Both WebSocket paths are handled in the Bun server's `fetch` handler:

```typescript
// cloud/packages/cloud/src/index.ts
if (url.pathname === "/glasses-ws" || url.pathname === "/app-ws") {
  const upgradeResult = handleUpgrade(req, server);
  // ...
}
```

The `handleUpgrade` function in `bun-websocket.ts` routes to the appropriate handler based on path, performing JWT validation during the upgrade.

### UserSession — The Hub

**`UserSession`** (`services/session/UserSession.ts`) is the central state object — one per connected user. It holds:

```
UserSession
├── userId, websocket, startTime
├── installedApps (Map<packageName, App>)
│
├── Managers (orchestrate specific concerns):
│   ├── appManager          — App lifecycle (start/stop/connect/resurrect)
│   ├── displayManager      — AR display rendering pipeline
│   ├── dashboardManager    — Dashboard mode content
│   ├── microphoneManager   — Mic on/off state coordination
│   ├── audioManager        — Audio data routing to apps
│   ├── transcriptionManager — Speech-to-text stream management
│   ├── translationManager  — Translation stream management
│   ├── subscriptionManager — Which apps get which data
│   ├── locationManager     — GPS/location services
│   ├── calendarManager     — Calendar event access
│   ├── userSettingsManager — User preferences
│   ├── deviceManager       — Device state (capabilities, WiFi, battery)
│   ├── photoManager        — Photo request/response routing
│   ├── liveKitManager      — LiveKit WebRTC transport
│   ├── speakerManager      — Audio output management
│   ├── udpAudioManager     — UDP audio transport
│   └── appAudioStreamManager — App-initiated audio streams
│
├── Extensions:
│   ├── unmanagedStreamingExtension — Raw RTMP streaming
│   └── managedStreamingExtension   — Managed streaming (with CDN)
│
├── streamRegistry          — Stream state tracking
└── bufferedAudio, recentAudioBuffer — Audio buffers
```

Sessions are stored in a static in-memory `Map<userId, UserSession>`. When a user reconnects, the existing session is reused (`createOrReconnect()`).

### Manager Architecture

Managers follow a consistent pattern:
- Owned by `UserSession`
- Receive the `UserSession` reference in constructor
- Use child loggers (`userSession.logger.child({ service: "ManagerName" })`)
- Handle their domain's messages
- Coordinate with other managers through `UserSession`

**AppManager** is the most complex — it manages the lifecycle of all mini apps for a user:

```
AppManager
├── apps: Map<packageName, AppSession>     — Per-app state (cloud-side)
├── pendingConnections: Map<packageName, PendingConnection>
│
├── startApp(packageName)    — Validates, sends webhook, waits for connection
├── stopApp(packageName)     — Disconnects, cleans up
├── handleAppInit(ws, msg)   — Processes SDK connection, sends ACK
├── resurrectDormantApps()   — Restarts apps after user reconnects
└── broadcastAppState()      — Sends updated app list to phone
```

**Cloud-side `AppSession`** (`services/session/AppSession.ts`) — not to be confused with the SDK's `AppSession` — tracks per-app state within a user session:

```
AppSession (cloud-side)
├── packageName, webSocket, state
├── Connection states: CONNECTING → RUNNING → GRACE_PERIOD → DORMANT → STOPPED
├── subscriptions: Set<ExtendedStreamType>
├── heartbeat (10s ping/pong)
├── grace period (5s after disconnect before cleanup)
└── ownership release tracking
```

### Message Routing

Messages are routed through dedicated handler modules (extracted for testability):

**`handlers/glasses-message-handler.ts`** — Routes glasses→cloud messages:
```
GlassesMessage
├── START_APP / STOP_APP      → appManager.startApp() / stopApp()
├── GLASSES_CONNECTION_STATE  → deviceManager + relayMessageToApps()
├── VAD                       → audioManager + transcriptionManager
├── LOCAL_TRANSCRIPTION       → transcriptionManager
├── HEAD_POSITION             → dashboardManager + relayMessageToApps()
├── TOUCH_EVENT               → gesture-specific subscription routing
├── LOCATION_UPDATE           → locationManager
├── CALENDAR_EVENT            → calendarManager
├── RTMP_STREAM_STATUS        → managedStreamingExtension or unmanagedStreamingExtension
├── AUDIO_PLAY_RESPONSE       → relayAudioPlayResponseToApp()
├── RGB_LED_CONTROL_RESPONSE  → relayMessageToApps()
└── default                   → relayMessageToApps() (subscription-based)
```

**`handlers/app-message-handler.ts`** — Routes SDK→cloud messages:
```
AppMessage
├── SUBSCRIPTION_UPDATE       → subscriptionManager
├── DISPLAY_REQUEST           → displayManager
├── DASHBOARD_*               → dashboardManager
├── PHOTO_REQUEST             → photoManager → glasses
├── AUDIO_PLAY_REQUEST        → glasses (with requestId tracking)
├── AUDIO_STREAM_START/END    → appAudioStreamManager
├── RGB_LED_CONTROL           → glasses
├── RTMP_STREAM_REQUEST/STOP  → unmanagedStreamingExtension
├── MANAGED_STREAM_*          → managedStreamingExtension
├── LOCATION_POLL_REQUEST     → locationManager
├── REQUEST_WIFI_SETUP        → glasses
└── OWNERSHIP_RELEASE         → appManager.markOwnershipReleased()
```

**`relayMessageToApps()`** is the core fan-out function:
```typescript
// For each message from glasses:
const subscribedApps = subscriptionManager.getSubscribedApps(data.type);
for (const packageName of subscribedApps) {
  const ws = appWebsockets.get(packageName);
  ws.send(JSON.stringify({
    type: "data_stream",
    streamType: data.type,
    data: data,
    // ...
  }));
}
```

---

## SDK Internals

The SDK (`cloud/packages/sdk`) is published as `@mentra/sdk` on npm. Developers install it and subclass `AppServer`.

### AppServer (Hono-based)

`AppServer` extends Hono directly — it *is* the web server:

```
AppServer extends Hono
├── config: { packageName, apiKey, port, publicDir, cookieSecret }
├── activeSessions: Map<sessionId, AppSession>
├── activeSessionsByUserId: Map<userId, AppSession>
├── pendingPhotoRequests: Map<requestId, PendingPhotoRequest>
│
├── Endpoints (auto-configured):
│   ├── POST /webhook         — Receives session_request and stop_request from cloud
│   ├── POST /tool            — Receives AI tool calls from cloud
│   ├── GET  /health          — Health check
│   ├── POST /settings        — Settings update from cloud
│   ├── POST /photo-upload    — Photo data upload from cloud
│   ├── GET  /mentra-auth     — OAuth redirect for webview auth
│   └── /*   (publicDir)      — Static file serving
│
├── Developer overrides:
│   ├── onSession(session, sessionId, userId)  — Called when user starts app
│   ├── onStop(sessionId, userId, reason)      — Called when user stops app
│   └── onToolCall(toolCall)                   — Called for AI tool invocations
│
└── Lifecycle:
    ├── start()  — Starts HTTP server on configured port
    └── stop()   — Graceful shutdown with cleanup
```

### AppSession

`AppSession` (SDK-side) manages a single user's connection to the cloud:

```
AppSession
├── ws: WebSocket              — Connection to cloud's /app-ws
├── sessionId, userId
├── config: { packageName, apiKey, mentraOSWebsocketUrl }
│
├── Modules (developer-facing API):
│   ├── events: EventManager       — Subscribe to data streams
│   ├── layouts: LayoutManager     — Display content on glasses
│   ├── dashboard: DashboardAPI    — Dashboard mode content
│   ├── camera: CameraModule       — Photos & video streaming
│   ├── audio: AudioManager        — Audio playback & streaming
│   ├── led: LedModule             — RGB LED control
│   ├── location: LocationManager  — GPS location
│   ├── settings: SettingsManager  — App settings (user-configurable)
│   ├── device: { state: DeviceState } — Reactive device observables
│   └── simpleStorage: SimpleStorage   — Key-value storage
│
├── Connection lifecycle:
│   ├── connect(sessionId)     — Opens WS, sends CONNECTION_INIT
│   ├── disconnect()           — Closes WS
│   ├── releaseOwnership()     — Tells cloud not to resurrect
│   └── auto-reconnect (3 attempts, exponential backoff)
│
└── Message handling:
    ├── handleMessage(msg)       — Routes CloudToApp messages to modules
    ├── handleBinaryMessage(buf) — Routes audio chunks
    ├── sendMessage(msg)         — Sends AppToCloud messages
    ├── sendBinary(buf)          — Sends binary data
    └── updateSubscriptions()    — Derives subscriptions from handlers
```

### Module System

Each module provides a focused API:

**EventManager** — Pub/sub for data streams:
```typescript
session.events.onTranscription(handler)              // English transcription
session.events.onTranscriptionForLanguage("es", handler)  // Spanish
session.events.onTranslationForLanguage("es", "en", handler)
session.events.onHeadPosition(handler)
session.events.onButtonPress(handler)
session.events.onTouchEvent(handler, "triple_tap")
session.events.onPhoneNotifications(handler)
session.events.onConnected(handler)
session.events.onDisconnected(handler)
session.events.onError(handler)
// ... etc
```

**LayoutManager** — AR display:
```typescript
session.layouts.showTextWall("Hello World")
session.layouts.showDoubleTextWall("Top", "Bottom")
session.layouts.showReferenceCard("Title", "Body text")
session.layouts.showDashboardCard("Label", "Value")
session.layouts.showBitmapView(base64Data)
session.layouts.showBitmapAnimation(frames[], intervalMs, repeat)
session.layouts.clearView()
```

**CameraModule** — Photos and streaming:
```typescript
const photo = await session.camera.takePhoto()
session.camera.startStream(rtmpUrl)
session.camera.stopStream()
```

**DeviceState** — Reactive observables:
```typescript
session.device.state.wifiConnected.onChange((connected) => { ... })
session.device.state.batteryLevel.onChange((level) => { ... })
session.device.state.modelName.value  // synchronous read
```

**AudioManager** — Audio playback:
```typescript
session.audio.play("https://example.com/audio.mp3", { volume: 0.8 })
session.audio.stop()
const stream = session.audio.createOutputStream()
```

---

## Key Flows

### App Startup Flow

```
Phone                        Cloud                         SDK (Developer App)
  │                            │                              │
  │ START_APP(packageName) ──► │                              │
  │                            │ 1. Look up app in DB         │
  │                            │ 2. Check hardware compat     │
  │                            │ 3. Stop other foreground app │
  │                            │                              │
  │ ◄── DISPLAY_EVENT (boot) ──│                              │
  │                            │                              │
  │                            │ 4. POST /webhook ──────────► │
  │                            │    { type: session_request,  │
  │                            │      sessionId, userId,      │
  │                            │      mentraOSWebsocketUrl }  │
  │                            │                              │
  │                            │    ◄── 200 OK ────────────── │
  │                            │                              │
  │                            │ ◄── WebSocket /app-ws ────── │
  │                            │                              │
  │                            │ ◄── tpa_connection_init ──── │
  │                            │    { packageName, apiKey,    │
  │                            │      sessionId }             │
  │                            │                              │
  │                            │ 5. Validate API key          │
  │                            │ 6. Load user settings        │
  │                            │ 7. Get device capabilities   │
  │                            │                              │
  │                            │ ── tpa_connection_ack ─────► │
  │                            │    { settings, capabilities, │
  │                            │      mentraosSettings }      │
  │                            │                              │
  │                            │                              │ 8. onSession() fires
  │                            │                              │ 9. Developer registers handlers
  │                            │                              │
  │                            │ ◄── subscription_update ──── │
  │                            │    { subscriptions: [...] }  │
  │                            │                              │
  │ ◄── APP_STATE_CHANGE ──── │                              │
  │   (app now running)        │                              │
```

### Data Flow: Glasses → App (Downstream)

```
Glasses ──BLE──► Phone ──WS──► Cloud ──WS──► SDK ──callback──► Developer Code

Example: Transcription

1. Glasses mic captures audio
2. Phone relays PCM audio (binary) over /glasses-ws
3. Cloud's AudioManager processes audio
4. Cloud's TranscriptionManager sends to speech-to-text service (Soniox)
5. Transcription result comes back
6. Cloud wraps it in DATA_STREAM message:
   {
     type: "data_stream",
     streamType: "transcription",
     data: { text: "Hello world", isFinal: true, ... }
   }
7. SubscriptionManager checks which apps subscribe to "transcription"
8. Cloud sends DATA_STREAM to each subscribed app's WebSocket
9. SDK's AppSession.handleMessage() receives it
10. SDK's EventManager emits to developer's handler
11. Developer's callback fires with { text: "Hello world", ... }
```

### Data Flow: App → Glasses (Upstream)

```
Developer Code ──method call──► SDK ──WS──► Cloud ──WS──► Phone ──BLE──► Glasses

Example: Display text

1. Developer calls: session.layouts.showTextWall("Hello")
2. LayoutManager creates DISPLAY_REQUEST message:
   {
     type: "display_event",
     packageName: "com.dev.myapp",
     layout: { layoutType: "text_wall", text: "Hello" },
     view: "main"
   }
3. SDK sends over WebSocket to cloud
4. Cloud's AppMessageHandler routes to DisplayManager
5. DisplayManager processes layout (priority, ownership, rendering)
6. Cloud sends DISPLAY_EVENT to phone via /glasses-ws
7. Phone relays to glasses via BLE
8. Glasses render text on AR display
```

### Subscription System

The subscription model ensures efficient data routing — apps only receive data they asked for.

```
Developer registers handler          SDK derives subscriptions         Cloud filters
─────────────────────────            ─────────────────────────         ──────────────
session.onTranscription(fn)    →     ["transcription:en-US"]     →    Only send transcription
session.onButtonPress(fn)      →     ["button_press"]            →    data to this app if
session.onHeadPosition(fn)     →     ["head_position"]           →    it has a matching
                                                                      subscription
```

**Key design decision (Bug 007 fix):** Subscriptions are **derived from registered handlers** — the EventManager is the single source of truth. Previously, subscriptions were tracked in a separate `Set` that could drift out of sync with handlers, causing apps to stop receiving data.

```typescript
// SDK: updateSubscriptions() — called on connect and handler changes
private updateSubscriptions(): void {
  const derivedSubscriptions = this.events.getRegisteredStreams(); // Single source of truth
  const message: AppSubscriptionUpdate = {
    type: "subscription_update",
    subscriptions: derivedSubscriptions,
    // ...
  };
  this.send(message);
}
```

**Cloud-side SubscriptionManager** stores per-app subscriptions in `AppSession._subscriptions` and provides query methods:
- `getSubscribedApps(streamType)` — Which apps want this data?
- `getAppSubscriptions(packageName)` — What does this app want?
- No cached aggregates — computed on demand (1-5 apps per session, iteration is cheap)

### App Lifecycle States

Cloud-side `AppSession` (not the SDK's AppSession) has a state machine:

```
                 webhook sent
    STOPPED ──────────────────► CONNECTING
       ▲                            │
       │                            │ WS connected + init
       │                            ▼
       │           stop         RUNNING
       │◄───────────────────────────│
       │                            │
       │                            │ WS disconnected
       │                            ▼
       │                      GRACE_PERIOD (5s)
       │                            │
       │              ┌─────────────┤
       │              │             │ grace expired
       │              │             ▼
       │        user returns    DORMANT
       │              │             │
       │              │             │ user reconnects
       │              ▼             ▼
       │          RUNNING ◄── RESURRECTING
       │                            │
       │                            │ resurrection failed
       └────────────────────────────┘
```

- **CONNECTING:** Webhook sent, waiting for SDK to connect back
- **RUNNING:** Active WebSocket, app is live
- **GRACE_PERIOD:** SDK disconnected (crash/restart), 5s window for reconnection
- **DORMANT:** Grace period expired but user still connected — will resurrect when possible
- **RESURRECTING:** System is re-sending webhook to restart the app
- **STOPPED:** Fully stopped, no resources held

### Photo Request/Response Flow

Photos have a unique flow because the response comes via HTTP, not WebSocket:

```
SDK                     Cloud                    Phone                   Glasses
 │                        │                        │                       │
 │ PHOTO_REQUEST ───────► │                        │                       │
 │                        │ photo_request ────────► │                       │
 │                        │                        │ BLE photo cmd ──────► │
 │                        │                        │                       │ snap!
 │                        │                        │ ◄── photo data ────── │
 │                        │ ◄── POST /api/client/  │                       │
 │                        │     photo/response      │                       │
 │                        │                        │                       │
 │                        │ POST /photo-upload ──► │                       │
 │ ◄── resolve(photoData) │   (to SDK server)      │                       │
```

Photo requests are stored in `AppServer.pendingPhotoRequests` (not on the session) because:
1. Photo uploads arrive via HTTP POST, not WebSocket
2. Allows O(1) lookup by requestId
3. Survives session reconnections

### Audio Pipeline

```
Glasses Mic ──BLE──► Phone ──WS (binary)──► Cloud
                                              │
                                    ┌─────────┴──────────┐
                                    │                    │
                              AudioManager          UdpAudioManager
                                    │                    │
                          ┌─────────┴─────────┐         │
                          │                   │          │
                   TranscriptionMgr    Apps (PCM)       UDP transport
                          │             subscribers
                          │
                   Soniox/Deepgram
                   (speech-to-text)
                          │
                    TranslationMgr
                    (if subscribed)
                          │
                    Apps (transcription/
                     translation data)
```

Audio arrives as binary WebSocket frames (PCM). The cloud routes it to:
1. **TranscriptionManager** — sends to speech-to-text services
2. **Subscribed apps** — apps that requested `audio_chunk` stream get raw PCM
3. **TranslationManager** — if any app subscribed to translation streams

---

## WebSocket Protocols

### Glasses ↔ Cloud Messages

**Glasses → Cloud (GlassesToCloudMessageType):**

| Message Type | Description |
|---|---|
| `connection_init` | Initial handshake with auth token |
| `start_app` / `stop_app` | User starts/stops a mini app |
| `button_press` | Hardware button events |
| `head_position` | IMU head tracking (up/down/level) |
| `touch_event` | Touch gestures (tap, double_tap, triple_tap, swipes) |
| `glasses_battery_update` | Glasses battery level |
| `phone_battery_update` | Phone battery level |
| `glasses_connection_state` | BLE connection + WiFi status |
| `location_update` | GPS coordinates |
| `VAD` | Voice Activity Detection (speaking/silence) |
| `photo_response` | Photo data from glasses camera |
| `rtmp_stream_status` | RTMP streaming state updates |
| `audio_play_response` | Audio playback completion |
| `rgb_led_control_response` | LED control acknowledgment |
| `local_transcription` | On-device transcription results |
| `keep_alive_ack` | Heartbeat response |

**Cloud → Glasses (CloudToGlassesMessageType):**

| Message Type | Description |
|---|---|
| `connection_ack` | Handshake accepted |
| `connection_error` / `auth_error` | Handshake rejected |
| `display_event` | Render content on AR display |
| `app_state_change` | App started/stopped notification |
| `microphone_state_change` | Mic on/off |
| `settings_update` | Settings changed |
| `photo_request` | Take a photo |
| `audio_play_request` / `audio_stop_request` | Play/stop audio |
| `rgb_led_control` | Control RGB LEDs |
| `start_rtmp_stream` / `stop_rtmp_stream` | RTMP streaming control |
| `show_wifi_setup` | Prompt WiFi configuration |
| `dashboard_mode_change` | Switch dashboard view mode |
| `set_location_tier` | Change location accuracy |

### App ↔ Cloud Messages

**App → Cloud (AppToCloudMessageType):**

| Message Type | Description |
|---|---|
| `tpa_connection_init` | SDK handshake with packageName + apiKey |
| `subscription_update` | Update data stream subscriptions |
| `display_event` | Display content on glasses |
| `photo_request` | Request a photo |
| `audio_play_request` / `audio_stop_request` | Play/stop audio |
| `audio_stream_start` / `audio_stream_end` | Audio output streaming |
| `rgb_led_control` | Control RGB LEDs |
| `rtmp_stream_request` / `rtmp_stream_stop` | Start/stop RTMP streaming |
| `managed_stream_request` / `managed_stream_stop` | Managed streaming |
| `stream_status_check` | Check current stream status |
| `dashboard_content_update` | Update dashboard content |
| `dashboard_mode_change` | Change dashboard mode |
| `location_poll_request` | Request location update |
| `request_wifi_setup` | Show WiFi setup on phone |
| `ownership_release` | Tell cloud not to resurrect this session |

**Cloud → App (CloudToAppMessageType):**

| Message Type | Description |
|---|---|
| `tpa_connection_ack` | Handshake accepted (includes settings + capabilities) |
| `tpa_connection_error` | Handshake rejected |
| `data_stream` | Wrapped sensor data (transcription, buttons, etc.) |
| `app_stopped` | App was stopped by user/system |
| `settings_update` | Settings changed by user |
| `capabilities_update` | Device capabilities changed |
| `device_state_update` | Device state changed (WiFi, battery, etc.) |
| `photo_response` | Photo data |
| `audio_play_response` | Audio playback result |
| `audio_stream_ready` | Audio output stream URL ready |
| `rtmp_stream_status` | RTMP stream state change |
| `managed_stream_status` | Managed stream state change |
| `permission_error` | Missing required permission |
| `dashboard_mode_changed` | Dashboard mode was changed |

---

## Stream Types Reference

These are the data streams apps can subscribe to. The SDK auto-subscribes when a developer registers a handler.

| Stream Type | Category | Description | Data Shape |
|---|---|---|---|
| `transcription` | Audio | Speech-to-text results | `{ text, isFinal, startTime, endTime }` |
| `transcription:{lang}` | Audio | Language-specific transcription (e.g., `transcription:es-ES`) | Same as above |
| `translation:{src}:{tgt}` | Audio | Translation pair (e.g., `translation:es-ES:en-US`) | `{ text, transcribeLanguage, translateLanguage }` |
| `audio_chunk` | Audio | Raw PCM audio data | `ArrayBuffer` (binary) |
| `VAD` | Audio | Voice Activity Detection | `{ status: boolean }` |
| `button_press` | Hardware | Physical button events | `{ buttonId, pressType, timestamp }` |
| `head_position` | Hardware | IMU head tracking | `{ position: "up"\|"down"\|"level" }` |
| `touch_event` | Hardware | Touch gestures | `{ gesture_name: "tap"\|"double_tap"\|... }` |
| `touch_event:{gesture}` | Hardware | Specific gesture (e.g., `touch_event:triple_tap`) | Same as above |
| `glasses_battery_update` | Hardware | Glasses battery level | `{ level, charging }` |
| `phone_battery_update` | Hardware | Phone battery level | `{ level, charging }` |
| `glasses_connection_state` | Hardware | BLE + WiFi status | `{ status, wifi, modelName }` |
| `location_update` | Hardware | GPS coordinates | `{ latitude, longitude, accuracy }` |
| `location_stream` | Hardware | Continuous location (with rate) | Same, configurable rate |
| `phone_notification` | Phone | Incoming notifications | `{ app, title, body }` |
| `phone_notification_dismissed` | Phone | Dismissed notifications | `{ notificationId }` |
| `calendar_event` | Phone | Calendar events | `{ title, startDate, endDate, location }` |
| `photo_taken` | Media | Photo captured (glasses-initiated) | `{ photoData }` |
| `rtmp_stream_status` | Media | RTMP stream state changes | `{ streamId, status }` |
| `managed_stream_status` | Media | Managed stream state changes | `{ streamId, status, hlsUrl, ... }` |

**Special subscription types:**
- `all` / `*` — Subscribe to everything (use sparingly)
- Language streams use a colon-delimited format: `transcription:en-US`, `translation:es-ES:en-US`
- Touch events support gesture-specific subscriptions: `touch_event:triple_tap`

---

## Mentra Live: Camera-Equipped Glasses

MentraOS supports two fundamentally different classes of smart glasses. Everything described in the sections above applies to both — the cloud, SDK, subscription system, and app lifecycle are the same. What differs is the **hardware path** between the glasses and the outside world, particularly for media-heavy operations like photos and video streaming.

### Two Types of Glasses

| | BLE-Only Glasses (e.g., Even G1/G2) | Mentra Live (Android-based) |
|---|---|---|
| **OS** | Proprietary firmware | Android (runs `asg_client`) |
| **Connectivity** | BLE to phone only | BLE to phone + WiFi to internet |
| **Camera** | None | Camera2 API (1440×1080 photos, 1280×720 video) |
| **Microphone** | Via phone or glasses mic | On-device mic |
| **Display** | Micro-LED / waveguide | Display with rendering |
| **Storage** | None | Local filesystem |
| **RTMP Streaming** | Not possible | Direct to RTMP server over WiFi |
| **Photo Capture** | Not possible | Capture + direct WiFi upload to app server |
| **Audio Playback** | Via phone speaker | On-device speaker/I2S |

For BLE-only glasses, the phone does all the heavy lifting — transcription, audio capture, and internet connectivity. For Mentra Live, the glasses are a fully independent Android device that happens to use BLE for lightweight command/status communication with the phone.

### The SGCManager Abstraction

The mobile app uses a **Smart Glasses Controller** abstraction (`SGCManager`) to handle both types transparently:

```
mobile/modules/core/android/.../sgcs/
├── SGCManager.kt          — Abstract base class defining all operations
├── MentraNex.kt           — BLE-only glasses (Even G1/G2) — camera ops are no-ops
└── Simulated.kt           — Simulated glasses for development
```

The abstract `SGCManager` defines the full API surface:

```
SGCManager (abstract)
├── Audio Control: setMicEnabled(), sortMicRanking()
├── Camera & Media: requestPhoto(), startRtmpStream(), stopRtmpStream(),
│                   startBufferRecording(), stopBufferRecording(), saveBufferVideo(),
│                   startVideoRecording(), stopVideoRecording()
├── Display Control: setBrightness(), clearDisplay(), sendTextWall(), displayBitmap()
├── Device Control: getBatteryStatus(), setSilentMode(), sendShutdown()
├── Network: requestWifiScan(), sendWifiCredentials(), forgetWifiNetwork()
└── Gallery: queryGalleryStatus(), sendGalleryMode()
```

For BLE-only glasses like Even G1, camera operations are no-ops:

```kotlin
// MentraNex.kt
override fun requestPhoto(...) { Bridge.log("Nex: requestPhoto operation not supported") }
override fun startRtmpStream(...) { Bridge.log("Nex: startRtmpStream operation not supported") }
override fun stopRtmpStream() { Bridge.log("Nex: stopRtmpStream operation not supported") }
```

For Mentra Live, these commands are forwarded to `asg_client` over BLE, which executes them using on-device hardware.

### BLE for Commands, WiFi for Media

This is the key architectural insight for Mentra Live:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    MENTRA LIVE DATA FLOW SPLIT                          │
│                                                                         │
│  BLE (low bandwidth, ~1 Mbps):                                         │
│    • JSON commands (take photo, start stream, stop, settings)           │
│    • Status updates (battery, WiFi state, stream status, errors)        │
│    • Button presses, head position, touch events                        │
│    • Display events (text/bitmap rendering commands)                    │
│                                                                         │
│  WiFi (high bandwidth, ~50+ Mbps):                                     │
│    • Photo uploads (JPEG, 100KB–2MB) → direct to app server            │
│    • RTMP video streams (2+ Mbps continuous) → direct to RTMP server   │
│    • Gallery browsing/downloads → local network HTTP server             │
│                                                                         │
│  The phone is a COMMAND RELAY, not a DATA BOTTLENECK.                  │
└─────────────────────────────────────────────────────────────────────────┘
```

BLE bandwidth (~1 Mbps theoretical, ~100 KB/s practical) would make photo transfers take seconds and video streaming impossible. By splitting commands (BLE) from media (WiFi), Mentra Live gets the best of both worlds: reliable phone-mediated lifecycle management with high-bandwidth direct media delivery.

### Photo Flow (Mentra Live)

Photos follow a **three-party direct upload** pattern. The glasses upload the image directly to the developer's app server over WiFi, bypassing the cloud for image data entirely:

```
SDK App Server          Cloud                 Phone              Glasses (asg_client)
     │                    │                     │                       │
     │ PHOTO_REQUEST ───► │                     │                       │
     │  (via app WS)      │                     │                       │
     │                    │ photo_request ─────► │                       │
     │                    │  (via glasses WS)    │                       │
     │                    │  includes:           │ BLE command ────────► │
     │                    │   webhookUrl         │  (JSON, ~200 bytes)  │
     │                    │   requestId          │                       │
     │                    │   size, compress     │                       │ CameraNeo:
     │                    │   authToken          │                       │  1. Open camera
     │                    │   silent             │                       │  2. AE convergence
     │                    │                     │                       │  3. Capture JPEG
     │                    │                     │                       │  4. Compress (opt.)
     │                    │                     │                       │
     │ ◄──── HTTP POST multipart (WiFi direct) ────────────────────────│
     │  /photo-upload                                                   │
     │  • photo file (JPEG)                                             │
     │  • requestId                                                     │
     │  • type: "photo_upload"                                          │
     │                                                                  │
     │  200 OK ──────────────────────────────────────────────────────►  │
     │                    │                     │                       │
     │                    │ ◄── POST /api/client/photo/response ─────── │
     │                    │      (status report via phone REST,         │
     │                    │       not WS — more reliable for errors)    │
     │                    │                     │                       │
```

**Step by step:**

1. Developer calls `session.camera.takePhoto()` in the SDK
2. SDK sends `PHOTO_REQUEST` to cloud via app WebSocket
3. Cloud's `PhotoManager` builds the command:
   - Sets `webhookUrl` to `{app.publicUrl}/photo-upload` (or a custom URL from the developer)
   - Includes `authToken`, `size` (small/medium/large), `compress` (none/medium/heavy)
   - Determines `silent` mode (no shutter sound/LED) for AI apps like Mira
4. Cloud sends `photo_request` to phone via glasses WebSocket
5. Phone receives it in `SocketComms.handle_photo_request()`, calls `CoreModule.photoRequest()`
6. Phone forwards the command to glasses over BLE (just the JSON parameters — ~200 bytes)
7. On the glasses, `PhotoCommandHandler.handleTakePhoto()` dispatches to `MediaCaptureService`
8. `MediaCaptureService.takePhotoAndUpload()`:
   - Checks RTMP streaming not active (camera mutex)
   - Checks battery level and storage space
   - Calls `CameraNeo.enqueuePhotoRequest()` for thread-safe capture
   - CameraNeo: opens Camera2, waits for auto-exposure convergence, captures JPEG
9. Photo captured → optional compression (medium: 75% size + 80% quality, heavy: 50% + 60%)
10. **Glasses upload directly to the SDK app server** via OkHttp HTTP POST (multipart form) over WiFi
11. SDK's `AppServer` receives the upload at `/photo-upload`, resolves the developer's `takePhoto()` promise
12. Status/error reporting flows back via REST: glasses → `POST /api/client/photo/response` → cloud → app WebSocket

**Why direct upload?** A 1MB JPEG over BLE at ~100 KB/s = 10 seconds. Over WiFi = ~100ms. The 100× speedup makes interactive photo features practical.

**Fallback path:** If WiFi upload fails, the system can fall back to BLE transfer (`takePhotoForBleTransfer`), though this is much slower. The `takePhotoAutoTransfer` method attempts WiFi first and falls back to BLE automatically.

### RTMP Streaming Flow (Mentra Live)

For video streaming, the glasses stream **directly to the RTMP endpoint** over WiFi — neither the phone nor the cloud touches the video data:

```
SDK App Server          Cloud                Phone              Glasses (asg_client)
     │                    │                    │                       │
     │ RTMP_STREAM_REQ ─► │                    │                       │
     │  { rtmpUrl,        │                    │                       │
     │    videoConfig,     │ start_rtmp_stream► │                       │
     │    audioConfig }    │                    │ BLE command ────────► │
     │                    │                    │                       │
     │                    │                    │                       │ Validate:
     │                    │                    │                       │  • WiFi connected?
     │                    │                    │                       │  • Battery > min?
     │                    │                    │                       │  • Camera available?
     │                    │                    │                       │
     │                    │                    │                       │ RtmpStreamingService:
     │                    │                    │                       │  StreamPackLite
     │                    │                    │                       │  Camera2 + Mic
     │                    │                    │                       │
     │                    │                    │        ┌──────────────│
     │                    │                    │        │  RTMP stream │
     │                    │                    │        │  over WiFi   │
     │                    │                    │        ▼              │
     │                    │                    │   RTMP Server         │
     │                    │                    │   (Twitch/YouTube/    │
     │                    │                    │    Restream/custom)   │
     │                    │                    │                       │
     │  ◄──── status updates (started/stopped/error/reconnecting) ────│
     │        via: glasses→BLE→phone→cloud WS→app WS→SDK event       │
     │                    │                    │                       │
     │                    │ keep_alive ───────►│──BLE──►│              │
     │                    │ ◄── keep_alive_ack─│◄─BLE──│              │
     │                    │  (periodic, prevents timeout)              │
```

**Step by step:**

1. Developer calls `session.camera.startStream(rtmpUrl)` (or `startManagedStream()`)
2. SDK sends `RTMP_STREAM_REQUEST` to cloud with RTMP URL and optional video/audio config
3. Cloud's `AppMessageHandler` routes to streaming extension, validates camera permission
4. Cloud sends `start_rtmp_stream` to phone → phone forwards via BLE to glasses
5. `RtmpCommandHandler` on glasses:
   - Validates WiFi connectivity (`stateManager.isConnectedToWifi()`)
   - Checks battery level (rejects if too low)
   - Stops any existing stream
   - Parses video/audio config from SDK message
6. `RtmpStreamingService.startStreaming()` initializes StreamPackLite:
   - Default: 1280×720 @ 30fps, 2 Mbps video, 64 kbps audio
   - Configurable per-stream from SDK
7. **Glasses stream directly to the RTMP server over WiFi** — continuous video+audio
8. Status updates flow back through the normal path: glasses → BLE → phone → cloud WS → app WS → SDK event handler
9. **Keep-alive mechanism:** Cloud sends periodic `keep_rtmp_stream_alive` with `streamId` and `ackId`. Glasses respond with `keep_alive_ack`. If acks stop arriving, the stream is considered dead and cleaned up.

**Reconnection:** `RtmpStreamingService` has built-in reconnection with exponential backoff. If the RTMP connection drops (WiFi glitch, server hiccup), it retries automatically and reports status updates throughout.

### Managed Streaming (Cloud-Mediated)

In addition to raw RTMP (where the developer provides their own RTMP URL), there's a **managed streaming** option where the cloud provisions and manages the stream infrastructure:

```
SDK App                  Cloud                           Glasses
  │                        │                               │
  │ MANAGED_STREAM_REQ ──► │                               │
  │                        │ 1. Provision stream endpoint  │
  │                        │ 2. Generate viewer URLs       │
  │                        │    (HLS, DASH, WebRTC)        │
  │                        │ 3. Set up CDN distribution    │
  │                        │                               │
  │                        │ start_rtmp_stream ──────────► │
  │                        │  (cloud-provided RTMP URL)    │
  │                        │                               │ stream ──► CDN
  │                        │                               │
  │ ◄── MANAGED_STREAM_STATUS ──────────────────────────── │
  │  { streamId, status,                                   │
  │    hlsUrl, dashUrl, webrtcUrl,                         │
  │    previewUrl, thumbnailUrl,                           │
  │    activeViewers }                                     │
```

With managed streaming, developers get:
- **HLS/DASH/WebRTC viewer URLs** — no need to set up their own streaming infrastructure
- **Preview thumbnails** — periodic snapshot URLs
- **Viewer counts** — real-time audience metrics
- **Stream status checks** — `STREAM_STATUS_CHECK` message returns full state

The developer can query stream status at any time:

```typescript
// SDK provides stream status via events
session.camera.onManagedStreamStatus((status) => {
  console.log(`Stream: ${status.hlsUrl}`);
  console.log(`Viewers: ${status.activeViewers}`);
});
```

### CameraNeo: The Camera Service

`CameraNeo` is the glasses-side camera service — a foreground Android `LifecycleService` that owns the camera lifecycle:

```
CameraNeo (Foreground Service)
├── Photo Capture
│   ├── Camera2 API with auto-exposure convergence
│   ├── Target: 1440×1080 JPEG @ quality 90
│   ├── AE precapture trigger + 0.5s convergence wait
│   ├── Thread-safe request queue (enqueuePhotoRequest)
│   └── Privacy LED + shutter sound (unless silent mode)
│
├── Video Recording (single file)
│   ├── MediaRecorder with Camera2 session
│   ├── Target: 1280×720
│   ├── Configurable duration limits
│   └── Progress callbacks every second
│
├── Circular Buffer Recording
│   ├── Continuous recording to rotating 5s segments
│   ├── "Save last N seconds" capability
│   ├── CircularVideoBufferInternal manages segment rotation
│   └── Surface swapping for seamless segment switches
│
├── Resource Management
│   ├── WakeLock for screen/CPU during capture
│   ├── Semaphore-guarded camera open/close
│   ├── Dedicated HandlerThread for Camera2 events
│   └── Automatic cleanup in onDestroy
│
└── Mutual Exclusion
    └── Photos and video/streaming cannot overlap
        (RTMP streaming blocks photo capture and vice versa)
```

All camera operations are fire-and-forget static helpers:
```java
CameraNeo.enqueuePhotoRequest(context, filePath, size, enableLed, isFromSdk, callback);
CameraNeo.startVideoRecording(context, videoId, filePath, callback);
CameraNeo.startBufferRecording(context, callback);
CameraNeo.saveBufferVideo(context, seconds, requestId);
```

### Camera Web Server (AsgCameraServer)

Mentra Live also runs a local HTTP server on the glasses (port 8089) for gallery access:

```
AsgCameraServer (NanoHTTPD-based, port 8089)
├── GET  /status              — Server status, uptime, photo count
├── GET  /photos              — List all photos with metadata
├── GET  /photos/latest       — Get latest photo
├── GET  /photos/{id}         — Download specific photo
├── GET  /photos/{id}/thumb   — Get thumbnail
├── POST /take-picture        — Trigger photo capture
├── GET  /sync                — List files for sync
└── File management via FileManager (secure, sandboxed)
```

This allows the phone app to browse and download photos from the glasses over the local WiFi network — useful for gallery features in the MentraOS mobile app.

### asg_client Directory Map

```
asg_client/app/src/main/java/com/mentra/asg_client/
├── camera/
│   ├── CameraNeo.java              — Camera2 foreground service (photo/video/buffer)
│   ├── CameraConstants.java        — Camera configuration constants
│   └── CameraSettings.java         — User camera preferences
│
├── io/
│   ├── media/
│   │   ├── core/
│   │   │   └── MediaCaptureService.java  — Photo/video capture orchestrator
│   │   ├── managers/
│   │   │   ├── MediaUploadQueueManager.java — Persistent upload queue
│   │   │   └── PhotoQueueManager.java       — Photo-specific queue
│   │   ├── upload/
│   │   │   ├── MediaUploadService.java      — Background upload service
│   │   │   └── PhotoUploadService.java      — Photo upload service
│   │   └── utils/
│   │       └── MediaUtils.java              — File/storage utilities
│   │
│   ├── streaming/
│   │   ├── services/
│   │   │   └── RtmpStreamingService.java    — RTMP streaming via StreamPackLite
│   │   ├── config/
│   │   │   └── RtmpStreamConfig.java        — Video/audio config parsing
│   │   ├── events/
│   │   │   ├── StreamingCommand.java        — Start/stop/switch commands
│   │   │   └── StreamingEvent.java          — Status events (EventBus)
│   │   ├── utils/
│   │   │   ├── StreamingUtils.java          — URL validation, formatting
│   │   │   └── StreamingNotificationManager.java
│   │   └── interfaces/
│   │       └── IStreamingService.java       — Core streaming interface
│   │
│   ├── server/
│   │   └── services/
│   │       └── AsgCameraServer.java         — Local HTTP gallery server
│   │
│   └── storage/
│       └── StorageManager.java              — Storage space management
│
├── service/
│   └── core/
│       └── handlers/
│           ├── PhotoCommandHandler.java     — Routes take_photo commands
│           └── RtmpCommandHandler.java      — Routes start/stop/keepalive RTMP commands
│
└── hardware/
    └── K900RgbLedController.java            — Privacy LED control
```

---

## Authentication

### Phone → Cloud (glasses-ws)

The phone authenticates with a **JWT core token** during WebSocket upgrade:

```
GET /glasses-ws HTTP/1.1
Authorization: Bearer {coreToken}
Upgrade: websocket
```

The token is verified against `AUGMENTOS_AUTH_JWT_SECRET`. The decoded payload contains the `userId` which is used to create/look up the `UserSession`.

### SDK → Cloud (app-ws)

The SDK authenticates with a **JWT app token** during WebSocket upgrade:

```
GET /app-ws HTTP/1.1
Authorization: Bearer {appJwt}
X-User-Id: {userId}
X-Session-Id: {sessionId}
Upgrade: websocket
```

The app JWT is signed by the SDK using the app's API key and contains `{ packageName, apiKey }`. The cloud verifies it and maps the connection to the correct `UserSession` via the userId.

Older SDK versions authenticate inline by sending `tpa_connection_init` as the first WebSocket message (without JWT headers). Both paths are supported.

### Cloud → SDK (webhook)

The webhook POST to `{publicUrl}/webhook` carries the session info in the JSON body. The SDK's `AppServer` uses its configured `apiKey` to authenticate subsequent operations. The webhook itself is trusted because only the cloud knows the app's `publicUrl`.

### Webview Authentication

For apps with web UIs (webviews), the SDK provides:
1. `createMentraAuthRoutes()` — Sets up OAuth-like redirect flow
2. Temporary token exchange via `POST /api/auth/exchange-user-token`
3. Session cookies signed with `cookieSecret`
4. User token verification using the MentraOS Cloud public key (RSA)

---

## Directory Map

### Cloud Backend (`cloud/packages/cloud/`)

```
src/
├── index.ts                          — Bun server entry point (fetch + WebSocket)
├── hono-app.ts                       — Hono HTTP app setup
│
├── services/
│   ├── websocket/
│   │   ├── bun-websocket.ts          — Bun-native WS upgrade + handlers
│   │   ├── websocket-glasses.service.ts — Glasses WS lifecycle (legacy ws-based)
│   │   ├── websocket-app.service.ts  — App WS lifecycle (legacy ws-based)
│   │   └── types.ts                  — IWebSocket interface
│   │
│   ├── session/
│   │   ├── UserSession.ts            — Central per-user state hub
│   │   ├── AppManager.ts             — Mini app lifecycle orchestration
│   │   ├── AppSession.ts             — Per-app state (cloud-side)
│   │   ├── SubscriptionManager.ts    — Pub/sub routing
│   │   ├── AudioManager.ts           — Audio data routing
│   │   ├── DeviceManager.ts          — Device state tracking
│   │   ├── LocationManager.ts        — GPS/location
│   │   ├── CalendarManager.ts        — Calendar events
│   │   ├── MicrophoneManager.ts      — Mic state coordination
│   │   ├── PhotoManager.ts           — Photo request/response
│   │   ├── UserSettingsManager.ts    — User preferences
│   │   ├── AppAudioStreamManager.ts  — App audio output streams
│   │   ├── UdpAudioManager.ts        — UDP audio transport
│   │   ├── UnmanagedStreamingExtension.ts — Raw RTMP
│   │   ├── HardwareCompatibilityService.ts — Hardware checks
│   │   │
│   │   ├── handlers/
│   │   │   ├── glasses-message-handler.ts — Routes glasses → managers
│   │   │   └── app-message-handler.ts     — Routes app → managers/glasses
│   │   │
│   │   ├── transcription/            — Speech-to-text service integration
│   │   ├── translation/              — Translation service integration
│   │   ├── dashboard/                — Dashboard mode management
│   │   └── livekit/                  — LiveKit WebRTC transport
│   │
│   ├── layout/
│   │   └── DisplayManager6.1.ts      — AR display rendering pipeline
│   │
│   ├── permissions/                  — App permission checking
│   ├── streaming/                    — Managed streaming (CDN)
│   ├── logging/                      — Pino logger + PostHog analytics
│   ├── metrics/                      — MetricsService
│   └── storage/                      — File/blob storage
│
├── routes/                           — Hono HTTP route handlers
├── models/                           — MongoDB models (User, App, etc.)
├── middleware/                        — Auth middleware, rate limiting
├── api/                              — REST API handlers
└── config/                           — Environment config
```

### SDK (`cloud/packages/sdk/`)

```
src/
├── index.ts                          — Package entry (re-exports everything)
├── display-utils.ts                  — Display utility entry point
│
├── app/
│   ├── index.ts                      — App module barrel export
│   ├── server/
│   │   └── index.ts                  — AppServer (extends Hono)
│   ├── session/
│   │   ├── index.ts                  — AppSession (WS client)
│   │   ├── events.ts                 — EventManager (pub/sub)
│   │   ├── layouts.ts                — LayoutManager (AR display)
│   │   ├── dashboard.ts              — DashboardManager
│   │   ├── settings.ts               — SettingsManager
│   │   ├── device-state.ts           — DeviceState (reactive observables)
│   │   └── modules/
│   │       ├── camera.ts             — CameraModule (photos + streaming)
│   │       ├── audio.ts              — AudioManager (playback)
│   │       ├── audio-output-stream.ts — Audio streaming output
│   │       ├── led.ts                — LedModule (RGB LEDs)
│   │       ├── location.ts           — LocationManager
│   │       └── simple-storage.ts     — SimpleStorage (key-value)
│   ├── token/
│   │   └── utils.ts                  — JWT token create/validate
│   └── webview/
│       └── index.ts                  — Webview auth routes
│
├── types/
│   ├── message-types.ts              — All message type enums
│   ├── streams.ts                    — StreamType enum + language stream helpers
│   ├── layouts.ts                    — Layout interfaces (TextWall, ReferenceCard, etc.)
│   ├── webhooks.ts                   — Webhook request/response types
│   ├── models.ts                     — AppConfig, AppSetting, etc.
│   ├── capabilities.ts              — Device capability types
│   ├── enums.ts                      — AppType, LayoutType, ViewType, etc.
│   ├── dashboard/                    — Dashboard API types
│   ├── messages/
│   │   ├── glasses-to-cloud.ts       — Glasses → Cloud message types
│   │   ├── cloud-to-glasses.ts       — Cloud → Glasses message types
│   │   ├── app-to-cloud.ts           — App → Cloud message types
│   │   └── cloud-to-app.ts           — Cloud → App message types
│   ├── rtmp-stream.ts               — Streaming config types
│   ├── photo-data.ts                — Photo data types
│   └── token.ts                      — Token payload types
│
├── utils/
│   ├── Observable.ts                 — Reactive observable (for DeviceState)
│   ├── bitmap-utils.ts               — Bitmap manipulation helpers
│   ├── animation-utils.ts            — Animation frame helpers
│   ├── permissions-utils.ts          — Permission warning logs
│   └── resource-tracker.ts           — Automatic resource cleanup
│
├── display-utils/                    — Text measurement + display profiles
├── logging/
│   ├── logger.ts                     — Pino logger factory
│   └── errors.ts                     — MentraError class hierarchy
│
└── constants/
    └── index.ts                      — SDK constants
```

---

## Summary: The Complete Request Lifecycle

```
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │                           COMPLETE REQUEST LIFECYCLE                        │
 │                                                                             │
 │  1. User taps "Start App" on phone                                         │
 │  2. Phone sends START_APP → cloud via /glasses-ws WebSocket                │
 │  3. Cloud looks up app's publicUrl in MongoDB                              │
 │  4. Cloud POSTs webhook to {publicUrl}/webhook with session info + WS URL  │
 │  5. SDK receives webhook, creates AppSession                               │
 │  6. SDK opens WebSocket back to cloud at /app-ws                           │
 │  7. SDK sends tpa_connection_init (packageName, apiKey, sessionId)         │
 │  8. Cloud validates, sends tpa_connection_ack (settings, capabilities)     │
 │  9. Developer's onSession() fires — app is live!                           │
 │ 10. Developer registers handlers (e.g., onTranscription)                   │
 │ 11. SDK auto-sends subscription_update to cloud                            │
 │ 12. Glasses capture audio → phone relays → cloud transcribes              │
 │ 13. Cloud wraps transcription in DATA_STREAM, sends to subscribed apps     │
 │ 14. SDK emits event to developer's handler                                 │
 │ 15. Developer calls layouts.showTextWall("...")                            │
 │ 16. SDK sends DISPLAY_REQUEST → cloud → DISPLAY_EVENT → phone → glasses   │
 │ 17. Text appears on the AR display                                         │
 └─────────────────────────────────────────────────────────────────────────────┘
```
