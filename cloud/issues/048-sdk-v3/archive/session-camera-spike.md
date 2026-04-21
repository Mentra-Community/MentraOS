# Spike: Camera System — SDK v3

**Issue:** 048
**Related:** [SDK v3 spike](./spike.md), [039 API map](../039-sdk-v3-api-surface/v2-v3-api-map.md), [019 photo request architecture](../019-sdk-photo-request-architecture), [022 ASG photo timeout](../022-asg-photo-request-timeout), [038 photo error REST endpoint](../038-photo-error-rest-endpoint), [039 photo dead code cleanup](../039-photo-service-dead-code-cleanup)
**Status:** Spike
**Date:** 2026-03-18

---

## Overview

**What this doc covers:** The full camera system for SDK v3 — photo capture, video recording, streaming (managed + unmanaged), and the protocol support roadmap. Covers current architecture audit, known bugs, the unified v3 API, and design decisions for each subsystem.

**What this doc does NOT cover:** The broader SDK v3 migration plan (see [spike.md](./spike.md)), reconnection architecture (see [reconnection spike](./reconnection-architecture-spike.md)), or on-device local runtime concerns (see [client SDK spike](./client-sdk-spike.md)).

**Key principle:** One `session.camera` surface. The developer shouldn't need to know about managed vs unmanaged streaming, RTMP vs SRT, or where the upload lands. The SDK infers the right codepath from the options the developer passes.

---

## Current Architecture (v2)

### Photos

**SDK:** `CameraModule` — 687 lines
**Cloud:** `PhotoManager` — 330 lines

The photo flow is a multi-hop relay with a weird upload path:

```
SDK sends PhotoRequest
    → Cloud relays to glasses via WebSocket
        → Glasses capture photo
        → Glasses upload via HTTP POST to SDK's /photo-upload endpoint
            → Promise resolves with PhotoData
```

Key details:

- Photo requests live on `AppServer`, not `AppSession` — the upload arrives via an HTTP endpoint on the SDK's Express/Hono server, not over the WebSocket. This is because the glasses upload the photo bytes directly over HTTP rather than pushing them through the cloud's WebSocket relay.
- 30-second timeout is hardcoded.
- Options: `size` (small / medium / large / full), `compress` (none / medium / heavy), `saveToGallery`, `sound`.
- The promise-based API works but has no way to handle passive photo events (e.g., the user presses the hardware capture button on the glasses — the SDK never hears about it).

### Unmanaged Streaming

**SDK:** `CameraModule` (shared with photos)
**Cloud:** `UnmanagedStreamingExtension` — 665 lines

The developer provides an RTMP URL. The SDK sends it to the cloud, the cloud relays it to the glasses, and the glasses stream directly to the RTMP destination. The cloud is a passthrough — it doesn't touch the video data.

- Status monitoring via `onStreamStatus` callback.
- No cloud-side state beyond relay — if the glasses disconnect, the stream just dies.

### Managed Streaming

**SDK:** `CameraManagedExtension` — 452 lines
**Cloud:** `ManagedStreamingExtension` (1328 lines) + `CloudflareStreamService` (997 lines) + `StreamRegistry` (486 lines)

The cloud handles everything through Cloudflare Stream:

1. Cloud provisions a Cloudflare Stream live input.
2. Cloud sends the RTMP ingest URL to the glasses (via relay).
3. Glasses stream to Cloudflare.
4. Cloud returns HLS / DASH / WebRTC viewing URLs to the SDK.
5. Supports re-streaming to multiple destinations (YouTube, Twitch, etc.) via Cloudflare's output configuration.
6. Already has an `enableWebRTC` option on the Cloudflare side.

The managed system is significantly more complex — `StreamRegistry` tracks active streams, `CloudflareStreamService` manages the Cloudflare API lifecycle, and the extension coordinates the whole flow. But from the developer's perspective, it's just "start stream, get URLs."

---

## Bugs & Issues

| #   | Issue                                           | Impact                                                                                                                   | Root Cause                                                                                                                                 |
| --- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Camera busy errors don't propagate reliably** | SDK promise hangs for 30s instead of rejecting immediately when the camera is in use                                     | Glasses send a "busy" response, but the cloud doesn't always relay it back to the SDK. The error path was never properly wired end-to-end. |
| 2   | **Two separate streaming APIs**                 | `startStream` vs `startManagedStream` is confusing — developers don't know which to use                                  | Managed streaming was bolted on after unmanaged, got its own method instead of being unified                                               |
| 3   | **No video recording**                          | Developers can only capture stills or stream — there's no way to record a clip and get a file back                       | Never built. Needs ASG client-side work to support record-to-file and upload.                                                              |
| 4   | **"RTMP" baked into type names**                | Types like `RtmpStreamConfig`, `RtmpStreamStatus` assume RTMP — can't add SRT without renaming or duplicating everything | Protocol was hardcoded into the type system from day one                                                                                   |
| 5   | **No passive photo event**                      | If the user presses the hardware button on the glasses, the SDK has no way to receive that photo                         | The SDK only handles photos it explicitly requested via `takePhoto()`                                                                      |
| 6   | **30s timeout hardcoded**                       | No way to adjust for slow networks or large photo sizes                                                                  | Literal `30000` in the code, not configurable                                                                                              |
| 7   | **WebRTC partially implemented**                | Cloudflare side has `enableWebRTC` but there's no SDK surface for real-time video calls                                  | Was added to Cloudflare config but never exposed in the SDK API                                                                            |

---

## Proposed v3 API

### `session.camera`

```typescript
// ─── Photo capture ──────────────────────────────
session.camera.takePhoto(opts?: PhotoOptions)          // → Promise<PhotoData>
session.camera.onPhotoTaken(handler: PhotoHandler)     // passive — hardware button, etc.

// ─── Video recording (future — needs ASG client work) ───
session.camera.startRecording(opts?: RecordingOptions)         // → Promise<void>
session.camera.stopRecording()                                 // → Promise<RecordingStopResult>
session.camera.onRecordingStatus(handler: RecordingStatusHandler) // recording lifecycle events

// ─── Streaming (unified) ────────────────────────
session.camera.startStream(opts?: StreamOptions)       // → Promise<StreamInfo>
session.camera.stopStream()                            // → Promise<void>
session.camera.getStreamStatus()                       // → StreamStatus
session.camera.onStreamStatus(handler: StatusHandler)  // status changes

// ─── Permissions ────────────────────────────────
session.camera.hasPermission                           // → boolean
```

### Type Definitions

```typescript
interface PhotoOptions {
  size?: "small" | "medium" | "large" | "full"; // default: 'medium'
  compression?: "none" | "medium" | "heavy"; // default: 'medium'
  saveToGallery?: boolean; // default: false
  sound?: boolean; // default: true
  timeout?: number; // ms, default: 30000
}

interface PhotoData {
  url: string;
  width: number;
  height: number;
  timestamp: number;
  savedToGallery: boolean;
}

interface RecordingOptions {
  maxDuration?: number; // ms, default: 300000 (5 min)
  quality?: "low" | "medium" | "high";
}

/**
 * Returned immediately when stopRecording() is called.
 * The video may NOT be available yet — it could be queued for upload
 * if the glasses aren't on WiFi. Use onRecordingStatus() to track
 * when the video URL becomes available.
 */
interface RecordingStopResult {
  recordingId: string; // unique ID for this recording
  duration: number; // ms — how long the recording was
  uploadStatus: RecordingUploadStatus; // current upload state
  url?: string; // presigned URL — only present if already uploaded
  expiresAt?: number; // unix timestamp — only present if url is present
}

type RecordingUploadStatus =
  | "uploading" // glasses are on WiFi, upload in progress right now
  | "queued" // glasses are NOT on WiFi, will upload when WiFi available
  | "available" // upload complete, url is populated
  | "failed"; // upload failed (storage full, network error, etc.)

/**
 * Fired throughout the recording lifecycle — during recording (duration updates),
 * on stop, and crucially when the upload completes (which may be much later
 * if the glasses weren't on WiFi when recording stopped).
 */
interface RecordingStatusEvent {
  recordingId: string;
  status: RecordingStatus;
  duration?: number; // ms — updated during recording and on stop
  uploadStatus?: RecordingUploadStatus; // present once recording stops
  url?: string; // presigned URL — only present when uploadStatus is "available"
  size?: number; // bytes — only present when uploadStatus is "available"
  expiresAt?: number; // unix timestamp — only present when url is present
  error?: string; // present when status is "error" or uploadStatus is "failed"
}

type RecordingStatus =
  | "recording" // actively recording
  | "stopping" // stop requested, glasses finishing up
  | "stopped" // recording stopped, upload lifecycle begins
  | "error"; // recording failed (camera busy, storage full, etc.)

type RecordingStatusHandler = (event: RecordingStatusEvent) => void;

interface StreamOptions {
  url?: string; // RTMP or SRT URL — omit for managed
  destinations?: StreamDestination[]; // re-stream targets (managed only)
}

interface StreamDestination {
  name: string;
  url: string; // e.g., rtmp://a.rtmp.youtube.com/live2/xxxx
}

interface StreamInfo {
  // Only present for managed streams (no url passed):
  hls?: string;
  dash?: string;
  webrtc?: string;
  // Always present:
  status: StreamStatus;
}

type StreamStatus = "starting" | "live" | "stopping" | "stopped" | "error";

interface CameraError {
  code: CameraErrorCode;
  message: string;
}

type CameraErrorCode =
  | "CAMERA_BUSY"
  | "CAMERA_NOT_AVAILABLE"
  | "TIMEOUT"
  | "PERMISSION_DENIED"
  | "STREAM_FAILED"
  | "RECORDING_FAILED"
  | "RECORDING_STORAGE_FULL"
  | "RECORDING_UPLOAD_FAILED";
```

### The Managed vs Unmanaged Decision

The developer never says "managed" or "unmanaged." The SDK infers it:

| What the developer passes              | What happens                                    |
| -------------------------------------- | ----------------------------------------------- |
| `startStream()` — no options           | Managed. Cloud provisions Cloudflare Stream.    |
| `startStream({ destinations: [...] })` | Managed + re-streaming to those destinations.   |
| `startStream({ url: 'rtmp://...' })`   | Unmanaged RTMP. Glasses stream directly to URL. |
| `startStream({ url: 'srt://...' })`    | Unmanaged SRT. Glasses stream directly to URL.  |

This eliminates the `startStream` / `startManagedStream` split. One method, behavior determined by options.

---

## Design: Streaming Unification

### Cloud Side

Today the cloud has two extensions:

- `UnmanagedStreamingExtension` (665 lines) — relay URL to glasses, monitor status
- `ManagedStreamingExtension` (1328 lines) — Cloudflare lifecycle, stream registry, re-streaming

In v3, these become a single `StreamingManager` on the cloud side:

```
SDK sends startStream(opts)
    → Cloud StreamingManager inspects opts
        → Has url?
            → Yes: detect protocol from scheme, relay to glasses (unmanaged path)
            → No: provision Cloudflare Stream, send ingest URL to glasses (managed path)
    → Return StreamInfo to SDK
```

The `CloudflareStreamService` and `StreamRegistry` stay as internal implementation details of the managed path — they don't change. What changes is the entry point: one method on `StreamingManager` instead of two separate extensions.

### SDK Side

The SDK's `CameraModule` currently mixes photo logic and streaming logic in 687 lines. In v3:

- `CameraManager` is the unified surface (`session.camera`).
- Internally it delegates to `PhotoService` and `StreamService`.
- `StreamService` sends the same wire messages as today — the cloud-side protocol doesn't change. The only difference is that the SDK decides unmanaged vs managed based on the presence of `opts.url` before sending the message.

### Wire Protocol

No wire protocol changes needed. The existing messages (`START_STREAM`, `START_MANAGED_STREAM`, `STOP_STREAM`, `STREAM_STATUS`) stay the same. The SDK maps the unified `startStream()` call to the correct wire message internally. v2 SDKs continue to work because the cloud still accepts both message types.

---

## Design: Camera Busy Errors

### The Problem

Today when the glasses camera is busy (e.g., already streaming), the glasses send a "busy" response to the cloud. But the cloud doesn't reliably relay this back to the SDK. The SDK's promise sits there for 30 seconds until timeout, then rejects with a generic timeout error instead of a specific `CAMERA_BUSY` error.

### The Fix

End-to-end error path:

```
Glasses report "camera busy"
    → Cloud receives error response
    → Cloud relays CameraError to SDK via WebSocket
    → SDK rejects the pending promise with typed CameraError
```

The cloud needs a dedicated error relay path. When the glasses respond with an error to any camera command (photo, stream start, recording start), the cloud wraps it in a `CAMERA_ERROR` message:

```typescript
// Cloud → SDK
{
  type: 'CAMERA_ERROR',
  requestId: string,    // correlates to the original request
  error: {
    code: CameraErrorCode,
    message: string
  }
}
```

The SDK matches `requestId` to the pending promise and rejects it with the typed error. If no matching promise is found (e.g., the request already timed out), the error is logged and dropped.

### Error Types

| Code                   | When                                                    | Source        |
| ---------------------- | ------------------------------------------------------- | ------------- |
| `CAMERA_BUSY`          | Camera already in use (streaming, recording, capturing) | Glasses       |
| `CAMERA_NOT_AVAILABLE` | No camera hardware or camera disabled                   | Glasses       |
| `TIMEOUT`              | No response within timeout period                       | SDK (local)   |
| `PERMISSION_DENIED`    | App doesn't have camera permission                      | Cloud         |
| `STREAM_FAILED`        | Stream start or mid-stream failure                      | Cloud/Glasses |
| `RECORDING_FAILED`     | Recording start or mid-recording failure                | Cloud/Glasses |

### requestId Correlation

Every camera command from the SDK includes a `requestId` (UUID). The cloud passes it through to the glasses and back. This is the correlation key for matching responses (success or error) to pending promises. Today, photo requests have an implicit correlation (there's only one pending photo request at a time). In v3, the explicit `requestId` supports concurrent operations (e.g., streaming while taking a photo).

---

## Design: Video Recording (Future)

> **⚠️ Requires ASG client changes.** The glasses firmware does not currently support record-to-file + upload. This design assumes that capability will be added.
>
> **Implementation note:** In the SDK v3 release, the recording API types and method signatures will be defined but the implementations will be commented out or throw "not yet supported" errors. This prevents developers from seeing API surface for features that don't work yet, while keeping the design ready for when ASG support lands.

### Flow

```
SDK calls startRecording(opts)
    → Cloud relays to glasses
    → Glasses start recording locally to internal storage
    → onRecordingStatus fires: { status: "recording", duration: 0 }
    → onRecordingStatus fires periodically: { status: "recording", duration: 5000 }
    → ...

SDK calls stopRecording()
    → Cloud relays stop to glasses
    → Glasses finish recording

    ─── CASE A: Glasses are on WiFi ───
    → Glasses start uploading immediately
    → stopRecording() resolves: { recordingId, duration, uploadStatus: "uploading" }
    → onRecordingStatus fires: { status: "stopped", uploadStatus: "uploading" }
    → Glasses upload file to cloud storage (R2) via HTTP PUT
    → Cloud generates presigned URL with TTL
    → onRecordingStatus fires: { status: "stopped", uploadStatus: "available", url: "https://...", size, expiresAt }

    ─── CASE B: Glasses are NOT on WiFi ───
    → Glasses queue the recording for later upload
    → stopRecording() resolves: { recordingId, duration, uploadStatus: "queued" }
    → onRecordingStatus fires: { status: "stopped", uploadStatus: "queued" }
    → ... time passes, glasses connect to WiFi ...
    → Glasses start uploading
    → onRecordingStatus fires: { status: "stopped", uploadStatus: "uploading" }
    → Upload completes
    → onRecordingStatus fires: { status: "stopped", uploadStatus: "available", url: "https://...", size, expiresAt }
```

**Key insight:** `stopRecording()` resolves immediately with what's known at stop time — the duration and whether the upload is happening now or queued. The video URL arrives later via `onRecordingStatus()`. Developers must listen for the `"available"` upload status to get the URL.

### Recording Status Lifecycle

```
┌──────────────────────────────────────────────────────────────────┐
│ startRecording()                                                  │
│     ↓                                                             │
│  "recording" ──→ "recording" ──→ "recording"    (periodic updates)│
│     ↓                                                             │
│ stopRecording()                                                   │
│     ↓                                                             │
│  "stopped" + uploadStatus: "uploading"  ──→  "available" (+ url)  │
│        or                                                         │
│  "stopped" + uploadStatus: "queued" ──→ "uploading" ──→ "available│
│        or                                                         │
│  "stopped" + uploadStatus: "failed" (+ error)                     │
│                                                                   │
│ At any point:                                                     │
│  "error" (camera busy, storage full, etc.)                        │
└──────────────────────────────────────────────────────────────────┘
```

### Usage Example

```typescript
// Listen for recording status BEFORE starting
session.camera.onRecordingStatus((event) => {
  switch (event.uploadStatus) {
    case "queued":
      session.display.showText("Video saved. Will upload on WiFi.");
      break;
    case "uploading":
      session.display.showText("Uploading video...");
      break;
    case "available":
      console.log("Video ready:", event.url);
      // Download, process, store permanently on your server, etc.
      break;
    case "failed":
      console.error("Upload failed:", event.error);
      break;
  }
});

// Start recording
await session.camera.startRecording({ maxDuration: 30000 });

// ... user does stuff ...

// Stop — resolves immediately, URL comes later via onRecordingStatus
const result = await session.camera.stopRecording();
console.log(`Recorded ${result.duration}ms, upload: ${result.uploadStatus}`);
```

### Cloud Storage

- Recordings upload to R2 (Cloudflare's S3-compatible storage — already used by Cloudflare Stream in the managed streaming path).
- Cloud generates a presigned URL with a configurable TTL.
- Auto-deletion after expiry. Default: 24 hours. Configurable per-app or per-request TBD.
- The SDK never sees the R2 bucket directly — only the presigned URL.

### Size & Duration Limits

- `maxDuration` defaults to 5 minutes. Hardcap TBD (depends on glasses storage + battery).
- Quality settings map to glasses-side encoding presets. The SDK sends `low` / `medium` / `high`, the glasses decide resolution and bitrate.
- If glasses storage fills up mid-recording: glasses send an error → cloud relays → `onRecordingStatus` fires with `status: "error"`, `error: "RECORDING_STORAGE_FULL"`.

### Upload Path

Same pattern as photos: the glasses upload the file via HTTP, not through the WebSocket relay. The cloud provides an upload URL when recording starts:

```
Cloud sends to glasses: { recordingId, uploadUrl, maxDuration }
Glasses record locally
Glasses finish recording
If WiFi available → HTTP PUT to uploadUrl immediately
If no WiFi → queue, upload when WiFi connects
Cloud detects upload complete → sends RECORDING_STATUS to SDK via WebSocket
```

This avoids pushing large video files through the WebSocket and matches the existing photo upload pattern.

### Deferred Upload Behavior

The "queued for upload" state is important for real-world usage. Users may record a video while out walking (no WiFi), and the upload happens hours later when they return to WiFi. The `onRecordingStatus` handler fires whenever the upload status changes — even if the recording happened a long time ago. The `recordingId` correlates which recording the status belongs to.

If the app server restarts between recording and upload completion, the status event will arrive via the next `onSession`. The developer should persist the `recordingId` in `session.storage` if they need to track it across restarts.

---

## Design: Passive Photo Events (`onPhotoTaken`)

Today, the SDK only handles photos it explicitly requests. If the user presses a hardware button on the glasses or another app triggers a capture, the SDK has no idea.

v3 adds `session.camera.onPhotoTaken(handler)`:

- The cloud subscribes to photo events on the glasses.
- When a photo is captured by any means (hardware button, another app, system), the cloud sends a `PHOTO_TAKEN` event to all connected apps with camera permission.
- The handler receives the same `PhotoData` as `takePhoto()`.

This is a subscription-based event (like `onStreamStatus`), not a request-response. The cleanup function pattern matches other v3 managers:

```typescript
const stop = session.camera.onPhotoTaken((photo) => {
  console.log("Photo captured:", photo.url);
});

// Later:
stop(); // unsubscribe
```

---

## Protocol Support

### Current & Planned

| Protocol | Direction      | Status                            | How it works                                                         | Needs ASG changes?  |
| -------- | -------------- | --------------------------------- | -------------------------------------------------------------------- | ------------------- |
| RTMP     | Glasses → dest | ✅ Shipped (v2)                   | Glasses push RTMP to destination (unmanaged) or Cloudflare (managed) | No                  |
| HLS      | Viewer ← cloud | ✅ Shipped (v2)                   | Cloudflare Stream generates HLS URL from ingested RTMP               | No                  |
| DASH     | Viewer ← cloud | ✅ Shipped (v2)                   | Cloudflare Stream generates DASH URL from ingested RTMP              | No                  |
| WebRTC   | Viewer ← cloud | ⚠️ Partial (Cloudflare side only) | Cloudflare Stream has WebRTC playback. No SDK surface yet            | No (cloud/SDK only) |
| SRT      | Glasses → dest | 🔮 Future                         | Same as RTMP but with `srt://` URL scheme                            | **Yes**             |
| WebRTC   | Bidirectional  | 🔮 Future                         | Real-time video calls — different enough for its own API             | **Yes**             |

### SRT Support

SRT is the same pattern as RTMP unmanaged streaming — the developer passes a URL, the glasses stream directly. The SDK detects the protocol from the URL scheme:

```typescript
// SDK internal logic:
function detectProtocol(url: string): "rtmp" | "srt" {
  if (url.startsWith("srt://")) return "srt";
  if (url.startsWith("rtmp://") || url.startsWith("rtmps://")) return "rtmp";
  throw new CameraError("STREAM_FAILED", `Unsupported URL scheme: ${url}`);
}
```

The cloud passes the protocol to the glasses, and the glasses use the appropriate encoder/sender. **This requires ASG client firmware to support SRT output** — the SDK and cloud changes are trivial once the glasses can do it.

### WebRTC Real-Time Video (Future)

WebRTC for real-time bidirectional video (video calls) is architecturally different from streaming:

- Streaming is one-way: glasses → viewers.
- WebRTC calls are two-way: glasses ↔ remote peer.
- Requires signaling, ICE negotiation, TURN servers.
- Different enough to warrant its own API rather than overloading `startStream()`.

Proposed future API (not part of v3.0):

```typescript
session.camera.startCall(opts?: CallOptions)   // → Promise<CallSession>
session.camera.stopCall()                      // → Promise<void>
```

This is out of scope for the initial v3 camera work. WebRTC _playback_ of managed streams (viewers watching via WebRTC instead of HLS) already works through Cloudflare and is exposed via the `webrtc` field in `StreamInfo`.

---

## What Changes Where

### SDK

| File / Module                        | Change                                                                       |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| `CameraModule` (687 lines)           | Replace with `CameraManager` — unified surface, delegates to sub-services    |
| `CameraManagedExtension` (452 lines) | Fold into `StreamService` (internal to `CameraManager`)                      |
| New: `PhotoService`                  | Handles `takePhoto`, `onPhotoTaken`, photo upload endpoint                   |
| New: `StreamService`                 | Handles `startStream`, `stopStream`, status — routes to managed or unmanaged |
| New: `RecordingService`              | Handles `startRecording`, `stopRecording` — stubbed until ASG support        |

### Cloud

| File / Module                             | Change                                                 |
| ----------------------------------------- | ------------------------------------------------------ |
| `PhotoManager` (330 lines)                | Add `CAMERA_ERROR` relay path, `requestId` correlation |
| `UnmanagedStreamingExtension` (665 lines) | Merge into `StreamingManager`                          |
| `ManagedStreamingExtension` (1328 lines)  | Merge into `StreamingManager`                          |
| `CloudflareStreamService` (997 lines)     | No changes — internal to managed path                  |
| `StreamRegistry` (486 lines)              | No changes — internal to managed path                  |
| New: `StreamingManager`                   | Unified entry point, replaces the two extensions       |

### Wire Protocol

| Message                  | Change                                                             |
| ------------------------ | ------------------------------------------------------------------ |
| `TAKE_PHOTO`             | Add `requestId` field                                              |
| `PHOTO_RESULT`           | Add `requestId` field                                              |
| `CAMERA_ERROR` (new)     | Error relay from glasses/cloud to SDK with `requestId` correlation |
| `PHOTO_TAKEN` (new)      | Passive photo event — broadcast to subscribed apps                 |
| `START_STREAM`           | No change (unmanaged path)                                         |
| `START_MANAGED_STREAM`   | No change (managed path)                                           |
| `STOP_STREAM`            | No change                                                          |
| `STREAM_STATUS`          | No change                                                          |
| `START_RECORDING` (new)  | Future — when ASG supports it                                      |
| `STOP_RECORDING` (new)   | Future — when ASG supports it                                      |
| `RECORDING_RESULT` (new) | Future — presigned URL + metadata                                  |

---

## Open Questions

| #   | Question                                                                 | Notes                                                                                                                                                                                                       |
| --- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Recording TTL — 24h default? Configurable per-app?**                   | R2 storage costs money. 24h is generous for debugging but short for production use. Could offer a plan-based limit (free tier: 1h, paid: 7d). Or just let the developer set it in `RecordingOptions`.       |
| 2   | **Recording max file size?**                                             | Glasses have limited storage. Need to know ASG storage constraints before picking defaults. Also affects upload time on slow networks.                                                                      |
| 3   | **Passive photo events — all apps or only apps with camera permission?** | Leaning toward permission-gated: only apps that have declared camera permission in their manifest receive `onPhotoTaken` events. Otherwise it's a privacy leak.                                             |
| 4   | **Should `startStream()` reject if already streaming?**                  | Current v2 behavior is undefined. v3 should probably reject with `CAMERA_BUSY` if there's already an active stream. But what about switching from one stream to another — stop + start, or allow hot-swap?  |
| 5   | **SRT timeline — when does ASG client get SRT support?**                 | Need firmware team input. The SDK/cloud work is trivial (URL scheme detection + new wire message field). The blocker is entirely on the glasses side.                                                       |
| 6   | **Photo upload path — keep HTTP or move to WebSocket?**                  | HTTP upload works and is proven. WebSocket would simplify the architecture (no separate HTTP endpoint needed). But binary frames over WS are annoying and photos can be large. Leaning toward keeping HTTP. |
| 7   | **`requestId` — UUID v4 or something shorter?**                          | UUID v4 is fine for correctness. But these go over the wire to the glasses, and the glasses relay them back. If the glasses have tight message size constraints, a shorter ID (nanoid) might be better.     |
| 8   | **WebRTC playback — expose in v3.0 or wait?**                            | Cloudflare already generates WebRTC URLs for managed streams. We could include the `webrtc` field in `StreamInfo` in v3.0 with no extra work. Just needs testing.                                           |
| 9   | **Managed stream without Cloudflare — self-hosted option?**              | Some enterprise customers may not want video going through Cloudflare. Could we support a self-hosted RTMP ingest + HLS origin? Way out of scope for v3.0, but worth noting for the roadmap.                |
| 10  | **Concurrent operations — can you stream AND take a photo?**             | Depends on glasses hardware. If the camera can't do both, the glasses will respond with `CAMERA_BUSY`. The SDK should handle this gracefully. Need to verify actual glasses behavior.                       |
