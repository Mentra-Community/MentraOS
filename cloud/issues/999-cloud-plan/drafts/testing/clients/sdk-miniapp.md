# SDK MiniApp Server -- Cloud Client Map

This document maps the SDK MiniAppServer as a cloud client. It covers every operation, transport, hop sequence, and failure mode for the integration between third-party MiniApp servers and the MentraOS cloud.

---

## Overview

The SDK MiniApp server is an external process (run by a third-party developer) that connects to the cloud to control glasses features on behalf of a user session. The cloud acts as a relay and orchestrator between the MiniApp, the phone client, and hardware peripherals (glasses, microphone, camera). Communication is split across two transports: a persistent WebSocket for real-time bidirectional messaging and a REST API for storage, version checks, and stream management.

---

## Transports

| Transport      | Endpoint(s)                | Direction     | Purpose                                                                    |
| -------------- | -------------------------- | ------------- | -------------------------------------------------------------------------- |
| WebSocket      | `/app-ws` or `/ws/miniapp` | Bidirectional | Primary real-time channel for commands, data streams, and control messages |
| REST           | `/api/sdk/*`               | App -> Cloud  | Storage operations, version check, stream output management                |
| REST           | `/api/audio/*`, `/api/tts` | App -> Cloud  | Audio stream relay, text-to-speech proxy                                   |
| REST           | `/api/streams/*`           | App -> Cloud  | Restream output management                                                 |
| REST           | `/api/transcripts/*`       | App -> Cloud  | Session transcript retrieval                                               |
| Webhook (REST) | `{app.publicUrl}/webhook`  | Cloud -> App  | Session start notification                                                 |
| Webhook (REST) | `{app.publicUrl}/settings` | Cloud -> App  | Settings update push                                                       |
| Webhook (REST) | `{app.publicUrl}/tool`     | Cloud -> App  | AI tool invocation                                                         |

---

## Authentication

### WebSocket Auth

- **Header:** `Authorization: Bearer <JWT>`
- **Additional Headers:** `x-user-id`, `x-session-id`
- The JWT is derived from the app's `packageName:apiKey` credentials.
- Auth is validated on the WS upgrade request. A failed auth results in a `CONNECTION_ERROR` message after the handshake or an HTTP 401 on upgrade.

### REST Auth

- **Header:** `Authorization: Bearer <packageName:apiKey>`
- Applied to all `/api/sdk/*` endpoints except `/api/sdk/version` (no auth).
- Audio stream relay (`/api/audio/stream/:userId/:streamId`) uses UUID-as-token (no explicit auth header; the stream URL itself is the secret).
- TTS endpoints (`/api/audio/tts`, `/api/tts`) use SDK auth.

---

## WebSocket Message Types

### App -> Cloud

| Message Type               | Payload Summary                 | Purpose                                                                              |
| -------------------------- | ------------------------------- | ------------------------------------------------------------------------------------ |
| `CONNECTION_INIT`          | `{ packageName, apiKey }`       | App handshake, authenticates the WS session                                          |
| `SUBSCRIPTION_UPDATE`      | `{ add: [...], remove: [...] }` | Subscribe or unsubscribe to data streams (transcription, touch, notifications, etc.) |
| `DISPLAY_REQUEST`          | `{ layout, content }`           | Send display content to glasses screen                                               |
| `DASHBOARD_CONTENT_UPDATE` | `{ cards, layout }`             | Update dashboard card content                                                        |
| `DASHBOARD_MODE_CHANGE`    | `{ mode }`                      | Change dashboard display mode                                                        |
| `DASHBOARD_SYSTEM_UPDATE`  | `{ systemData }`                | Push system-level dashboard update                                                   |
| `RGB_LED_CONTROL`          | `{ color, pattern }`            | Control glasses LED color and pattern                                                |
| `CAMERA_FOV_SET`           | `{ fov }`                       | Set camera field of view                                                             |
| `STREAM_REQUEST`           | `{ streamConfig }`              | Start an unmanaged video stream                                                      |
| `STREAM_STOP`              | `{ streamId }`                  | Stop an unmanaged video stream                                                       |
| `MANAGED_STREAM_REQUEST`   | `{ streamConfig }`              | Start a managed (cloud-orchestrated) video stream                                    |
| `MANAGED_STREAM_STOP`      | `{ streamId }`                  | Stop a managed video stream                                                          |
| `STREAM_STATUS_CHECK`      | `{ streamId }`                  | Check current status of a stream                                                     |
| `LOCATION_POLL_REQUEST`    | `{}`                            | Request a fresh GPS location from the phone                                          |
| `PHOTO_REQUEST`            | `{ options }`                   | Request the glasses to capture a photo                                               |
| `AUDIO_PLAY_REQUEST`       | `{ url, options }`              | Play an audio file on the glasses                                                    |
| `AUDIO_STOP_REQUEST`       | `{}`                            | Stop currently playing audio                                                         |
| `AUDIO_STREAM_START`       | `{ format }`                    | Start an audio output stream to glasses                                              |
| `AUDIO_STREAM_END`         | `{ streamId }`                  | End an audio output stream                                                           |
| `REQUEST_WIFI_SETUP`       | `{}`                            | Prompt the user for WiFi setup on the phone                                          |
| `OWNERSHIP_RELEASE`        | `{}`                            | Release foreground ownership of the glasses                                          |
| Binary frames              | Raw MP3 bytes                   | Audio stream data sent after `AUDIO_STREAM_START`                                    |

### Cloud -> App

| Message Type         | Payload Summary         | Purpose                                                                                  |
| -------------------- | ----------------------- | ---------------------------------------------------------------------------------------- |
| `CONNECTION_ACK`     | `{ sessionId, userId }` | Confirms successful handshake and session binding                                        |
| `CONNECTION_ERROR`   | `{ code, message }`     | Auth failure, invalid session, or duplicate connection                                   |
| `DATA_STREAM`        | `{ type, data }`        | Subscribed data delivery (transcription, touch events, notifications, sensor data, etc.) |
| `SETTINGS_UPDATE`    | `{ settings }`          | User settings changed (pushed from phone or cloud)                                       |
| `SUBSCRIPTION_ACK`   | `{ subscriptions }`     | Confirms current active subscriptions after an update                                    |
| `AUDIO_STREAM_READY` | `{ url, streamId }`     | Audio output stream endpoint is ready; app should begin sending binary frames            |

---

## REST Endpoints

### SDK Core

| Method | Path                                  | Auth | Purpose                                             |
| ------ | ------------------------------------- | ---- | --------------------------------------------------- |
| GET    | `/api/sdk/version`                    | None | SDK version compatibility check                     |
| GET    | `/api/sdk/simple-storage/:email`      | SDK  | Get all stored key-value pairs for a user           |
| PUT    | `/api/sdk/simple-storage/:email`      | SDK  | Write/replace all stored key-value pairs for a user |
| DELETE | `/api/sdk/simple-storage/:email`      | SDK  | Delete all stored data for a user                   |
| GET    | `/api/sdk/simple-storage/:email/:key` | SDK  | Get a single stored value by key                    |
| PUT    | `/api/sdk/simple-storage/:email/:key` | SDK  | Write/replace a single stored value by key          |
| DELETE | `/api/sdk/simple-storage/:email/:key` | SDK  | Delete a single stored value by key                 |

### Stream Management

| Method | Path                                       | Auth | Purpose                               |
| ------ | ------------------------------------------ | ---- | ------------------------------------- |
| POST   | `/api/streams/:streamId/outputs`           | SDK  | Add a restream output destination     |
| DELETE | `/api/streams/:streamId/outputs/:outputId` | SDK  | Remove a restream output destination  |
| GET    | `/api/streams/:streamId/outputs`           | SDK  | List all restream output destinations |

### Audio

| Method | Path                                  | Auth                 | Purpose                                                |
| ------ | ------------------------------------- | -------------------- | ------------------------------------------------------ |
| GET    | `/api/audio/stream/:userId/:streamId` | None (UUID is token) | Audio output stream relay endpoint (consumed by phone) |
| GET    | `/api/audio/tts`                      | SDK                  | Text-to-speech via ElevenLabs proxy                    |
| GET    | `/api/tts`                            | SDK                  | Text-to-speech via ElevenLabs proxy (alias)            |

### Transcripts

| Method | Path                             | Auth | Purpose                                                |
| ------ | -------------------------------- | ---- | ------------------------------------------------------ |
| GET    | `/api/transcripts/:appSessionId` | SDK  | Retrieve transcripts for a completed or active session |

---

## Incoming Webhooks (Cloud -> App Server)

These are HTTP POST requests the cloud makes to the MiniApp's registered `publicUrl`.

| Endpoint                        | Trigger                                           | Payload Summary                                 |
| ------------------------------- | ------------------------------------------------- | ----------------------------------------------- |
| `POST {app.publicUrl}/webhook`  | User starts the app on their phone                | Session details: userId, sessionId, device info |
| `POST {app.publicUrl}/settings` | User changes a setting relevant to the app        | Updated settings object                         |
| `POST {app.publicUrl}/tool`     | AI assistant invokes a tool registered by the app | Tool name, arguments, conversation context      |

---

## Key Flows

### 1. App Session Start

**Trigger:** User selects the MiniApp on the phone.

```
Phone                     Cloud                      App Server
  |                         |                            |
  |-- START_APP (WS) ------>|                            |
  |                         |-- POST /webhook ---------->|
  |                         |                            |
  |                         |         (app processes)    |
  |                         |                            |
  |                         |<-- WS connect /app-ws -----|
  |                         |<-- CONNECTION_INIT --------|
  |                         |                            |
  |                         |   (validate auth)          |
  |                         |                            |
  |                         |-- CONNECTION_ACK --------->|
  |                         |                            |
```

**Failure Points:**

| Failure                    | Symptom                                        | Expected Behavior                                     |
| -------------------------- | ---------------------------------------------- | ----------------------------------------------------- |
| App server unreachable     | Webhook POST times out or connection refused   | Cloud notifies phone that app failed to start         |
| App server slow to connect | WS connection not opened within timeout window | Cloud times out the session, notifies phone           |
| WS handshake fails         | HTTP upgrade rejected (network, TLS, protocol) | App should retry with backoff; cloud logs the failure |
| Auth fails                 | Invalid packageName/apiKey or expired JWT      | Cloud sends `CONNECTION_ERROR` and closes WS          |

---

### 2. Transcription Subscription

**Trigger:** App subscribes to live transcription data.

```
App Server                Cloud                   Phone            Glasses
  |                         |                       |                 |
  |-- SUBSCRIPTION_UPDATE ->|                       |                 |
  |   (add: transcription)  |                       |                 |
  |                         |                       |                 |
  |<-- SUBSCRIPTION_ACK ----|                       |                 |
  |                         |                       |                 |
  |                         |       (audio arrives) |                 |
  |                         |<-- UDP audio ---------|<-- mic audio ---|
  |                         |                       |                 |
  |                         |   (Soniox STT)        |                 |
  |                         |                       |                 |
  |<-- DATA_STREAM ---------|                       |                 |
  |   (transcription text)  |                       |                 |
  |                         |                       |                 |
```

**Failure Points:**

| Failure                 | Symptom                                                         | Expected Behavior                                                                   |
| ----------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Subscription not ACK'd  | No `SUBSCRIPTION_ACK` received                                  | App should treat as failed; retry or surface error                                  |
| No audio arriving       | `DATA_STREAM` messages never arrive despite active subscription | Cloud has no data to transcribe; app should check session is active                 |
| Soniox down             | Transcription service unavailable                               | Cloud should surface an error via `DATA_STREAM` with error type or drop gracefully  |
| App WS drops mid-stream | Connection lost while transcription is active                   | Cloud stops transcription for this subscriber; app should reconnect and resubscribe |

---

### 3. Photo Request

**Trigger:** App requests the glasses to take a photo.

```
App Server                Cloud                   Phone              Glasses
  |                         |                       |                   |
  |-- PHOTO_REQUEST ------->|                       |                   |
  |                         |-- forward (WS) ------>|                   |
  |                         |                       |-- BLE command --->|
  |                         |                       |                   |
  |                         |                       |   (capture photo) |
  |                         |                       |                   |
  |                         |                       |<-- photo data ----|
  |                         |                       |                   |
  |                         |<-- POST /api/client/  |                   |
  |                         |    photo/response -----|                   |
  |                         |                       |                   |
  |<-- DATA_STREAM ---------|                       |                   |
  |   (photo payload)       |                       |                   |
  |                         |                       |                   |
```

**Failure Points:**

| Failure               | Symptom                                 | Expected Behavior                                              |
| --------------------- | --------------------------------------- | -------------------------------------------------------------- |
| Phone WS down         | Cloud cannot forward request to phone   | Cloud should fail fast and return error to app via WS          |
| Glasses not connected | Phone has no BLE connection to glasses  | Phone reports failure back to cloud; cloud relays error to app |
| Glasses don't respond | BLE command sent but no photo returned  | 30s timeout (current); cloud sends timeout error to app        |
| Photo upload fails    | Phone fails to POST photo data to cloud | Cloud never receives photo; app times out waiting for response |

---

### 4. Display Update

**Trigger:** App sends new content to show on the glasses display.

```
App Server                Cloud                   Phone              Glasses
  |                         |                       |                   |
  |-- DISPLAY_REQUEST ----->|                       |                   |
  |                         |   (validate + queue)  |                   |
  |                         |-- forward (WS) ------>|                   |
  |                         |                       |-- BLE display --->|
  |                         |                       |                   |
```

**Failure Points:**

| Failure                     | Symptom                                 | Expected Behavior                                         |
| --------------------------- | --------------------------------------- | --------------------------------------------------------- |
| Phone WS down               | Cloud cannot deliver display command    | Cloud should buffer or discard; notify app if persistent  |
| Throttling/queuing at cloud | Rapid display updates exceed rate limit | Cloud queues or drops older frames; delivers latest state |
| BLE disconnect              | Phone loses connection to glasses       | Phone reconnects BLE; pending display updates may be lost |

---

### 5. Audio Output Stream

**Trigger:** App wants to stream audio (e.g., TTS or music) to the glasses speaker via the phone.

```
App Server                Cloud                        Phone
  |                         |                             |
  |-- AUDIO_STREAM_START -->|                             |
  |                         |   (create stream endpoint)  |
  |                         |                             |
  |<-- AUDIO_STREAM_READY --|                             |
  |   (url, streamId)       |                             |
  |                         |                             |
  |== binary MP3 frames ===>|                             |
  |== binary MP3 frames ===>|-- relay audio chunks ------>|
  |== binary MP3 frames ===>|                             |
  |                         |                  (plays audio)
  |                         |                             |
  |-- AUDIO_STREAM_END ---->|                             |
  |                         |-- signal end -------------->|
  |                         |                             |
```

The phone fetches audio via `GET /api/audio/stream/:userId/:streamId`. The UUID in the URL acts as the access token.

**Failure Points:**

| Failure               | Symptom                                          | Expected Behavior                                               |
| --------------------- | ------------------------------------------------ | --------------------------------------------------------------- |
| Stream creation fails | No `AUDIO_STREAM_READY` received                 | App should timeout and retry or report error to user            |
| URL not delivered     | `AUDIO_STREAM_READY` lost due to WS instability  | App never begins streaming; should timeout and retry            |
| Binary frames dropped | Partial audio, gaps, or silence on playback      | Cloud should relay with minimal buffering; phone handles jitter |
| Phone can't play      | Phone audio subsystem busy or format unsupported | Phone reports playback error; cloud relays to app               |

---

## Connection Lifecycle

### Normal Lifecycle

1. Cloud receives `START_APP` from phone for this MiniApp
2. Cloud sends webhook POST to `{app.publicUrl}/webhook`
3. App opens WebSocket to cloud (`/app-ws` or `/ws/miniapp`)
4. App sends `CONNECTION_INIT` with credentials
5. Cloud validates and responds with `CONNECTION_ACK`
6. App subscribes to data streams, sends commands
7. Session ends: app sends `OWNERSHIP_RELEASE` or phone sends `STOP_APP`
8. Cloud closes WebSocket

### Reconnection

- If the app WS drops, the app should reconnect and re-send `CONNECTION_INIT`
- Active subscriptions are lost on disconnect; the app must resubscribe
- The cloud may hold the session open briefly to allow reconnection before notifying the phone of app failure

### Graceful Shutdown

- App sends `OWNERSHIP_RELEASE` to yield foreground control
- Cloud acknowledges and transitions the session
- App may keep the WS open for background data if permitted

---

## Error Codes

| Code                   | Context               | Meaning                                          |
| ---------------------- | --------------------- | ------------------------------------------------ |
| `AUTH_FAILED`          | `CONNECTION_ERROR`    | Invalid or expired credentials                   |
| `SESSION_NOT_FOUND`    | `CONNECTION_ERROR`    | No active session for the provided session ID    |
| `DUPLICATE_CONNECTION` | `CONNECTION_ERROR`    | Another WS is already connected for this session |
| `PHONE_DISCONNECTED`   | `DATA_STREAM` (error) | Phone WS is down; commands cannot be forwarded   |
| `DEVICE_NOT_CONNECTED` | `DATA_STREAM` (error) | Glasses not reachable via BLE                    |
| `TIMEOUT`              | `DATA_STREAM` (error) | A request to glasses or phone timed out          |
| `RATE_LIMITED`         | `DATA_STREAM` (error) | Too many requests in a short window              |

---

## Testing Considerations

- **WS Auth Rejection:** Verify that invalid credentials produce `CONNECTION_ERROR` and the socket closes cleanly.
- **Subscription Lifecycle:** Confirm subscribe, receive data, unsubscribe, and verify no data leaks after unsubscribe.
- **Photo Timeout:** Simulate glasses not responding and verify the 30s timeout propagates an error to the app.
- **Display Throttling:** Send rapid `DISPLAY_REQUEST` messages and verify the cloud queues or drops correctly.
- **Audio Stream Relay:** Stream binary MP3 frames and verify end-to-end delivery to the phone audio endpoint.
- **Webhook Delivery:** Verify the cloud retries or fails gracefully when the app server webhook endpoint is unreachable.
- **Reconnection:** Drop the WS mid-session and verify the app can reconnect, re-auth, and resubscribe without data loss.
- **Concurrent Sessions:** Verify behavior when the same app has multiple active sessions for different users.
- **Storage CRUD:** Exercise all simple-storage endpoints (create, read, update, delete) for both full-user and per-key variants.
- **Restream Outputs:** Add, list, and remove restream outputs; verify the stream picks up changes.
