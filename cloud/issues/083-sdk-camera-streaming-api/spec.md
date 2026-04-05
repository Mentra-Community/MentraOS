# Spec: Unified Camera Streaming API

## Overview

**What this doc covers:** Redesigning the v3 CameraManager streaming API to have one method (`startStream`) with clear modes: managed relay (default), relay + restream destinations, and direct streaming.
**Why this doc exists:** The current v3 CameraManager has a broken streaming implementation (sends `rtmpUrl` instead of `streamUrl` on the wire), uses RTMP-only naming despite SRT/WHIP support, and has confusing method names (`startStream` vs `startManagedStream`) that don't match the v2 API the SRT developer built against.
**Who should read this:** SDK developers, anyone building streaming apps.

## Current State (Before)

### v2 SDK — CameraModule (on dev, what the SRT developer built)

**File:** `cloud/packages/sdk/src/app/session/modules/camera.ts`

The v2 CameraModule has two clean APIs with proper SRT/RTMP/WHIP support:

```typescript
// Direct stream — glasses connect straight to your URL
// Supports rtmp://, rtmps://, srt://, https:// (WHIP)
interface StreamOptions {
  streamUrl: string;        // <-- generic, supports all protocols
  video?: VideoConfig;
  audio?: AudioConfig;
  stream?: StreamConfig;
  sound?: boolean;
}

await session.camera.startLocalLivestream({
  streamUrl: "srt://192.168.1.100:4201?streamid=my-stream",
});
await session.camera.stopLocalLivestream();
session.camera.onLocalLivestreamStatus((status) => { ... });

// Managed stream — glasses stream to cloud relay, cloud distributes
interface ManagedStreamOptions {
  quality?: "720p" | "1080p";
  enableWebRTC?: boolean;
  video?: VideoConfig;
  audio?: AudioConfig;
  restreamDestinations?: RestreamDestination[];
  sound?: boolean;
}

const urls = await session.camera.startLivestream({
  quality: "1080p",
  restreamDestinations: [{ url: "rtmp://youtube.com/live/key" }],
});
// Returns { hlsUrl, dashUrl, webrtcUrl, streamId }
await session.camera.stopLivestream();
session.camera.onLivestreamStatus((status) => { ... });
```

The v2 module sends the correct wire message:

```typescript
const message: StreamRequest = {
  type: AppToCloudMessageType.STREAM_REQUEST,
  packageName: this.packageName,
  sessionId: this.sessionId,
  streamUrl: options.streamUrl,  // <-- correct field name
  video: options.video,
  audio: options.audio,
  stream: options.stream,
  sound: options.sound,
  timestamp: new Date(),
};
```

### v3 SDK — CameraManager (on this branch, what we designed before SRT)

**File:** `cloud/packages/sdk/src/session/managers/CameraManager.ts`

The v3 CameraManager was written before SRT support existed. It has RTMP-only naming and a broken wire message:

```typescript
// Direct stream — RTMP only, wrong field name
interface RtmpStreamOptions {
  rtmpUrl: string;          // <-- RTMP-only, should be streamUrl
  video?: VideoConfig;
  audio?: AudioConfig;
  stream?: StreamConfig;
  sound?: boolean;
}

await session.camera.startStream({ rtmpUrl: "rtmp://..." });
await session.camera.stopStream();
session.camera.onStreamStatus((status) => { ... });

// Managed stream — separate method, different naming from v2
await session.camera.startManagedStream({ quality: "1080p" });
await session.camera.stopManagedStream();
session.camera.onManagedStreamStatus((status) => { ... });
```

The v3 manager sends the WRONG wire message:

```typescript
this.deps.sendMessage({
  type: AppToCloudMessageType.STREAM_REQUEST,
  packageName: this.deps.getPackageName(),
  sessionId: this.deps.getSessionId(),
  rtmpUrl: options.rtmpUrl,  // <-- BUG: wrong field name, should be streamUrl
  video: options.video,
  ...
});
```

### Cloud — App Message Handler

**File:** `cloud/packages/cloud/src/services/session/handlers/app-message-handler.ts`

The cloud has a normalizer that papers over the v3 bug:

```typescript
// Line 398-403
function normalizeStreamRequest(message: any): StreamRequest {
  if (!message.streamUrl && message.rtmpUrl) {
    message.streamUrl = message.rtmpUrl;   // fallback: copies rtmpUrl → streamUrl
  }
  return message as StreamRequest;
}
```

This means the v3 bug doesn't cause a runtime failure (the cloud fixes it), but it's still wrong.

### Cloud — UnmanagedStreamingExtension

**File:** `cloud/packages/cloud/src/services/session/UnmanagedStreamingExtension.ts`

Reads `streamUrl` from the (normalized) request, validates it, then sends `START_STREAM` to the glasses:

```typescript
const { packageName, streamUrl, video, audio, stream: streamOptions, sound: appSound } = request;

// ... validation ...

const startMessage: StartStream = {
  type: CloudToGlassesMessageType.START_STREAM,
  sessionId: this.userSession.sessionId,
  streamUrl,          // <-- sent to glasses as streamUrl
  appId: packageName,
  streamId,
  video: video || {},
  audio: audio || {},
  stream: streamOptions || {},
  flash,
  sound,
  timestamp: now,
};
```

### Wire Protocol — StreamRequest

**File:** `cloud/packages/sdk/src/types/messages/app-to-cloud.ts`

The wire protocol already uses `streamUrl` (not `rtmpUrl`):

```typescript
export interface StreamRequest extends BaseMessage {
  type: AppToCloudMessageType.STREAM_REQUEST;
  packageName: string;
  streamUrl: string;    // <-- the correct field name
  video?: VideoConfig;
  audio?: AudioConfig;
  stream?: StreamConfig;
  sound?: boolean;
}
```

---

## The Problem in 30 Seconds

The v3 CameraManager was designed before SRT streaming was implemented. It has three problems:

1. **Bug:** `startStream()` sends `rtmpUrl` in the message but the wire protocol expects `streamUrl`. The stream URL never reaches the glasses.
2. **RTMP-only naming:** `RtmpStreamOptions` with `rtmpUrl` field, despite SRT and WHIP now being supported.
3. **Confusing split:** `startStream` (direct) vs `startManagedStream` (relay) are two separate methods with unclear naming. Developers don't know which to use.

Meanwhile, the v2 CameraModule was properly updated for SRT with `startLocalLivestream({ streamUrl })` and `startLivestream()`, but the v3 CameraManager wasn't updated to match.

## Spec

### One method: `session.camera.startStream()`

```typescript
// Default — stream through the MentraOS cloud relay
// Best for most apps. Handles quality normalization, reconnection, multi-region.
const stream = await session.camera.startStream();
// Returns { hlsUrl, dashUrl, webrtcUrl, streamId }

// Stream through relay AND restream to external services
const stream = await session.camera.startStream({
  destinations: ["rtmp://youtube.com/live/your-key", "rtmp://twitch.tv/live/your-key"],
});
// Returns { hlsUrl, dashUrl, webrtcUrl, streamId }

// With quality options
const stream = await session.camera.startStream({
  quality: "1080p",
  destinations: ["rtmp://youtube.com/live/your-key"],
});

// Direct stream — glasses connect straight to this URL, no relay
// Only for developers who have their own infrastructure
await session.camera.startStream({
  direct: "srt://192.168.1.100:4201",
});
// Returns void (no viewer URLs, you handle everything)
```

### Interface

```typescript
interface StreamOptions {
  /** Direct stream URL. Glasses connect to this URL directly, bypassing the cloud relay.
   *  Supports srt://, rtmp://, rtmps://, and https:// (WHIP) protocols.
   *  When set, the cloud relay is not used. No hlsUrl/dashUrl/webrtcUrl returned.
   *  Most apps should NOT use this — use the default managed relay instead. */
  direct?: string;

  /** Restream destinations. The cloud relay fans out to these URLs.
   *  Only works with managed streaming (when `direct` is not set).
   *  Each URL is an RTMP or SRT ingest endpoint (YouTube, Twitch, etc.) */
  destinations?: string[];

  /** Stream quality. Only applies to managed streaming. */
  quality?: "720p" | "1080p";

  /** Enable WebRTC playback URL. Only applies to managed streaming. Default: true. */
  enableWebRTC?: boolean;

  /** Video configuration (resolution, bitrate, fps) */
  video?: VideoConfig;

  /** Audio configuration (bitrate, sample rate) */
  audio?: AudioConfig;

  /** Controls stream start/stop sounds on the glasses. Default: true. */
  sound?: boolean;
}

interface StreamResult {
  hlsUrl: string;
  dashUrl: string;
  webrtcUrl?: string;
  previewUrl?: string;
  thumbnailUrl?: string;
  streamId: string;
}
```

### Return type

```typescript
// Managed (no `direct`): returns StreamResult
const result: StreamResult = await session.camera.startStream();
const result: StreamResult = await session.camera.startStream({ destinations: [...] });

// Direct (with `direct`): returns void
await session.camera.startStream({ direct: "srt://..." });
```

The return type depends on the mode. TypeScript overloads handle this:

```typescript
startStream(): Promise<StreamResult>;
startStream(options: { direct: string }): Promise<void>;
startStream(options: StreamOptions): Promise<StreamResult>;
```

### Other methods (unchanged shape, renamed)

```typescript
// Stop any active stream (managed or direct)
await session.camera.stopStream();

// Monitor stream status
const cleanup = session.camera.onStreamStatus((status) => {
  console.log(status.status); // "connected" | "disconnected" | "error"
});
```

### Wire protocol fix

The `STREAM_REQUEST` message must send `streamUrl` (not `rtmpUrl`):

```typescript
// Before (broken):
this.deps.sendMessage({
  type: AppToCloudMessageType.STREAM_REQUEST,
  rtmpUrl: options.rtmpUrl,  // wrong field name
  ...
});

// After (fixed):
this.deps.sendMessage({
  type: AppToCloudMessageType.STREAM_REQUEST,
  streamUrl: options.direct,
  ...
});
```

The `StreamRequest` interface in `types/messages/app-to-cloud.ts` already uses `streamUrl`. The CameraManager just needs to send the right field.

## Why managed relay should be the default

The MentraOS cloud relay provides:

- **Quality normalization.** Upstream services (YouTube, Twitch) reject streams with wrong quality/codec settings. The relay re-encodes so it just works.
- **Reconnection handling.** If the glasses have a brief network blip, the relay maintains the outbound stream. Direct streaming would drop.
- **Multi-region servers.** Glasses connect to the nearest relay. Lower latency than connecting directly to a remote RTMP ingest.
- **Multiple viewer URLs.** HLS, DASH, WebRTC all from one stream. Direct streaming gives you nothing.
- **Fan-out to multiple destinations.** One stream from the glasses, relay sends to YouTube + Twitch + your server simultaneously.

Direct streaming is for: local recording, custom infrastructure, testing, or cases where you need the absolute lowest latency and accept the tradeoffs.

## Decision Log

| Decision | Alternatives considered | Why we chose this |
|----------|------------------------|-------------------|
| One method with modes (via options) | Two separate methods (`startStream` + `startDirectStream`) | One method is simpler to discover. The `direct` field makes the opt-in explicit. Developers won't accidentally use the wrong method. |
| `direct` field name | `url`, `streamUrl`, `target`, `endpoint` | `direct` communicates that you're bypassing the relay. `url` or `streamUrl` could be confused with a destination URL for the relay. |
| `destinations` for restream targets | `restreamUrls`, `fanout`, `targets` | `destinations` is the clearest. "Where do you want the stream to go?" |
| Default = managed relay | Default = direct | Most developers want the easiest path. Managed relay is easier, more reliable, and provides viewer URLs. Direct requires your own infrastructure. |