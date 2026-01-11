# Photo System Architecture

End-to-end documentation of how photo capture works across SDK, Cloud, Mobile, and ASG client.

## System Overview

```
┌─────────────┐    WebSocket    ┌─────────────┐    WebSocket    ┌─────────────┐    BLE/Serial    ┌─────────────┐
│  SDK/App    │ ───────────────▶│    Cloud    │ ───────────────▶│   Mobile    │ ────────────────▶│   Glasses   │
│  (Node.js)  │                 │  (Node.js)  │                 │  (Android)  │                  │  (Android)  │
└─────────────┘                 └─────────────┘                 └─────────────┘                  └─────────────┘
      │                               │                               │                               │
      │  1. requestPhoto()            │                               │                               │
      │──────────────────────────────▶│  2. Forward to glasses        │                               │
      │                               │──────────────────────────────▶│  3. Forward via BLE/serial    │
      │                               │                               │──────────────────────────────▶│
      │                               │                               │                               │  4. Camera capture
      │                               │                               │                               │     (CameraNeo)
      │                               │                               │                               │
      │  7. Photo received            │  6. Forward to SDK            │  5. Upload to webhook         │
      │◀──────────────────────────────│◀──────────────────────────────│◀──────────────────────────────│
      │                               │                               │                               │
```

## Components

### 1. SDK (`@mentra/sdk`)

**Location**: `MentraOS/cloud/packages/sdk/src/app/session/modules/camera.ts`

The SDK provides `CameraModule` which apps use to request photos from the user's glasses.

```typescript
// App code
const photo = await session.camera.requestPhoto({size: "large"})
const buffer = photo.buffer
```

**Key mechanics**:

- Generates unique `requestId` for each photo request
- Stores pending requests in `pendingPhotoRequests` Map
- Sends `PHOTO_REQUEST` message to Cloud via WebSocket
- Sets 30-second timeout for response
- Receives photo data via HTTP POST to `/photo-upload` endpoint

**File**: `camera.ts` (lines 160-247)

```typescript
const requestId = `photo_req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
this.pendingPhotoRequests.set(requestId, {resolve, reject})

// Send request to cloud
this.session.sendMessage(message)

// Set timeout
this.session.resources.setTimeout(() => {
  if (this.pendingPhotoRequests.has(requestId)) {
    this.pendingPhotoRequests.get(requestId)!.reject("Photo request timed out")
    this.pendingPhotoRequests.delete(requestId)
  }
}, 30000)
```

### 2. Cloud

**Location**: `MentraOS/cloud/packages/cloud/src/services/session/PhotoManager.ts`

The Cloud acts as a message relay between SDK and glasses.

**Key mechanics**:

- Receives `PHOTO_REQUEST` from SDK
- Constructs `webhookUrl` for photo upload (app's public URL + `/photo-upload`)
- Forwards request to glasses via Mobile app WebSocket
- Tracks pending requests

**Message flow**:

```
SDK → Cloud: AppToCloudMessageType.PHOTO_REQUEST
Cloud → Glasses: CloudToGlassesMessageType.PHOTO_REQUEST
Glasses → App: HTTP POST to webhookUrl
```

**File**: `PhotoManager.ts` (lines 61-150)

```typescript
async requestPhoto(appRequest: PhotoRequest): Promise<string> {
  const { packageName, requestId, size } = appRequest;

  // Get webhook URL for this app
  const app = this.userSession.installedApps.get(packageName);
  webhookUrl = app?.publicUrl ? `${app.publicUrl}/photo-upload` : undefined;

  // Forward to glasses
  this.userSession.sendMessageToGlasses({
    type: CloudToGlassesMessageType.PHOTO_REQUEST,
    requestId,
    webhookUrl,
    size,
    // ...
  });
}
```

### 3. Mobile App (asg_client companion)

**Location**: `MentraOS/asg_client/` Android app

The mobile app maintains Bluetooth/serial connection to glasses and forwards commands.

**Key mechanics**:

- Receives `take_photo` command from Cloud via WebSocket
- Forwards to glasses via BLE or serial (K900 protocol)
- Glasses respond directly to webhook (not through mobile)

### 4. ASG Client (Glasses)

**Location**: `MentraOS/asg_client/app/src/main/java/com/mentra/asg_client/`

The glasses run an Android service that handles camera operations.

#### 4.1 Command Processing

**File**: `service/core/handlers/PhotoCommandHandler.java`

```java
// Receives take_photo command
public void handle(JSONObject data) {
    String requestId = data.getString("requestId");
    String webhookUrl = data.getString("webhookUrl");
    String size = data.optString("size", "medium");

    // Trigger camera capture
    MediaCaptureService.captureAndUpload(requestId, webhookUrl, size);
}
```

#### 4.2 Camera Service

**File**: `camera/CameraNeo.java` (3000+ lines)

`CameraNeo` is an Android foreground service that owns the camera lifecycle.

**Key mechanics**:

1. **Photo queue**: Requests are queued in `globalRequestQueue`
2. **Camera keep-alive**: After a photo, camera stays open for 3 seconds for rapid successive shots
3. **AE convergence**: Waits for auto-exposure to converge before capturing
4. **Upload**: Sends JPEG to webhook URL via HTTP POST

**State machine**:

```
IDLE → WAITING_AE → SHOOTING → IDLE
         │
         ▼
   (AE converges, then capture)
```

**Keep-alive timer flow**:

```
Photo completes → Queue empty? → Yes → startKeepAliveTimer(3000ms)
                                        │
                                        ▼ (3 seconds later)
                                   closeCamera() + stopSelf()
```

#### 4.3 Photo Upload

**File**: `io/media/services/MediaCaptureService.java`

After photo is saved to disk, it's uploaded to the app's webhook:

```java
// Upload photo to webhook
HttpURLConnection conn = (HttpURLConnection) new URL(webhookUrl).openConnection();
conn.setRequestMethod("POST");
conn.setDoOutput(true);
conn.setRequestProperty("Content-Type", "image/jpeg");
conn.setRequestProperty("X-Request-ID", requestId);

// Write image bytes
OutputStream os = conn.getOutputStream();
os.write(imageBytes);
```

### 5. SDK Photo Endpoint

**Location**: `MentraOS/cloud/packages/sdk/src/app/server/index.ts`

The SDK automatically creates a `/photo-upload` endpoint that receives photos from glasses.

**File**: `server/index.ts` (photo endpoint setup)

```typescript
// Auto-registered by AppServer
app.post("/photo-upload", async (c) => {
  const requestId = c.req.header("X-Request-ID")
  const body = await c.req.arrayBuffer()

  // Notify CameraModule
  session.camera.handlePhotoReceived({
    requestId,
    buffer: Buffer.from(body),
    success: true,
  })

  return c.json({success: true, requestId})
})
```

## Complete Request Flow

```
Time    Component       Action
─────────────────────────────────────────────────────────────────────────
T+0     SDK             app calls session.camera.requestPhoto()
T+1ms   SDK             generates requestId, stores in pendingPhotoRequests
T+2ms   SDK             sends PHOTO_REQUEST to Cloud via WebSocket
T+5ms   Cloud           receives PHOTO_REQUEST
T+10ms  Cloud           constructs webhookUrl, sends to Mobile via WebSocket
T+50ms  Mobile          receives command, forwards to Glasses via BLE
T+100ms Glasses         CameraNeo receives take_photo command
T+150ms Glasses         Camera opens, AE convergence starts
T+500ms Glasses         AE converges, photo captured
T+600ms Glasses         JPEG saved to disk
T+700ms Glasses         HTTP POST to webhookUrl with image
T+900ms SDK             /photo-upload receives image
T+901ms SDK             handlePhotoReceived() resolves pending promise
T+902ms SDK             app receives PhotoData with buffer
```

## Timeout Logic

The SDK sets a 30-second timeout for each photo request:

```typescript
// camera.ts line 225
const timeoutMs = 30000

this.session.resources.setTimeout(() => {
  if (this.pendingPhotoRequests.has(requestId)) {
    this.pendingPhotoRequests.get(requestId)!.reject("Photo request timed out")
    this.pendingPhotoRequests.delete(requestId)
  }
}, timeoutMs)
```

If the glasses don't upload within 30 seconds, the promise rejects with "Photo request timed out".

## Key Files Reference

| Component         | Path                                                         | Purpose                               |
| ----------------- | ------------------------------------------------------------ | ------------------------------------- |
| SDK Camera        | `sdk/src/app/session/modules/camera.ts`                      | requestPhoto(), handlePhotoReceived() |
| SDK Server        | `sdk/src/app/server/index.ts`                                | /photo-upload endpoint                |
| Cloud Photo       | `cloud/src/services/session/PhotoManager.ts`                 | Request forwarding                    |
| Cloud Handler     | `cloud/src/services/session/handlers/app-message-handler.ts` | Message routing                       |
| ASG Camera        | `asg_client/.../camera/CameraNeo.java`                       | Camera service (3000+ lines)          |
| ASG Photo Handler | `asg_client/.../handlers/PhotoCommandHandler.java`           | Command processing                    |
| ASG Upload        | `asg_client/.../media/services/MediaCaptureService.java`     | HTTP upload logic                     |

## Configuration

| Setting      | Location       | Default  | Description                            |
| ------------ | -------------- | -------- | -------------------------------------- |
| Timeout      | SDK camera.ts  | 30s      | How long SDK waits for photo           |
| Keep-alive   | CameraNeo.java | 3s       | How long camera stays open after photo |
| JPEG quality | CameraNeo.java | 90       | JPEG compression quality               |
| Photo size   | Request option | "medium" | small/medium/large                     |

## Error Scenarios

1. **Camera busy**: Another app is using camera → Request queued, processed when available
2. **Network timeout**: Upload fails → BLE fallback attempted
3. **AE timeout**: AE doesn't converge in 500ms → Capture anyway
4. **Camera error**: Hardware failure → onPhotoError callback with message
 callback with message
