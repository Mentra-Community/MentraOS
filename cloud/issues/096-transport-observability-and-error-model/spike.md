# 096 — Transport Observability and Per-Hop Error Model

## Summary

Every failure in MentraOS gets blamed on "the cloud." There is no per-hop observability across the four transports, no structured error model that identifies where a failure occurred, and no way for developers, users, or the team to distinguish between a glasses disconnect, a phone-to-cloud WebSocket drop, a cloud-to-SDK webhook failure, or an SDK-side bug.

This issue captures everything needed to make failures attributable, fast, and actionable across all four hops.

## The Four Hops

```
Hop 1: Glasses ←—BLE—→ Phone
Hop 2: Phone ←—WebSocket—→ Cloud
Hop 3: Cloud ←—webhook + WebSocket—→ SDK (mini app server)
Hop 4: SDK ←—internal—→ Developer code
```

Each hop has its own transport, its own failure modes, its own latency characteristics, and its own recovery path. Today, a failure at any hop surfaces to the developer (and the user) as a generic timeout or a cryptic error message with no indication of which hop broke.

## What Happens Today

### Developer perspective

A developer calls `session.camera.takePhoto()`. It times out after 30 seconds. They get: `"Photo request timed out after 30000ms"`. They have no idea if:

- Hop 1: Glasses are disconnected from the phone (camera physically unreachable)
- Hop 2: Phone lost its WebSocket to the cloud (request never left the phone)
- Hop 3: Cloud received it but the SDK WebSocket was down (cloud can't forward to glasses)
- Hop 4: Everything was fine but the glasses camera was busy streaming (precondition failure)

Each of these has a completely different fix. The developer can't do anything about hops 1-3. Hop 4 is something the SDK could check locally and reject in 0ms instead of 30s.

### Team perspective

A bug report comes in: "the app failed several times to open." The team spends hours pulling BetterStack logs, correlating timestamps across regions, and discovers it was a Cloudflare load balancer rebalance (hop 2.5, infrastructure between phone and cloud). The cloud was healthy the entire time.

Another report: "apps stopped working." Investigation reveals the client's WebSocket liveness monitor was disabled, and the phone sat with a dead connection for 120 seconds before TCP keepalive caught it (hop 2, client side). The cloud's session was alive and sending pings the whole time. But the user saw "cloud is broken."

### The "WiFi breaks the WebSocket" example

When a user tries to take a photo or start a stream while WiFi is off or unstable, the operation fails — and apparently this failure can break the WebSocket connection itself. An error in one operation (hop 1: glasses can't use camera because WiFi is off) cascades into a transport failure (hop 3: SDK WebSocket to cloud drops). This kind of cross-hop cascade is invisible without per-hop instrumentation.

## What We Need

### 1. Per-hop health visibility

Every request that crosses a hop should know the state of that hop before it tries. The SDK should be able to answer:

| Question                                    | Where the answer lives                                  |
| ------------------------------------------- | ------------------------------------------------------- |
| Are glasses connected to the phone?         | Cloud knows (glasses WebSocket state on UserSession)    |
| Is the phone connected to the cloud?        | Cloud knows (phone WebSocket state on UserSession)      |
| Is the SDK connected to the cloud?          | SDK knows (MentraSession.isConnected / transport state) |
| Is the camera available?                    | Cloud knows (device capabilities + streaming state)     |
| Is the user's session alive on this region? | Cloud knows (UserSession exists or not)                 |

Some of this is already tracked internally. None of it is surfaced to the developer in error messages.

### 2. Structured error responses with hop attribution

When an operation fails, the error should say where and why:

```
// Today
"Photo request timed out after 30000ms"
"Managed stream request timeout"
"WebSocket closed with code 1008"

// What it should be
"Photo failed: glasses camera is busy (streaming active)"           → hop 1, precondition
"Photo failed: glasses not connected to phone"                      → hop 1, transport
"Photo failed: phone not connected to cloud"                        → hop 2, transport
"Stream failed: cloud could not reach glasses (phone disconnected)" → hop 2, transport
"Stream failed: SDK not connected to cloud (reconnecting)"          → hop 3, transport
"Stop request dropped: SDK transport closed"                        → hop 3, transport
```

### 3. Fail-fast precondition checks in the SDK

The SDK has enough local state to catch many failures instantly instead of waiting for a 30-second timeout:

| Check                                       | State available                                                            | Saves        |
| ------------------------------------------- | -------------------------------------------------------------------------- | ------------ |
| Taking photo while streaming                | `CameraManager.isCurrentlyStreaming()`                                     | 30s timeout  |
| Any operation while SDK transport is closed | `MentraSession.isConnected`                                                | 30s timeout  |
| Starting stream while already streaming     | Already checked — `isStreaming \|\| isManagedStreaming`                    | Already fast |
| Taking photo without camera permission      | `CameraManager.hasPermission` (partially — only set by photo errors today) | 30s timeout  |

The SDK can't know about hop 1 or hop 2 state locally. But the cloud can reject fast and tell the SDK why:

- Cloud receives `PHOTO_REQUEST` → checks if glasses WS is connected → if not, responds immediately with `{ type: "photo_response", error: "glasses_not_connected" }` instead of forwarding into the void
- Cloud receives `MANAGED_STREAM_REQUEST` → checks if the user has an active session → if not, responds with `{ error: "no_active_session" }`

### 4. Cloud-side request tracking

For operations that cross multiple hops (photo request: SDK → cloud → phone → glasses → phone → cloud → SDK), the cloud should log each hop transition with the same request ID:

```
[request_id=photo_req_abc123] Received PHOTO_REQUEST from com.example.app
[request_id=photo_req_abc123] Forwarding to glasses via UserSession (glasses WS: connected)
[request_id=photo_req_abc123] Glasses acknowledged photo request
[request_id=photo_req_abc123] Photo upload received from phone (324KB, 1.2s)
[request_id=photo_req_abc123] Delivered to app via app WS
```

Or on failure:

```
[request_id=photo_req_abc123] Received PHOTO_REQUEST from com.example.app
[request_id=photo_req_abc123] REJECTED: glasses WebSocket not connected (last seen 45s ago)
```

This gives the team instant per-hop attribution in BetterStack without manual timestamp correlation.

### 5. SDK-side transport state events for developers

The SDK should expose transport state changes so developers can build appropriate UX:

```typescript
// Not designing the API here — just illustrating what developers need to know
session.onTransportState((state) => {
  // state.sdk: "connected" | "reconnecting" | "disconnected"
  // state.glasses: "connected" | "disconnected" | "unknown"
  // state.reason: human-readable string
})
```

The SDK already receives `device_state_update` messages that include `connected` (glasses-to-phone state). It knows its own transport state. Combining these gives the developer a picture of which hops are healthy without them having to guess.

## Scope of This Issue

This issue covers the investigation, design, and implementation plan. It does NOT cover the full implementation — that will be broken into sub-issues.

### In scope

- Audit every operation that crosses a hop (photo, stream start/stop, display update, transcription, etc.) and document the current failure mode and latency
- Design the structured error type that carries hop attribution
- Identify all precondition checks the SDK can do locally (fail-fast)
- Identify all precondition checks the cloud can do before forwarding (fail-fast)
- Design the cloud-side request tracking format (request ID propagation)
- Design the SDK transport state surface for developers
- Identify cross-hop cascades (like "WiFi error breaks the WebSocket")

### Out of scope (separate issues)

- Implementing per-hop health checks in the cloud
- Implementing the SDK transport state API
- Implementing request ID tracking across all hops
- Client-side (mobile app) observability improvements
- Glasses-side (ASG client) observability improvements

## Audit: Current Fail-Slow Operations

From the CameraManager audit (v3 code path):

| Operation                            | Failure scenario              | Time to know             | Error message                             | Hop                    |
| ------------------------------------ | ----------------------------- | ------------------------ | ----------------------------------------- | ---------------------- |
| `takePhoto()` while streaming        | Camera hardware busy          | 30 seconds               | Generic timeout                           | 1 (local precondition) |
| `takePhoto()` while not connected    | Message silently dropped      | 30 seconds               | Generic timeout                           | 3 (SDK transport)      |
| `takePhoto()` glasses disconnected   | Cloud forwards into void      | 30 seconds               | Generic timeout                           | 1 (glasses transport)  |
| `startStream({ direct })` WS closed  | Fire-and-forget, flag stuck   | Never                    | None — `isStreaming` stuck true           | 3 (SDK transport)      |
| `startStream()` managed, no response | Cloud or glasses unresponsive | 30 seconds               | `"Managed stream request timeout"`        | Unknown                |
| `stopStream()` WS closed             | Message silently dropped      | 0ms (looks like success) | None                                      | 3 (SDK transport)      |
| `checkExistingStream()` no response  | Cloud unresponsive            | 5 seconds                | False negative (`hasActiveStream: false`) | 3 (cloud)              |

### Operations not yet audited (need same treatment)

- `session.display.showText()` / `showTextWall()` / `clear()` — fire-and-forget display updates. If glasses are disconnected, the display command goes into the void. No feedback to the developer.
- `session.speaker.play()` / `speak()` — audio playback requests. Same fire-and-forget pattern.
- `session.transcription.on()` — subscribes to transcription. If Soniox is down or glasses mic is off, the developer just never receives events. No error signal.
- `session.led.setColor()` — fire-and-forget LED command.
- `session.phone.notifications.send()` — sends notification to phone. No delivery confirmation.
- `session.location.requestUpdate()` — requests GPS update from phone. Timeout behavior unknown.

## Audit: Cross-Hop Cascades

Known or suspected cases where a failure at one hop causes failures at other hops:

| Trigger                                   | Cascade                                                                                        | Impact                                                                                               |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| WiFi off on glasses → stream/photo error  | Error response breaks the SDK WebSocket?                                                       | Hop 1 failure → hop 3 failure. Needs investigation — why would a glasses-side error kill the app WS? |
| Cloudflare rebalance (hop 2 infra)        | Phone reconnects to different region → 503s → session rebuild → all apps restart               | Infrastructure event → hop 2 → hop 3 cascade. Documented in issue 095.                               |
| Cloud readiness probe slow (hop 2 infra)  | K8s marks pod not-ready → nginx 503s → phone sees 503 → reconnects WS → new session            | Infrastructure event → hop 2 → hop 3. Documented in infra.md.                                        |
| MongoDB slow on East Asia (hop 2 backend) | Session setup takes 2-3 seconds → webhook to SDK delayed → developer's `onSession` starts late | Backend latency → hop 3 delay. Documented in issue 062.                                              |
| App crash/restart (hop 4)                 | Stream orphaned → glasses keep streaming → battery drain → no one controlling the stream       | Hop 4 failure → hop 1 resource leak. Documented in issue 085.                                        |

## Relationship to Existing Work

| Issue                                                  | Relationship                                                                                                                  |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| 034 — WS Liveness                                      | Added app-level ping/pong between phone and cloud (hop 2). First step toward transport health visibility.                     |
| 062 — MongoDB Latency                                  | Cross-region DB latency causing slow operations. Per-hop timing would make this immediately visible.                          |
| 066 — WS Disconnect Churn                              | Proved most disconnects are client-side (hop 2, client). Per-hop attribution made this provable.                              |
| 069 — WS Disconnect Observability                      | Added `ws-close` instrumentation with `timeSinceLastClientMessage` and close codes. The template for per-hop instrumentation. |
| 079 — Client Liveness Reconnect Gap                    | Phone doesn't know its WS is dead for 30-120 seconds. Hop 2 observability gap on the client side.                             |
| 085 — Orphaned Stream Cleanup                          | Stream survives app crash (hop 4 failure doesn't cascade to hop 1). The "streams belong to the user" principle.               |
| 087 — Managed Stream Status Not Delivered on Reconnect | Cloud dedup cache blocks status delivery after reconnect. Hop 3 state not properly reset.                                     |
| 091 — Unified onStreamStatus                           | Unified the developer-facing event. The API design is right; the implementation needs to normalize payloads.                  |
| 092 — SDK v3 Alpha Regressions                         | Documented the v3 API contract. This issue makes the implementation match.                                                    |
| 095 — Cloudflare Session Affinity                      | Mid-session region switch (infrastructure between hop 1 and hop 2). Fixed by enabling session affinity on the LB.             |
| Leo developer feedback tickets                         | 11 issues, most traceable to missing per-hop error attribution or fail-slow behavior.                                         |

## Next Steps

1. **Finish the CameraManager normalization** — make `onStreamStatus` match the documented API (unified payload, transition-only emission). This is the immediate code fix on the current branch.
2. **Add fail-fast precondition checks** to CameraManager — `takePhoto()` rejects instantly if streaming, `startStream()` rejects if transport is closed.
3. **Write the structured error type design** — what fields, what hop values, how it propagates from cloud to SDK to developer.
4. **Design the cloud-side request tracking** — request ID propagation format, logging pattern, BetterStack query patterns.
5. **Investigate the WiFi-breaks-WebSocket cascade** — reproduce and document the exact failure chain.

## Sub-Issues

Each sub-issue targets a specific manager or cross-cutting concern. They can be worked independently.

### 096-a: CameraManager — stream status normalization and fail-fast

The documented v3 API (`docs/app-devs/core-concepts/camera/streaming.mdx`) promises one `onStreamStatus` callback with unified status values (`"initializing"`, `"active"`, `"stopped"`, `"error"`) regardless of mode. The implementation emits two different internal events with two different payload shapes.

Fix: CameraManager normalizes all three wire message types (`rtmp_stream_status`, `stream_status`, `managed_stream_status`) into one `StreamStatus` shape before emitting. Only emits on status transitions (cloud heartbeat repeats are handled internally). The subscription protocol (SDK subscribes to both `"stream_status"` and `"managed_stream_status"` on the wire) stays unchanged.

Also: `takePhoto()` should reject instantly if `isCurrentlyStreaming()` is true instead of timing out after 30 seconds.

**Fail-slow operations in CameraManager:**

| Operation                                  | Failure                     | Time to know             | Fix                                                  |
| ------------------------------------------ | --------------------------- | ------------------------ | ---------------------------------------------------- |
| `takePhoto()` while streaming              | Camera busy                 | 30s timeout              | Check `isCurrentlyStreaming()`, reject instantly     |
| `takePhoto()` transport closed             | Message dropped             | 30s timeout              | Check transport, reject instantly                    |
| `startStream({ direct })` transport closed | Flag stuck, message dropped | Never                    | Check transport, reject instantly                    |
| `startStream()` managed, no response       | Unknown hop failure         | 30s timeout              | Cloud-side fast rejection (096-g)                    |
| `stopStream()` transport closed            | Message dropped silently    | 0ms (looks like success) | Log warning, best-effort                             |
| `checkExistingStream()` no response        | False negative              | 5s                       | Acceptable, but should indicate timeout vs confirmed |

### 096-b: SpeakerManager — play/speak/stop fail silently

7 `sendMessage` call sites. 5 are fire-and-forget with no feedback:

| Method                                     | Message                                   | Fire-and-forget | Timeout |
| ------------------------------------------ | ----------------------------------------- | --------------- | ------- |
| `play()` (default, `stopOtherAudio=false`) | `AUDIO_PLAY_REQUEST`                      | Yes             | None    |
| `play()` (`stopOtherAudio=true`)           | `AUDIO_PLAY_REQUEST`                      | No              | 60s     |
| `stop()`                                   | `AUDIO_STOP_REQUEST`                      | Yes             | None    |
| `speak()`                                  | `AUDIO_PLAY_REQUEST` (via play)           | Yes (default)   | None    |
| `stream.open()`                            | `AUDIO_STREAM_START`                      | No              | 10s     |
| `stream.open()` (2nd msg)                  | `AUDIO_PLAY_REQUEST`                      | Yes             | None    |
| `stream.end()`                             | `AUDIO_STREAM_END`                        | Yes             | None    |
| `stream.flush()`                           | `AUDIO_STREAM_END` + `AUDIO_STOP_REQUEST` | Yes (both)      | None    |

The `sendBinaryFrame()` method is the one bright spot — it wraps `sendBinary` in try/catch and transitions to `"error"` state on failure. Every `sendMessage` call site should follow this pattern.

`createStream()` has good precondition checking (throws `AUDIO_STREAM_ALREADY_ACTIVE` if a stream exists). `play()` and `speak()` validate input. But none check transport state.

### 096-c: DisplayManager — all 7 methods fire-and-forget

Every public method (`showText`, `showTextWall`, `showDoubleTextWall`, `showReferenceCard`, `showDashboardCard`, `showBitmap`, `clear`) delegates to one private `sendDisplayEvent()` which calls `sendMessage` with no transport check, no timeout, and no delivery confirmation.

`showBitmap()` is the only method with meaningful validation (checks type and size < 1MB). `sendDisplayEvent()` validates `layoutType` exists and `viewType` is valid. Everything else passes through unchecked.

Display is inherently fire-and-forget (the glasses render or they don't), so timeouts don't make sense here. But transport-down detection and logging would help developers understand why their display isn't updating.

### 096-d: LedManager — fire-and-forget, no validation

2 call sites (`setColor`, `off`), both fire-and-forget. No input validation on the color string. No transport check. No feedback. Low priority since LED failures are cosmetic, but should at least check transport state and log if the message can't be sent.

### 096-e: Cross-manager precondition checks

Several managers expose permission state (`hasPermission`) but never check it before sending requests:

| Manager         | Has permission field                                   | Checks before sending |
| --------------- | ------------------------------------------------------ | --------------------- |
| CameraManager   | `hasPermission` (partially — only set by photo errors) | No                    |
| SpeakerManager  | Exposes `hasPermission`                                | No                    |
| LocationManager | Exposes `hasPermission`                                | No                    |
| LedManager      | None                                                   | N/A                   |
| DisplayManager  | None                                                   | N/A                   |

Also: CameraManager has `isCurrentlyStreaming()` but `takePhoto()` doesn't call it. The camera hardware can only do one thing at a time — streaming blocks photos. The SDK knows this and should reject instantly.

### 096-f: Transport-down behavior (architectural decision)

**This is the key design question that applies to all managers.**

When the SDK's WebSocket to the cloud is closed (hop 3 transport down), what should `sendMessage` do? Three options:

1. **Silent drop** (current behavior in v3 `WebSocketTransport.send()`). The developer never knows the message didn't go out. `stopStream()` "succeeds" but the stream keeps running. `takePhoto()` waits 30 seconds for a response that will never come.

2. **Immediate reject**. Every method that calls `sendMessage` checks transport state first. If closed, rejects with `"SDK not connected to cloud (reconnecting in Xs)"`. Problem: the SDK might reconnect in 1 second and the request would have been fine. This is too aggressive for display/LED/dashboard commands that are best-effort anyway.

3. **Tiered behavior based on operation type**:
   - **Request-response operations** (takePhoto, startStream managed, requestUpdate, play with blocking): reject immediately if transport is down. The developer is awaiting a promise — they need to know it won't resolve.
   - **Fire-and-forget commands** (display, LED, dashboard, stopStream, transcription configure): send best-effort. If transport is down, log a debug warning but don't throw. These are idempotent or ephemeral — the developer will send another one when the session reconnects.
   - **State-changing operations** (startStream direct): reject immediately. Setting local flags (`isStreaming = true`) when the message can't be delivered corrupts state.

Option 3 matches the v3 design philosophy: simple cases stay simple (display commands just work or don't), complex cases give clear feedback (photo/stream requests tell you why they failed).

### 096-g: Cloud-side fast rejection

The cloud already has a centralized `ConnectionValidator.validateForHardwareRequest()` in `cloud/packages/cloud/src/services/validators/ConnectionValidator.ts` that checks phone WS state and glasses connectivity. It already defines error codes that map to hops:

```
ConnectionErrorCode.PHONE_DISCONNECTED   → hop 2 (phone ↔ cloud)
ConnectionErrorCode.GLASSES_DISCONNECTED → hop 1 (glasses ↔ phone)
ConnectionErrorCode.WIFI_NOT_CONNECTED   → hop 1 (glasses WiFi)
ConnectionErrorCode.WEBSOCKET_CLOSED     → hop 2 (phone WS closed)
ConnectionErrorCode.STALE_CONNECTION     → hop 1 (glasses state not fresh)
```

**The validator is used inconsistently.** The streaming paths (`UnmanagedStreamingExtension.startStream`, `ManagedStreamingExtension.startManagedStream`) do thorough checking. The photo path (`PhotoManager.requestPhoto`) uses the validator but skips other checks. Here's what each message type actually validates today:

| Check                                                | PHOTO_REQUEST | STREAM_REQUEST | MANAGED_STREAM_REQUEST |
| ---------------------------------------------------- | :-----------: | :------------: | :--------------------: |
| Camera permission (DB lookup)                        |      ✅       |       ✅       |           ✅           |
| Phone WS connected (ConnectionValidator)             |      ✅       |       ✅       |           ✅           |
| Glasses connected (ConnectionValidator)              |      ✅       |       ✅       |           ✅           |
| App is running (`appManager.isAppRunning`)           |  ❌ **gap**   |       ✅       |           ✅           |
| WiFi validation (`validateWifiForOperation`)         |  ❌ **gap**   |       ✅       |           ✅           |
| Stream conflict (`stateManager.checkStreamConflict`) |      N/A      |   ❌ **gap**   |           ✅           |
| Camera busy (another app streaming)                  |  ❌ **gap**   |      N/A       |          N/A           |

**Code paths:**

- `PHOTO_REQUEST`: `app-message-handler.handlePhotoRequest()` → `checkCameraPermission()` → `PhotoManager.requestPhoto()` → `ConnectionValidator.validateForHardwareRequest("photo")` → sends to `userSession.websocket`. Missing: `isAppRunning`, WiFi check, camera-busy check.
- `STREAM_REQUEST`: `app-message-handler.handleStreamRequest()` → `checkCameraPermission()` → `UnmanagedStreamingExtension.startStream()` → `isAppRunning` + `ConnectionValidator` + `validateWifiForOperation` + WS open check. Missing: stream conflict check (managed has it, unmanaged doesn't).
- `MANAGED_STREAM_REQUEST`: `app-message-handler.handleManagedStreamRequest()` → `checkCameraPermission()` → `ManagedStreamingExtension.startManagedStream()` → all checks including `checkStreamConflict`. Most complete.

**Error propagation is also inconsistent.** When streaming checks fail, the error codes are specific (`WIFI_NOT_CONNECTED`, app not running). When the photo ConnectionValidator fails, the error is caught and sent as generic `INTERNAL_ERROR` via `sendError(appWebsocket, AppErrorCode.INTERNAL_ERROR, ...)`. The specific `ConnectionErrorCode` is lost.

**What the cloud already has but doesn't use for photos:**

| State                     | Available via                                                                   | Could catch                                                   |
| ------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Camera is busy streaming  | `managedStreamingExtension` / `unmanagedStreamingExtension` active stream state | Photo while streaming → instant reject instead of 30s timeout |
| Which app owns the camera | `stateManager` tracks packageName per stream                                    | "Camera in use by another app" instead of generic timeout     |
| Glasses WiFi state        | `deviceManager.deviceState.wifiConnected`                                       | Photo transfer needs WiFi (same as streaming)                 |

**Fix:** Align all three message types to the same validation chain. The `MANAGED_STREAM_REQUEST` path is the gold standard — apply the same checks to `PHOTO_REQUEST` and `STREAM_REQUEST`. Propagate `ConnectionErrorCode` values back to the SDK instead of flattening to `INTERNAL_ERROR`.

### 096-i: Cloud `sendError()` kills the WebSocket for operational errors

**This is the single biggest foot gun in the entire system.**

The cloud's `sendError()` utility in `app-message-handler.ts` (L788-798) sends a `CONNECTION_ERROR` message and then **immediately closes the WebSocket with 1008** — for every error, including transient/recoverable ones:

```
function sendError(ws, code, message, logger) {
  ws.send(JSON.stringify({ type: "tpa_connection_error", code, message, timestamp: new Date() }));
  ws.close(1008, message);  // ← kills the connection
}
```

This is called for:

- `PERMISSION_DENIED` (camera, stream, photo) — developer forgot to add a permission in the console
- `INTERNAL_ERROR` ("Glasses not connected") — glasses had a momentary BLE disconnect
- `WIFI_NOT_CONNECTED` — glasses WiFi dropped for a second
- `MALFORMED_MESSAGE` — developer sent a bad subscription format

**Every one of these kills the app's entire WebSocket connection.** A developer tries to take a photo without camera permission, and they lose their session. That's not an error response — that's a nuclear option for a recoverable problem.

**Fix:** Split `sendError()` into two functions:

- `sendOperationalError(ws, code, message)` — sends the error message, **keeps the connection open**. The SDK receives the error, surfaces it to the developer, and the app continues running. For: permission denied, glasses not connected, WiFi off, malformed message, camera busy.
- `sendFatalError(ws, code, message)` — sends the error AND closes with 1008. For: invalid API key, session not found, app deprecated, session expired — things where the connection is fundamentally broken and reconnecting will never work.

**Call sites to audit** (all in `app-message-handler.ts` and `bun-websocket.ts`):

| Current `sendError` call                  | Error code           | Should be                         |
| ----------------------------------------- | -------------------- | --------------------------------- |
| Camera permission denied (photo)          | `PERMISSION_DENIED`  | **Operational** — keep connection |
| Camera permission denied (stream)         | `PERMISSION_DENIED`  | **Operational** — keep connection |
| Camera permission denied (managed stream) | `PERMISSION_DENIED`  | **Operational** — keep connection |
| Glasses not connected (stream forward)    | `INTERNAL_ERROR`     | **Operational** — keep connection |
| WiFi not connected (stream)               | `WIFI_NOT_CONNECTED` | **Operational** — keep connection |
| Malformed subscription                    | `MALFORMED_MESSAGE`  | **Operational** — keep connection |
| Invalid API key (init)                    | `INVALID_API_KEY`    | **Fatal** — close connection      |
| Session not found                         | `SESSION_NOT_FOUND`  | **Fatal** — close connection      |
| App deprecated                            | `APP_DEPRECATED`     | **Fatal** — close connection      |
| App not started for session               | `APP_NOT_RUNNING`    | **Fatal** — close connection      |

**Code pointers:**

- `cloud/packages/cloud/src/services/session/handlers/app-message-handler.ts` — `sendError()` at L788-798, all call sites throughout file
- `cloud/packages/cloud/src/services/websocket/bun-websocket.ts` — direct `ws.close(1008, ...)` calls for connection setup failures

### 096-j: v3 SDK ignores close codes — always reconnects

The v3 `_ConnectionManager` (L111-121) treats **every** WebSocket close identically. The `permanent` flag is determined only by `this.explicitDisconnect || !this.deps.autoReconnect` — the close code is never inspected. Whether the cloud sends 1000, 1008, or 1011, the SDK always tries to reconnect.

The v2 SDK had this partially right:

```
// v2 AppSession — treated 1008 as "don't reconnect"
const isNormalClosure = code === 1000 || code === 1001 || code === 1008;
```

The v3 rewrite lost this logic. The result:

- Cloud sends `ws.close(1008, "Invalid API key")` → SDK reconnects → rejected → reconnects → rejected → 3 attempts over ~7 seconds → finally gives up
- Cloud sends `ws.close(1008, "App deprecated")` → same futile loop
- Cloud sends `ws.close(1008, "Permission denied")` (from 096-i bug) → SDK reconnects, succeeds, but developer has no idea what happened

**Fix:** Add close code awareness to `_ConnectionManager.onClose`:

- **1000** (Normal Closure): check if `APP_STOPPED` was already received → if yes, don't reconnect. If no, this might be a server-initiated clean close during deploy → reconnect.
- **1001** (Going Away): server shutting down → reconnect (it's coming back).
- **1008** (Policy Violation): the cloud explicitly rejected us → **do NOT reconnect**. Mark as permanent. The reason string tells the developer why.
- **1011** (Internal Error): server bug → reconnect is reasonable (might recover).
- **4xxx** (custom codes, if we add them): handle per-code.

**Also:** The `CONNECTION_ERROR` handler (MentraSession L324-328) discards the error code — it creates an `Error` from just the message text. The code should be preserved so developers can programmatically handle different error types:

```
// Today: developer gets Error("Camera permission required")
// Should be: developer gets { code: "PERMISSION_DENIED", message: "Camera permission required" }
```

**Code pointers:**

- `cloud/packages/sdk/src/session/internal/_ConnectionManager.ts` — `onClose` handler at L111-121
- `cloud/packages/sdk/src/session/MentraSession.ts` — `CONNECTION_ERROR` handler at L324-328
- `cloud/packages/sdk/src/app/session/index.ts` — v2 close code logic at L827-851 (reference for what v3 should restore)

### 096-i and 096-j together

These two issues form a vicious cycle:

1. Cloud sends operational error + closes WS with 1008 (096-i)
2. SDK ignores the 1008 and reconnects (096-j)
3. Reconnect succeeds → session resumes → developer never learns why
4. Or: reconnect fails → more 1008s → futile retry loop → session dies after ~7 seconds

Fixing both:

- 096-i (cloud stops killing WS for operational errors) eliminates most instances of the cascade
- 096-j (SDK respects close codes) handles the remaining cases where a fatal close is legitimate

**Priority: 096-i first.** Fixing the cloud side immediately stops the cascade for all SDK versions — v2, v3, and any future version. 096-j is defense-in-depth for the v3 SDK.

### 096-h: Request ID propagation across hops

For operations that cross multiple hops (photo: SDK → cloud → phone → glasses → phone → cloud → SDK), every hop transition should be logged with the same request ID. The SDK already generates request IDs (`generateRequestId("photo_req")`) — the cloud needs to propagate them through to the phone/glasses messages and log them at each transition.

Target: given a request ID from a developer's error log, a team member can query BetterStack and see the exact path the request took and where it stopped:

```
[photo_req_abc123] Received from com.example.app
[photo_req_abc123] Forwarding to glasses (glasses WS: connected, phone WS: connected)
[photo_req_abc123] Glasses responded: camera_busy (streaming active)
[photo_req_abc123] Sent error response to app: "camera_busy_streaming"
```

### Managers that don't send messages (no sub-issue needed)

| Manager              | Why no sub-issue                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MicManager           | Receive-only. Uses subscriptions, never sends commands.                                                                                                       |
| PhoneManager         | Receive-only. Notifications and calendar are inbound data.                                                                                                    |
| TranslationManager   | Receive-only. Uses subscriptions for data routing.                                                                                                            |
| TranscriptionManager | `configure()` is the only send — fire-and-forget is acceptable for config pushes. `stop()` works via subscription removal.                                    |
| LocationManager      | Already the best-implemented: try/catch around sendMessage, correlation-based response matching, 15s timeout. Could add permission check but otherwise solid. |

## Priority

For the v3 beta:

1. **096-a** (CameraManager) — most developer-visible, directly addresses Leo's feedback
2. **096-f** (transport-down architectural decision) — unlocks all other sub-issues
3. **096-e** (precondition checks) — quick wins, biggest fail-fast improvement
4. **096-g** (cloud-side fast rejection) — biggest latency improvement, requires cloud changes
5. **096-b** (SpeakerManager) — second most common developer operation after camera
6. **096-h** (request ID propagation) — enables team debugging, cross-cutting
7. **096-c** (DisplayManager) — lower priority, fire-and-forget is acceptable for display
8. **096-d** (LedManager) — lowest priority, cosmetic failures
