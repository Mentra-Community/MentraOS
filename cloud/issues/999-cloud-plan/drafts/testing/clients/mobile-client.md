# Mobile Client (MentraOS Phone App)

## Overview

The mobile client is the most complex cloud client in the MentraOS system. The phone app acts as the relay between the user's glasses and the cloud, bridging BLE (glasses) to cloud transports. It uses three transports - REST, WebSocket, and UDP - each serving a distinct purpose in the pipeline.

The phone is always in the critical path for glasses operations. If the phone loses its cloud connection, the glasses lose all cloud-backed functionality.

## Transports and Auth

### Transports

| Transport | Endpoint(s)                                            | Purpose                       | Auth Mechanism           |
| --------- | ------------------------------------------------------ | ----------------------------- | ------------------------ |
| WebSocket | `/glasses-ws` or `/ws/client`                          | Primary bidirectional channel | JWT via query param      |
| REST      | `/api/client/*`, `/api/auth/*`, `/api/store/*`, others | Request/response operations   | JWT Bearer (core token)  |
| UDP       | Port 8000                                              | Low-latency audio streaming   | Registered via WebSocket |

### Auth

Authentication uses a JWT core token obtained through token exchange:

1. Phone authenticates with Supabase (or Authing)
2. Phone calls `POST /auth/exchange-token` with the Supabase/Authing token
3. Cloud returns a core JWT token
4. Core token is used for all subsequent REST (Bearer header) and WebSocket (query param) requests

UDP has no per-packet auth - it is registered via WebSocket using the `UDP_REGISTER` message, which associates a `userIdHash` with the authenticated session.

## Operations

### WebSocket Messages (Phone -> Cloud)

| Message Type               | Purpose                         | Expected Cloud Response        |
| -------------------------- | ------------------------------- | ------------------------------ |
| `CONNECTION_INIT`          | Initial handshake               | Connection acknowledgment      |
| `START_APP`                | Launch an SDK app               | App start confirmation via WS  |
| `STOP_APP`                 | Stop a running SDK app          | App stop confirmation via WS   |
| `GLASSES_CONNECTION_STATE` | Device connect/disconnect event | None (state update)            |
| `VAD`                      | Voice activity detection signal | None (triggers pipeline)       |
| `LOCAL_TRANSCRIPTION`      | Local transcription segment     | None (forwarded to app)        |
| `LOCATION_UPDATE`          | GPS coordinates from glasses    | None (state update)            |
| `CALENDAR_EVENT`           | Calendar update from phone      | None (state update)            |
| `STREAM_STATUS`            | Streaming status update         | None (forwarded to app)        |
| `KEEP_ALIVE_ACK`           | Stream keepalive acknowledgment | None                           |
| `AUDIO_PLAY_RESPONSE`      | Audio playback status           | None (forwarded to app)        |
| `RGB_LED_CONTROL_RESPONSE` | LED control response            | None (forwarded to app)        |
| `HEAD_POSITION`            | Head up/down orientation        | None (forwarded to app)        |
| `TOUCH_EVENT`              | Gesture events from glasses     | None (forwarded to app)        |
| `UDP_REGISTER`             | Register for UDP audio          | UDP endpoint confirmation      |
| `UDP_UNREGISTER`           | Unregister UDP audio            | None                           |
| `ping`                     | Keepalive ping                  | `pong`                         |
| Binary frames              | Raw audio (PCM/LC3)             | None (fed into audio pipeline) |

### REST Endpoints

#### Client API (`/api/client/*`)

| Method | Endpoint                                            | Purpose                       | Auth Required |
| ------ | --------------------------------------------------- | ----------------------------- | ------------- |
| POST   | `/api/client/photo/response`                        | Photo capture result          | Yes           |
| POST   | `/api/client/notifications`                         | Relay phone notifications     | Yes           |
| POST   | `/api/client/notifications/dismissed`               | Relay notification dismissals | Yes           |
| POST   | `/api/client/calendar`                              | Calendar events               | Yes           |
| POST   | `/api/client/location`                              | GPS location update           | Yes           |
| POST   | `/api/client/location/poll-response/:correlationId` | Location poll response        | Yes           |
| POST   | `/api/client/device/state`                          | Device state update           | Yes           |
| POST   | `/api/client/audio/configure`                       | Audio format configuration    | Yes           |
| POST   | `/api/client/feedback`                              | Bug/feature feedback          | Yes           |
| GET    | `/api/client/apps`                                  | List apps for home screen     | Yes           |
| GET    | `/api/client/min-version`                           | Minimum version check         | **No**        |
| GET    | `/api/client/user/settings/*`                       | Read user settings            | Yes           |
| PUT    | `/api/client/user/settings/*`                       | Update user settings          | Yes           |
| POST   | `/api/client/user/settings/*`                       | Create user settings          | Yes           |
| DELETE | `/api/client/user/settings/*`                       | Delete user settings          | Yes           |

#### Auth API (`/api/auth/*` and `/auth/*`)

| Method | Endpoint                                   | Purpose                          | Auth Required            |
| ------ | ------------------------------------------ | -------------------------------- | ------------------------ |
| POST   | `/auth/exchange-token`                     | Supabase/Authing -> core token   | No (uses provider token) |
| POST   | `/auth/generate-webview-token`             | Generate temp token for webview  | Yes                      |
| POST   | `/auth/generate-webview-signed-user-token` | Generate signed JWT for webviews | Yes                      |
| POST   | `/auth/hash-with-api-key`                  | Hash with app API key            | Yes                      |

#### Store API (`/api/store/*`)

| Method | Endpoint                            | Purpose       | Auth Required |
| ------ | ----------------------------------- | ------------- | ------------- |
| POST   | `/api/store/install/:packageName`   | Install app   | Yes           |
| POST   | `/api/store/uninstall/:packageName` | Uninstall app | Yes           |

#### App Lifecycle

| Method   | Endpoint                   | Purpose      | Auth Required |
| -------- | -------------------------- | ------------ | ------------- |
| GET/POST | `/apps/:packageName/start` | Start an app | Yes           |
| GET/POST | `/apps/:packageName/stop`  | Stop an app  | Yes           |

### UDP Protocol

UDP is used exclusively for low-latency audio streaming on port 8000.

**Packet format - Audio:**

```
[4 bytes: userIdHash][2 bytes: sequence number][N bytes: audio data]
```

Audio data may be unencrypted or encrypted with a nonce (negotiated during registration).

**Packet format - PING:**

```
[4 bytes: userIdHash][2 bytes: sequence number][4 bytes: "PING"]
```

**Registration flow:**

1. Phone sends `UDP_REGISTER` over WebSocket
2. Cloud associates `userIdHash` with the authenticated WS session
3. Phone begins sending UDP audio packets
4. Phone sends `UDP_UNREGISTER` when done (or cloud cleans up on WS disconnect)

## Key Flows

### 1. Photo Capture

**Hop sequence:**

```
SDK app -[WS]-> Cloud -[WS]-> Phone -[BLE]-> Glasses (capture command)
Glasses -[BLE]-> Phone -[REST POST /api/client/photo/response]-> Cloud -[WS]-> SDK app
```

**Failure points:**

| Failure               | Current Behavior              | Target Behavior                                  |
| --------------------- | ----------------------------- | ------------------------------------------------ |
| App WS down           | Photo request never sent      | Queue and retry; timeout with error to requester |
| Phone WS down         | Cloud cannot reach phone      | Reconnect and replay pending commands            |
| Glasses not connected | Phone cannot relay to glasses | Return error to cloud immediately                |
| Glasses don't respond | Indefinite wait or timeout    | Bounded timeout with error propagation           |
| Photo upload fails    | SDK app never receives result | Retry upload; error callback on final failure    |

### 2. Audio / Transcription

**Hop sequence:**

```
Glasses mic -[BLE]-> Phone -[UDP port 8000]-> Cloud -> Soniox -> Cloud -[WS data_stream]-> SDK app
```

**Failure points:**

| Failure         | Current Behavior                  | Target Behavior                                                 |
| --------------- | --------------------------------- | --------------------------------------------------------------- |
| BLE disconnect  | Audio stream stops silently       | Notify cloud; cloud notifies SDK app                            |
| UDP packet loss | Gaps in audio (no retransmission) | Accept loss (real-time audio); detect gaps via sequence numbers |
| Soniox timeout  | Transcription stalls              | Timeout and notify SDK app; retry if transient                  |
| App WS down     | Transcription results dropped     | Buffer briefly; drop if app doesn't reconnect                   |

### 3. Display Update

**Hop sequence:**

```
SDK app -[WS]-> Cloud -[WS]-> Phone -[BLE]-> Glasses
```

**Failure points:**

| Failure             | Current Behavior           | Target Behavior                                 |
| ------------------- | -------------------------- | ----------------------------------------------- |
| App WS down         | Display command never sent | Error back to app on reconnect                  |
| Phone WS down       | Cloud cannot reach phone   | Queue briefly; error to app if phone gone       |
| BLE disconnect      | Phone cannot reach glasses | Phone reports failure to cloud; cloud tells app |
| Glasses buffer full | BLE write fails or blocks  | Backpressure signal to cloud; cloud tells app   |

### 4. Start App

**Hop sequence:**

```
Phone -[WS START_APP]-> Cloud -[REST webhook POST]-> App server
App server -[WS /app-ws]-> Cloud -[WS]-> Phone (confirmation)
```

**Failure points:**

| Failure                 | Current Behavior                    | Target Behavior                              |
| ----------------------- | ----------------------------------- | -------------------------------------------- |
| App server unreachable  | Webhook fails silently or times out | Return error to phone within bounded timeout |
| App server timeout      | Long hang before failure            | Bounded timeout (e.g. 10s); error to phone   |
| App WS connection fails | App never connects back             | Timeout waiting for app WS; error to phone   |

### 5. Stream Start (Camera/SRT)

**Hop sequence:**

```
SDK app -[WS MANAGED_STREAM_REQUEST]-> Cloud -[WS]-> Phone -[BLE]-> Glasses (start camera + SRT)
Glasses -> SRT stream -> Cloudflare -> HLS/DASH/WebRTC URLs
Cloud -[WS managed_stream_status with URLs]-> SDK app
```

**Failure points:**

| Failure                    | Current Behavior                   | Target Behavior                              |
| -------------------------- | ---------------------------------- | -------------------------------------------- |
| Phone WS down              | Stream request never reaches phone | Queue and retry; timeout with error to app   |
| Glasses don't start stream | Known issue (see issue 088)        | Retry command; bounded timeout; error to app |
| Cloudflare relay fails     | Stream URLs never materialize      | Health-check relay; timeout; error to app    |

## Current Failure Behavior vs Target Behavior

**Current state:** Most failures result in silent drops, indefinite hangs, or require the user to restart the app. There is no systematic retry, timeout, or error propagation strategy across the phone relay.

**Target state:**

- Every operation has a bounded timeout
- Every failure propagates an error back to the originator (SDK app or phone UI)
- The phone attempts reconnection automatically on WS disconnect
- UDP packet loss is expected and handled gracefully (sequence gap detection, not retransmission)
- BLE disconnects are reported to the cloud immediately so the cloud can notify SDK apps
- App start has clear timeout boundaries at each hop (webhook, WS connect, confirmation)
- Stream start handles the glasses-not-responding case (issue 088) with retries and bounded timeout

The phone's role as a relay means every cloud operation touching the glasses has at least 4 hops (app -> cloud -> phone -> glasses) and 4 potential failure points. The testing strategy must cover each hop independently and in combination.
