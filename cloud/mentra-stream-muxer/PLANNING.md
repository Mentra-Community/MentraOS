# Mentra Streaming - Planning Document

## Two-Phase Approach

Mentra's video streaming serves two distinct use cases:

1. **Livestreaming to social platforms** (Twitch, YouTube, etc.) — needs reliability, not sub-second latency
2. **Low-latency streaming from Mentra Live to miniapps** — needs sub-second latency for real-time processing

These are addressed in two phases:

- **Phase 1**: Fix livestreaming reliability (SRT replaces RTMP) + add WebRTC streaming for miniapps. Uses Cloudflare for both. No new infrastructure.
- **Phase 2**: Self-hosted Mentra Stream Muxer for full control, cloud-agnostic deployment, China support, and advanced features (fallback frames, re-encoding, etc.)

---

## Phase 1: Reliable Livestreaming + WebRTC for Miniapps

### Motivation

The current livestreamer app sends RTMP directly from the Mentra Live glasses to Cloudflare over the glasses' Wi-Fi chip. This is unreliable because:

- **RTMP is TCP-based** — any packet loss causes stalls and buffering
- **Mentra Live's Wi-Fi chip is garbage** — frequent dropouts
- **TCP + bad Wi-Fi = unwatchable streams** — the connection dies, Twitch disconnects, stream is over

We don't need to build a whole new self-hosted system to fix this. Cloudflare already supports SRT ingest, which is UDP-based and handles packet loss gracefully. We also don't need China support right now.

### Phase 1 Architecture

Phase 1 has two independent workstreams that can be developed in parallel:

#### Workstream A: SRT for Managed Streams (Livestreaming)

Replace RTMP ingest with SRT ingest for managed streams (the livestreamer app). Keep everything else the same — Cloudflare still handles RTMP rebroadcast to Twitch/YouTube.

```
Current (broken):
  Glasses ──RTMP (TCP, bad WiFi)──► Cloudflare ──RTMP──► Twitch/YouTube

Phase 1 (fixed):
  Glasses ──SRT (UDP, handles drops)──► Cloudflare ──RTMP──► Twitch/YouTube
```

**Why SRT fixes the problem:**

- SRT is UDP-based — packet loss causes brief quality drops, not connection death
- SRT has built-in retransmission and FEC (forward error correction)
- Cloudflare already provides SRT ingest URLs alongside RTMP for every live input
- The Cloudflare API already returns `srt.url`, `srt.streamId`, and `srt.passphrase` in the live input response (we just ignore them today)

**What changes:**

| Component                      | Change                                                                       | Effort |
| ------------------------------ | ---------------------------------------------------------------------------- | ------ |
| `CloudflareStreamService.ts`   | Return `srtUrl` from `createLiveInput()` instead of (or alongside) `rtmpUrl` | Small  |
| `ManagedStreamingExtension.ts` | Send SRT URL to glasses instead of RTMP URL                                  | Small  |
| SDK message types              | Add `StartSrtStream` message type (or reuse `StartRtmpStream` with SRT URL)  | Small  |
| ASG Client (glasses)           | Add SRT streaming support (e.g., FFmpeg with SRT, or native SRT library)     | Medium |
| `LiveInputResult` interface    | Add `srtUrl` field                                                           | Small  |

**Cloudflare SRT details:**

When a Cloudflare live input is created, the API response already includes SRT connection info:

```typescript
// Already in our CloudflareLiveInput interface (CloudflareStreamService.ts)
srt?: {
  url: string;        // SRT ingest URL
  streamId: string;   // SRT stream ID
  passphrase: string; // SRT passphrase
}
```

Cloudflare supports SRT in **caller mode** only — the glasses initiate the connection to Cloudflare's SRT endpoint.

**ASG Client implementation:**

StreamPackLite already has full SRT support via `CameraSrtLiveStreamer` (the SRT equivalent of the currently-used `CameraRtmpLiveStreamer`). The SRT extension lives at `asg_client/StreamPackLite/extensions/srt/` and includes bitrate regulation, connection descriptors, and camera/screen/audio streamers. This makes the ASG client change straightforward — swap `CameraRtmpLiveStreamer` for `CameraSrtLiveStreamer` in `RtmpStreamingService.java` (or create a parallel `SrtStreamingService.java`).

#### Workstream B: WebRTC Streaming for Miniapps

Add a WebRTC (WHIP) streamer to Mentra Live so miniapps can receive low-latency video streams. Uses Cloudflare's WebRTC support (WHIP in, WHEP out).

```
Glasses ──WebRTC/WHIP──► Cloudflare ──WebRTC/WHEP──► Miniapp server/webview
```

**Important Cloudflare constraint:** WHIP and WHEP must be used together on Cloudflare. You cannot do WebRTC in and RTMP/HLS out, or RTMP/SRT in and WebRTC out. This is why WebRTC streaming is a separate path from managed livestreaming — they use independent Cloudflare live inputs.

**What changes:**

| Component            | Change                                                                       | Effort           |
| -------------------- | ---------------------------------------------------------------------------- | ---------------- |
| SDK                  | Add `startWebRTCStream()` method to camera module                            | Medium           |
| Cloud backend        | Create Cloudflare live input with WebRTC enabled, return WHEP URL to miniapp | Medium           |
| ASG Client (glasses) | Add WebRTC/WHIP streaming capability                                         | Medium-Large     |
| SDK types            | Add `WebRTCStreamResult` with `whepUrl`                                      | Small            |
| Miniapp consumption  | Miniapps receive `whepUrl` and connect via standard WebRTC                   | Small (SDK docs) |

**WebRTC flow:**

```
1. Miniapp calls session.camera.startWebRTCStream()
2. Cloud creates Cloudflare live input (WebRTC mode)
3. Cloudflare returns WHIP URL (for glasses to push) and WHEP URL (for consumers to pull)
4. Cloud sends WHIP URL to glasses → glasses start WebRTC stream to Cloudflare
5. Cloud sends WHEP URL to miniapp → miniapp connects via WebRTC to watch
```

### Phase 1 Summary

| Feature                 | Protocol           | Provider   | Latency | Use Case                                   |
| ----------------------- | ------------------ | ---------- | ------- | ------------------------------------------ |
| Managed livestreaming   | SRT in → RTMP out  | Cloudflare | 3-10s   | Twitch, YouTube, social platforms          |
| Miniapp video streaming | WebRTC (WHIP/WHEP) | Cloudflare | <1s     | AI processing, AR overlays, real-time apps |

**What we DON'T need for Phase 1:**

- No new infrastructure (keep using Cloudflare)
- No self-hosted media servers
- No FFmpeg workers or re-encoding pipeline
- No fallback frame injection
- No China support (not needed yet)
- No HLS generation (Cloudflare handles this for managed streams)

### Phase 1 Tasks

#### Workstream A: SRT for Managed Streams

- [ ] Update `CloudflareStreamService.createLiveInput()` to extract and return SRT URL from Cloudflare response
- [ ] Update `LiveInputResult` to include `srtUrl` field
- [ ] Update `ManagedStreamingExtension` to send SRT URL to glasses instead of RTMP URL
- [ ] Add SRT message type to SDK (or extend existing RTMP message to accept SRT URLs)
- [ ] Add SRT streaming capability to ASG Client (evaluate: FFmpeg-based vs native SRT library vs phone relay)
- [ ] Test SRT streaming end-to-end: glasses → Cloudflare → Twitch
- [ ] Verify Cloudflare RTMP rebroadcast works with SRT input
- [ ] Test reliability under poor Wi-Fi conditions (the whole point)

#### Workstream B: WebRTC for Miniapps

- [ ] Add `startWebRTCStream()` / `stopWebRTCStream()` to SDK camera module
- [ ] Add WebRTC stream message types to SDK
- [ ] Add cloud handler for WebRTC stream requests (create Cloudflare live input in WebRTC mode)
- [ ] Return WHEP URL to miniapp via `ManagedStreamResult` or new `WebRTCStreamResult`
- [ ] Add WebRTC/WHIP streaming capability to ASG Client
- [ ] Create example miniapp that consumes WHEP stream
- [ ] Document WHEP consumption for miniapp developers

---

# Phase 2: Mentra Stream Muxer (Self-Hosted)

## Overview

The Mentra Stream Muxer is a self-hosted replacement for Cloudflare Live that handles:

- **WHIP ingest** from smart glasses (WebRTC/UDP)
- **WHEP playback** for low-latency preview (WebRTC, sub-second)
- **Re-encoding** to normalize streams
- **Fallback frame injection** when input drops
- **RTMP output** to Twitch, YouTube, etc.

This service is designed to be:

- **Cloud-agnostic**: Works on Azure, Alibaba, or self-hosted
- **Scalable**: From single-process to hundreds of concurrent streams
- **API-compatible**: Minimal changes required in cloud backend

---

## Architecture

```
┌────────────────────────────────────────────────────────────────────────────┐
│                          Kubernetes Cluster                                 │
│                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │         MUXER POD (single container: orchestrator + mediamtx)        │  │
│  │                                                                      │  │
│  │   ┌─────────────────┐          ┌─────────────────────────────┐      │  │
│  │   │  Orchestrator   │          │        MediaMTX             │      │  │
│  │   │  (Node.js)      │          │                             │      │  │
│  │   │                 │          │  WHIP signaling: HTTP 8080  │      │  │
│  │   │  /live_inputs   │          │  WHEP signaling: HTTP 8080  │      │  │
│  │   │  /outputs       │          │  WebRTC media: UDP 8889     │      │  │
│  │   │  /health        │          │  (UDP mux - many streams    │      │  │
│  │   │                 │          │   on single port)           │      │  │
│  │   │                 │          │  RTSP internal: 8554        │      │  │
│  │   │  Spawns/kills   │          │                             │      │  │
│  │   │  worker pods ───┼──────────┼──► k8s API                  │      │  │
│  │   └─────────────────┘          └──────────────▲──────────────┘      │  │
│  │                                               │                      │  │
│  │   Service: mentra-stream-muxer (ClusterIP)    │ RTSP :8554           │  │
│  └───────────────────────────────────────────────┼──────────────────────┘  │
│                                                  │                         │
│                                                  │ Workers pull via:       │
│                                                  │ rtsp://mentra-stream-   │
│                                                  │ muxer:8554/{streamId}   │
│                                                  │                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                        │
│  │  Worker 1   │  │  Worker 2   │  │  Worker N   │   (separate pods)      │
│  │  (FFmpeg)   │  │  (FFmpeg)   │  │  (FFmpeg)   │                        │
│  │             │  │             │  │             │                        │
│  │ • RTSP in   │  │ • RTSP in   │  │ • RTSP in   │                        │
│  │ • Encode    │  │ • Encode    │  │ • Encode    │                        │
│  │ • Fallback  │  │ • Fallback  │  │ • Fallback  │                        │
│  │ • RTMP out  │  │ • RTMP out  │  │ • RTMP out  │                        │
│  │ • HLS → R2  │  │ • HLS → R2  │  │ • HLS → R2  │                        │
│  └─────────────┘  └─────────────┘  └─────────────┘                        │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

### Key Design Decisions

**Single Container for Orchestrator + MediaMTX:**

- One Porter deployment, one thing to manage
- MediaMTX is just a lightweight binary running alongside Node.js
- Same pattern as cloud service running Node.js + Go bridge

**UDP Mux for WebRTC:**

- MediaMTX multiplexes all WebRTC streams through single UDP port (8889)
- Hundreds of streams can share one port (demuxed by ICE credentials)
- Same setup pattern as audio UDP LoadBalancer

**Workers Pull from MediaMTX:**

- Workers don't need routable IPs
- Pull their stream via RTSP from MediaMTX (cluster-internal)
- Clean separation: MediaMTX handles ingest, workers handle encoding

### Data Flow

```
Smart Glasses
     │
     │ WebRTC/WHIP (UDP)
     ▼
┌─────────────┐
│  MediaMTX   │  ◄── Accepts WHIP, outputs RTSP + WHEP
└─────┬───┬───┘
      │   │
      │   └─────► WHEP ──► Miniapp webview (preview, <1s latency)
      │                  ► Miniapp server (frame processing, <1s latency)
      │
      │ RTSP (local)
      ▼
┌─────────────┐
│   FFmpeg    │  ◄── Decode → Fallback logic → Encode
└─────┬───────┘
      │
      ├─────► RTMP ────► Twitch / YouTube / etc.
      │
      └─────► HLS ─────► CDN/Direct ────► Browser embed (hlsUrl, 5-15s latency)
```

### Output Types

1. **RTMP outputs** (restreaming): Push to Twitch, YouTube, Kick, etc.
2. **HLS output** (viewing): Generate `.m3u8` + `.ts` segments for browser playback (5-15s latency)
3. **WHEP output** (low-latency preview): WebRTC playback direct from MediaMTX (<1s latency)

RTMP and HLS run through FFmpeg workers. WHEP is served directly by MediaMTX with zero additional encoding cost — consumers connect directly to MediaMTX, bypassing the worker pipeline entirely. HLS is always generated; RTMP outputs are optional per-stream; WHEP is always available when a stream is connected.

---

## API Design

### Goal: Cloudflare-Compatible API

To minimize changes in the cloud backend, we mirror Cloudflare's Live Input API structure where practical.

**Base URL**: `https://muxer.mentra.glass` (or `MUXER_API_URL` env var)

### Endpoints

#### Create Live Input

```
POST /live_inputs

Request:
{
  "meta": {
    "userId": "user@example.com",
    "name": "My Stream"
  },
  "recording": {
    "mode": "off"              // "off" | "automatic" (future)
  },
  "preferredProtocol": "whip"  // "whip" | "rtmp" (future)
}

Response:
{
  "uid": "abc123def456",
  "created": "2025-01-28T12:00:00Z",
  "meta": {
    "userId": "user@example.com",
    "name": "My Stream"
  },
  "status": "ready",
  "whip": {
    "url": "https://muxer.mentra.glass/whip/abc123def456"
  },
  "whep": {
    "url": "https://muxer.mentra.glass/whep/abc123def456"
  },
  "rtmps": {
    "url": "rtmps://muxer.mentra.glass/live/abc123def456",
    "streamKey": "abc123def456"
  },
  "hls": {
    "url": "https://streams.mentra.glass/abc123def456/index.m3u8"
  }
}
```

**Comparison to Cloudflare:**
| Field | Cloudflare | Mentra Muxer |
|-------|------------|--------------|
| `uid` | ✅ | ✅ |
| `meta` | ✅ | ✅ |
| `status` | ✅ | ✅ |
| `whip.url` | ✅ | ✅ |
| `whep.url` | ❌ | ✅ (new — low-latency playback) |
| `rtmps.url` | ✅ | ✅ |
| `hls.url` | ✅ | ✅ |

#### Get Live Input

```
GET /live_inputs/:uid

Response:
{
  "uid": "abc123def456",
  "status": "connected",       // "ready" | "connected" | "disconnected"
  "inputStatus": {
    "connected": true,
    "lastSeen": "2025-01-28T12:05:00Z",
    "protocol": "whip",
    "videoCodec": "H264",
    "audioCodec": "opus",
    "resolution": "1280x720",
    "fps": 30
  },
  ...
}
```

#### Delete Live Input

```
DELETE /live_inputs/:uid

Response:
{
  "success": true
}
```

#### Add Output (Restream)

```
POST /live_inputs/:uid/outputs

Request:
{
  "url": "rtmps://live.twitch.tv/app",
  "streamKey": "live_123456_xxxxx"
}

Response:
{
  "uid": "output_789",
  "url": "rtmps://live.twitch.tv/app",
  "status": "connecting"       // "connecting" | "connected" | "disconnected"
}
```

#### List Outputs

```
GET /live_inputs/:uid/outputs

Response:
{
  "outputs": [
    {
      "uid": "output_789",
      "url": "rtmps://live.twitch.tv/app",
      "status": "connected"
    }
  ]
}
```

#### Remove Output

```
DELETE /live_inputs/:uid/outputs/:outputUid

Response:
{
  "success": true
}
```

---

## Cloud Backend Integration

### Current Code (Cloudflare)

```typescript
// CloudflareStreamService.ts
async createLiveInput(userId: string, options: CreateLiveInputOptions): Promise<LiveInputResult> {
  const response = await fetch(`${CF_API}/live_inputs`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${CF_TOKEN}` },
    body: JSON.stringify({ meta: { userId }, ... })
  });
  return response.json();
}
```

### New Code (Mentra Muxer)

```typescript
// MuxerStreamService.ts (or just modify CloudflareStreamService)
async createLiveInput(userId: string, options: CreateLiveInputOptions): Promise<LiveInputResult> {
  const response = await fetch(`${MUXER_API_URL}/live_inputs`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${MUXER_TOKEN}` },
    body: JSON.stringify({ meta: { userId }, ... })
  });
  return response.json();
}
```

### Migration Strategy

**Option A: Environment-based switching**

```typescript
const streamService =
  process.env.STREAM_PROVIDER === "muxer" ? new MuxerStreamService() : new CloudflareStreamService();
```

**Option B: Replace CloudflareStreamService entirely**
Since API is compatible, just change the base URL and auth.

**Option C: Adapter pattern**

```typescript
interface StreamService {
  createLiveInput(userId: string, options: Options): Promise<LiveInput>;
  deleteLiveInput(uid: string): Promise<void>;
  addOutput(uid: string, output: Output): Promise<OutputResult>;
  // ...
}

class CloudflareStreamService implements StreamService { ... }
class MuxerStreamService implements StreamService { ... }
```

**Recommendation**: Option A for now (quick switch), refactor to Option C later.

---

## Worker Modes

The orchestrator can spawn workers in three modes:

### Mode: `local` (Self-Hosting / Dev)

- Orchestrator and workers run in same process/container
- MediaMTX runs as single shared instance
- FFmpeg processes spawned directly
- No k8s or docker required

```
┌─────────────────────────────────────────┐
│  Single Container                       │
│                                         │
│  Orchestrator ─┬─► FFmpeg (stream 1)    │
│                ├─► FFmpeg (stream 2)    │
│  MediaMTX ◄────┴─► FFmpeg (stream 3)    │
│                                         │
└─────────────────────────────────────────┘
```

**Capacity**: 3-10 streams depending on CPU

### Mode: `kubernetes` (Production)

- Orchestrator spawns worker pods via k8s API
- Horizontal scaling across nodes
- Works on Azure AKS, Alibaba ACK, any k8s

```
┌──────────────────────────────────────────────────────┐
│  Kubernetes Cluster                                  │
│                                                      │
│  ┌─────────────┐                                     │
│  │Orchestrator │                                     │
│  │    Pod      │                                     │
│  └──────┬──────┘                                     │
│         │ k8s API                                    │
│         │                                            │
│  ┌──────▼──────┐  ┌─────────────┐  ┌─────────────┐  │
│  │  Worker Pod │  │ Worker Pod  │  │ Worker Pod  │  │
│  │   (node A)  │  │  (node B)   │  │  (node A)   │  │
│  └─────────────┘  └─────────────┘  └─────────────┘  │
│                                                      │
└──────────────────────────────────────────────────────┘
```

**Capacity**: Hundreds of streams (limited by cluster size)

---

## Folder Structure

```
cloud/mentra-stream-muxer/
├── PLANNING.md                      # This document
├── README.md                        # Usage documentation
│
├── Dockerfile                       # Single container: orchestrator + mediamtx
├── start.sh                         # Starts both mediamtx and node
├── mediamtx.yml                     # MediaMTX config (UDP mux enabled)
│
├── src/                             # Orchestrator (Node.js/TypeScript)
│   ├── index.ts                     # HTTP server entry point
│   ├── config.ts                    # Environment config
│   │
│   ├── api/
│   │   ├── live-inputs.ts           # /live_inputs routes
│   │   ├── outputs.ts               # /outputs routes
│   │   └── health.ts                # /health route
│   │
│   ├── services/
│   │   ├── stream-manager.ts        # Tracks active streams state
│   │   ├── worker-manager.ts        # Manages worker pod lifecycle
│   │   └── r2-cleanup.ts            # Cleans up R2 on stream end/crash
│   │
│   ├── drivers/
│   │   ├── interface.ts             # WorkerDriver interface
│   │   ├── local.ts                 # Spawn FFmpeg processes (dev)
│   │   └── kubernetes.ts            # Spawn K8s pods (prod)
│   │
│   └── types/
│       └── index.ts                 # TypeScript types
│
├── worker/                          # FFmpeg encoding worker (separate image)
│   ├── Dockerfile                   # Based on Alpine, includes ffmpeg + rclone
│   ├── entrypoint.sh                # Startup script
│   ├── fallback.png                 # "Reconnecting..." image
│   ├── rclone.conf.template         # R2 config template (uses env vars)
│   └── scripts/
│       ├── ffmpeg-stream.sh         # FFmpeg pipeline with fallback
│       └── r2-sync.sh               # Upload HLS segments to R2 via rclone
│
├── scripts/
│   └── setup-udp-service.sh         # One-time: create UDP LoadBalancer
│
├── docker-compose.yml               # Local dev / self-hosting
├── porter.yaml                      # Porter deployment config
├── package.json
└── tsconfig.json
```

### Two Container Images

| Image                          | Contents                          | Scaling                                  |
| ------------------------------ | --------------------------------- | ---------------------------------------- |
| **mentra-stream-muxer**        | Orchestrator (Node.js) + MediaMTX | 1 per region, deployed via Porter        |
| **mentra-stream-muxer-worker** | FFmpeg + fallback logic + R2 sync | 1 per active stream, spawned dynamically |

---

## Configuration

### Environment Variables

#### Muxer (Orchestrator + MediaMTX)

| Variable                  | Description                          | Default                             |
| ------------------------- | ------------------------------------ | ----------------------------------- |
| `MODE`                    | Worker mode: `local` or `kubernetes` | `local`                             |
| `PORT`                    | HTTP API port                        | `8080`                              |
| `AUTH_TOKEN`              | API authentication token             | (required)                          |
| `WORKER_IMAGE`            | Worker container image (k8s mode)    | `mentra/stream-muxer-worker:latest` |
| `WORKER_CPU`              | CPU cores per worker (k8s mode)      | `2`                                 |
| `WORKER_MEMORY`           | Memory per worker (k8s mode)         | `1Gi`                               |
| `MAX_STREAMS`             | Maximum concurrent streams           | `100`                               |
| `R2_ACCESS_KEY_ID`        | Cloudflare R2 access key             | (required)                          |
| `R2_SECRET_ACCESS_KEY`    | Cloudflare R2 secret key             | (required)                          |
| `R2_ENDPOINT`             | R2 endpoint URL                      | (required)                          |
| `R2_BUCKET`               | R2 bucket for HLS segments           | `mentra-streams`                    |
| `MEDIAMTX_WEBRTC_ADDRESS` | MediaMTX WebRTC UDP port             | `:8889`                             |
| `MEDIAMTX_RTSP_ADDRESS`   | MediaMTX internal RTSP port          | `:8554`                             |

#### Worker

| Variable               | Description                                                                                  | Default          |
| ---------------------- | -------------------------------------------------------------------------------------------- | ---------------- |
| `STREAM_ID`            | Unique stream identifier                                                                     | (required)       |
| `MEDIAMTX_HOST`        | MediaMTX hostname (k8s: `mentra-stream-muxer.default.svc.cluster.local`, local: `localhost`) | (required)       |
| `RTMP_OUTPUTS`         | JSON array of RTMP output configs                                                            | `[]`             |
| `VIDEO_BITRATE`        | Output video bitrate                                                                         | `4500k`          |
| `AUDIO_BITRATE`        | Output audio bitrate                                                                         | `128k`           |
| `FALLBACK_TIMEOUT_MS`  | Time before showing fallback                                                                 | `2000`           |
| `R2_ACCESS_KEY_ID`     | Cloudflare R2 access key                                                                     | (required)       |
| `R2_SECRET_ACCESS_KEY` | Cloudflare R2 secret key                                                                     | (required)       |
| `R2_ENDPOINT`          | R2 endpoint URL                                                                              | (required)       |
| `R2_BUCKET`            | R2 bucket for HLS segments                                                                   | `mentra-streams` |

---

## Fallback Frame Logic

When the input stream drops, the worker must:

1. Detect missing frames (no data for `FALLBACK_TIMEOUT_MS`)
2. Switch to fallback image (static "Reconnecting..." graphic)
3. Continue outputting to RTMP (Twitch stays connected)
4. When input returns, seamlessly switch back

### Implementation Options

**Option A: FFmpeg filter graph**

```bash
ffmpeg \
  -f lavfi -i "movie=fallback.png:loop=0,setpts=N/30/TB" \
  -i "rtsp://localhost:8554/${STREAM_ID}" \
  -filter_complex "[1:v]setpts=PTS-STARTPTS[main];[0:v][main]overlay=eof_action=pass" \
  ...
```

_Pros_: Simple. _Cons_: Switching not instant.

**Option B: GStreamer compositor**

```
GStreamer pipeline with input-selector for clean switching
```

_Pros_: Better switching. _Cons_: More complex.

**Option C: Custom app (Go/Rust)**

```
Small binary that reads RTP, detects gaps, injects fallback frames
```

_Pros_: Full control. _Cons_: More to build.

**Recommendation**: Start with Option A (FFmpeg). Iterate to B or C if switching quality is unacceptable.

---

## Scaling Strategy

### Horizontal Scaling (Orchestrator)

The orchestrator is stateless except for in-memory stream tracking. For HA:

1. **Single orchestrator** (MVP): Good enough for 100s of streams
2. **Redis-backed state**: Move stream state to Redis for multiple orchestrators
3. **Orchestrator per region**: One in Azure, one in Alibaba

### Vertical Scaling (Workers)

Each worker handles one stream. Scaling = more workers.

| Mode         | Scaling Approach                          |
| ------------ | ----------------------------------------- |
| `local`      | Limited by CPU cores (~1 core per stream) |
| `kubernetes` | Cluster autoscaler adds nodes as needed   |

### Resource Requirements

Per 720p30 stream (with re-encoding):

- **CPU**: ~1.5-2 cores
- **Memory**: ~256-512 MB
- **Bandwidth**: ~5 Mbps out (to Twitch)

For 200 concurrent streams:

- **CPU**: ~300-400 cores
- **Memory**: ~50-100 GB
- **Machines**: ~20-40 VMs (8 vCPU each)

---

## HLS Playback (Required)

Apps receive `hlsUrl` to embed streams in browsers/apps. We must generate and serve HLS.

### How HLS Works

FFmpeg outputs:

```
/hls/{streamId}/
├── index.m3u8      # Playlist (updated every segment)
├── segment_000.ts  # 2-second video chunks
├── segment_001.ts
├── segment_002.ts
└── ...
```

Browser requests `index.m3u8`, then fetches `.ts` segments as they appear.

### Serving Strategies

#### Option A: Direct from Worker (MVP)

Each worker serves its own HLS via HTTP.

```
Worker Pod
├── FFmpeg → writes to /tmp/hls/
└── nginx/caddy → serves /tmp/hls/ on port 8080
```

`hlsUrl` = `https://worker-{streamId}.muxer.mentra.glass/hls/index.m3u8`

**Pros**: Simple, no external dependencies
**Cons**: Worker IP/hostname must be routable, scaling requires load balancer per worker

#### Option B: Shared HLS Server (Better)

Workers write HLS segments to a shared volume or push to a central server.

```
Workers ──(write segments)──► Shared Storage ──► HLS Server ──► Viewers
```

`hlsUrl` = `https://hls.muxer.mentra.glass/{streamId}/index.m3u8`

**Pros**: Single endpoint, easier SSL/routing
**Cons**: Shared storage complexity

#### Option C: CDN/Object Storage (Production Scale)

Workers push segments to Azure Blob Storage or Cloudflare R2. CDN serves to viewers.

```
Workers ──(upload)──► Azure Blob ──► Azure CDN ──► Viewers
```

`hlsUrl` = `https://streams.mentra.glass/{streamId}/index.m3u8`

**Pros**: Infinite scale, global distribution, Cloudflare already in our stack
**Cons**: Added latency (~1-2s), more moving parts

### Decision: Cloudflare R2 (Option C)

**We already use R2 for image hosting. Use it for HLS too.**

Why R2 wins:

- Workers don't need routable IPs/hostnames (k8s pods are ephemeral)
- R2 handles infinite concurrent viewers without touching workers
- Cloudflare edge = global distribution built-in
- One less thing for worker containers to manage
- Latency penalty (~0.5-2s) is negligible on top of HLS's existing 5-10s

Implementation:

```bash
# Worker Dockerfile includes rclone (S3-compatible CLI, ~15MB)
# RUN apk add --no-cache rclone

# rclone.conf.template (populated from env vars at startup)
# [r2]
# type = s3
# provider = Cloudflare
# access_key_id = ${R2_ACCESS_KEY_ID}
# secret_access_key = ${R2_SECRET_ACCESS_KEY}
# endpoint = ${R2_ENDPOINT}

# Worker writes HLS locally
ffmpeg ... -f hls -hls_time 2 -hls_list_size 5 /tmp/hls/index.m3u8

# Background sync to R2 (every 500ms)
while true; do
  rclone sync /tmp/hls/ r2:mentra-streams/$STREAM_ID/ --checksum
  sleep 0.5
done

# On stream end, cleanup R2 segments
rclone delete r2:mentra-streams/$STREAM_ID/
```

**hlsUrl** = `https://streams.mentra.glass/{streamId}/index.m3u8`

**R2 Custom Domain Setup (one-time):**

1. Create R2 bucket `mentra-streams`
2. In Cloudflare Dashboard → R2 → mentra-streams → Settings → Custom Domains
3. Add `streams.mentra.glass` as custom domain
4. Cloudflare handles SSL and CDN caching automatically

For China: Alibaba OSS + CDN instead of R2. Same pattern, different bucket.

---

## WHEP Playback (Low-Latency Preview)

WHEP (WebRTC-HTTP Egress Protocol) provides sub-second latency playback directly from MediaMTX. This complements HLS (which has 5-15s latency) for use cases that need real-time preview.

### How WHEP Works

WHEP is the playback counterpart to WHIP. The consumer sends an HTTP POST to the WHEP endpoint with an SDP offer, gets back an SDP answer, and establishes a WebRTC PeerConnection to receive the stream.

```
Consumer                          MediaMTX
   │                                │
   │  POST /whep/{streamId}         │
   │  Body: SDP offer               │
   │  ─────────────────────────►    │
   │                                │
   │  201 Created                   │
   │  Body: SDP answer              │
   │  ◄─────────────────────────    │
   │                                │
   │  WebRTC media (UDP 8889)       │
   │  ◄════════════════════════►    │
   │                                │
```

### Use Cases

| Consumer                           | Method                                        | Latency |
| ---------------------------------- | --------------------------------------------- | ------- |
| **Miniapp webview** (phone)        | WHEP via JS `RTCPeerConnection`               | <1s     |
| **Miniapp server** (cloud)         | WHEP via WebRTC library (werift, node-webrtc) | <1s     |
| **Public viewers** (browser embed) | HLS via R2 CDN                                | 5-15s   |

### Miniapp Webview Integration

The miniapp server receives `whepUrl` from the cloud (in `ManagedStreamResult`, alongside `hlsUrl`) and forwards it to its webview frontend. The webview then plays the stream using a standard WebRTC connection. A minimal WHEP player is ~50 lines of JS:

```javascript
// In miniapp webview
async function playWhepStream(whepUrl, videoElement) {
  const pc = new RTCPeerConnection();
  pc.addTransceiver("video", { direction: "recvonly" });
  pc.addTransceiver("audio", { direction: "recvonly" });

  pc.ontrack = (event) => {
    videoElement.srcObject = event.streams[0];
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const response = await fetch(whepUrl, {
    method: "POST",
    headers: { "Content-Type": "application/sdp" },
    body: pc.localDescription.sdp,
  });

  const answer = await response.text();
  await pc.setRemoteDescription({ type: "answer", sdp: answer });
}
```

The React Native WebView already has `allowsInlineMediaPlayback={true}` and WebRTC is supported. A future SDK helper (e.g., `MentraSDK.playStream(whepUrl, videoElement)`) could wrap this for miniapp developers.

### Miniapp Server Integration

Miniapp servers receive `whepUrl` in the `ManagedStreamResult` alongside `hlsUrl`. For servers that need low-latency frame access (computer vision, AI processing), they can consume the WHEP stream using a WebRTC library:

- **Node.js**: `werift` (pure JS) or `node-webrtc` (native bindings)
- **Python**: `aiortc`
- **Go**: `pion/webrtc`

This is a power-user path. A future SDK enhancement could provide frame-extraction helpers, but for MVP the raw `whepUrl` is sufficient.

### Networking

WHEP signaling is HTTP — it flows through the same Porter ingress as WHIP signaling and the REST API. The WebRTC media for WHEP playback uses the same UDP port 8889 that WHIP ingest uses (MediaMTX multiplexes both on the same port via ICE credentials). **No additional LoadBalancer or port exposure is needed.**

### MediaMTX Configuration

WHEP is natively supported by MediaMTX. Enable it in `mediamtx.yml`:

```yaml
# mediamtx.yml
webrtc: true
webrtcAddress: :8889
# WHEP is served on the same HTTP port as WHIP
# WHIP: POST /whip/{streamId}
# WHEP: POST /whep/{streamId}
```

### Latency Comparison

| Method          | End-to-End Latency | Best For                         |
| --------------- | ------------------ | -------------------------------- |
| WHEP (WebRTC)   | 200ms - 500ms      | In-app preview, frame processing |
| HLS (R2 CDN)    | 5s - 15s           | Public embed, scalable viewing   |
| RTMP (restream) | 3s - 10s           | Twitch/YouTube live              |

### Cloud Backend Flow

The `whepUrl` flows through the same path as `hlsUrl`:

```
1. Cloud calls POST /live_inputs → muxer returns { whep: { url }, hls: { url }, ... }
2. Cloud stores whepUrl in ManagedStreamResult
3. Cloud sends MANAGED_STREAM_STATUS to miniapp server (over WebSocket) with whepUrl + hlsUrl
4. Miniapp server decides what to do with the URLs:
   a. Forward whepUrl to its webview frontend for low-latency preview
   b. Consume whepUrl directly via WebRTC library for frame processing
   c. Forward hlsUrl to its webview for higher-latency but simpler playback
```

In the SDK, `ManagedStreamResult` gains a `whepUrl` field:

```typescript
interface ManagedStreamResult {
  streamId: string;
  hlsUrl: string;
  dashUrl?: string;
  whepUrl: string; // NEW — low-latency WebRTC playback
  webrtcUrl?: string; // deprecated Cloudflare field, use whepUrl instead
  previewUrl?: string;
  thumbnailUrl?: string;
}
```

---

## Deployment

### Self-Hosting (docker-compose)

```yaml
# docker-compose.yml
version: "3.8"

services:
  mentra-stream-muxer:
    image: mentra/stream-muxer:latest
    ports:
      - "8080:8080" # API + WHIP signaling (HTTP)
      - "8889:8889/udp" # WebRTC media (UDP)
    environment:
      MODE: local
      AUTH_TOKEN: ${MUXER_AUTH_TOKEN}
      R2_ACCESS_KEY_ID: ${R2_ACCESS_KEY_ID}
      R2_SECRET_ACCESS_KEY: ${R2_SECRET_ACCESS_KEY}
      R2_ENDPOINT: ${R2_ENDPOINT}
      R2_BUCKET: mentra-streams
```

```bash
docker-compose up -d
```

### Azure (Porter) - Two Steps

**Step 1: Deploy via Porter**

```yaml
# porter.yaml
version: v2

build:
  method: docker
  context: .
  dockerfile: Dockerfile

services:
  - name: mentra-stream-muxer
    type: web
    run: ./start.sh
    port: 8080
    cpuCores: 2
    ramMegabytes: 1024
    env:
      MODE: kubernetes
      AUTH_TOKEN: ${MUXER_AUTH_TOKEN}
      WORKER_IMAGE: mentra/stream-muxer-worker:latest
      R2_ACCESS_KEY_ID: ${R2_ACCESS_KEY_ID}
      R2_SECRET_ACCESS_KEY: ${R2_SECRET_ACCESS_KEY}
      R2_ENDPOINT: ${R2_ENDPOINT}
      R2_BUCKET: mentra-streams
      MEDIAMTX_RTSP_ADDRESS: :8554
      MEDIAMTX_WEBRTC_ADDRESS: :8889
```

**Step 2: Create UDP LoadBalancer (one-time per cluster)**

Porter doesn't expose UDP properly, so we create a LoadBalancer manually (same pattern as audio UDP):

```bash
# Setup UDP service for WebRTC media
./scripts/setup-udp-service.sh --app mentra-stream-muxer --cluster 4689 --port 8889
```

This creates a Kubernetes LoadBalancer service that routes UDP 8889 to the muxer pod.

**Result:**

- HTTP API: `https://muxer.mentra.glass/live_inputs` (via Porter ingress)
- WHIP signaling: `https://muxer.mentra.glass/whip/{streamId}` (via Porter ingress)
- WHEP signaling: `https://muxer.mentra.glass/whep/{streamId}` (via Porter ingress)
- WebRTC media (ingest + playback): `udp://<loadbalancer-ip>:8889` (via manual LoadBalancer)

### Alibaba (China)

Same images, deployed to Alibaba ACK cluster:

1. Push images to Alibaba Container Registry
2. Deploy via kubectl or Alibaba equivalent of Porter
3. Create UDP LoadBalancer for port 8889
4. Configure `MUXER_API_URL` in cloud to point to Alibaba muxer
5. Use Alibaba OSS instead of R2 for HLS segments

---

## Security Considerations

### API Authentication

- All API calls require `Authorization: Bearer <token>` header
- Token set via `AUTH_TOKEN` env var
- Consider JWT with expiration for production

### WHIP Authentication

- WHIP URLs include stream ID: `/whip/:streamId`
- Stream ID is random UUID (unguessable)
- Optional: Add token query param `/whip/:streamId?token=xxx`

### WHEP Authentication

- WHEP URLs include stream ID: `/whep/:streamId`
- Same security model as WHIP — stream ID is random UUID (unguessable)
- Only consumers who receive the `whepUrl` from the cloud (via `ManagedStreamResult`) can connect
- Optional: Add token query param `/whep/:streamId?token=xxx` for additional security

### Network Security

- WHIP signaling (HTTP) exposed via Porter ingress
- WHEP signaling (HTTP) exposed via same Porter ingress (no additional exposure)
- WebRTC media (UDP 8889) exposed via manual LoadBalancer (shared by WHIP ingest + WHEP playback)
- API port (8080) behind auth (Bearer token)
- Worker-to-Twitch RTMP is outbound only
- Workers only need internal network access (RTSP from MediaMTX, upload to R2)

### UDP LoadBalancer Setup (Required for Production)

Porter doesn't properly expose UDP ports. Same issue as audio UDP ingest.

**Solution:** Create a Kubernetes LoadBalancer manually (one-time per cluster):

```bash
# From cloud/mentra-stream-muxer/scripts/
./setup-udp-service.sh --app mentra-stream-muxer --cluster 4689

# Or for all production clusters:
./setup-udp-service.sh --app mentra-stream-muxer --cluster 4689  # US Central
./setup-udp-service.sh --app mentra-stream-muxer --cluster 4696  # France
./setup-udp-service.sh --app mentra-stream-muxer --cluster 4754  # East Asia
```

The script creates a LoadBalancer service that routes UDP 8889 to the muxer pod. The external IP is stable and persists across redeploys.

**Glasses connect to:**

- WHIP signaling: `https://muxer.mentra.glass/whip/{streamId}` (Porter ingress)
- WebRTC media: Discovered via ICE, uses LoadBalancer IP on port 8889

**Miniapp consumers connect to:**

- WHEP signaling: `https://muxer.mentra.glass/whep/{streamId}` (Porter ingress)
- WebRTC media: Same LoadBalancer IP on port 8889 (shared with WHIP)

### Secrets Management

R2 credentials passed to workers via Kubernetes Secrets:

```yaml
# Create once per cluster
kubectl create secret generic r2-credentials \
  --from-literal=R2_ACCESS_KEY_ID=xxx \
  --from-literal=R2_SECRET_ACCESS_KEY=yyy \
  --from-literal=R2_ENDPOINT=https://xxx.r2.cloudflarestorage.com

# Orchestrator includes in pod spec when spawning workers
env:
  - name: R2_ACCESS_KEY_ID
    valueFrom:
      secretKeyRef:
        name: r2-credentials
        key: R2_ACCESS_KEY_ID
```

### Worker Crash Handling

When a worker pod dies unexpectedly:

1. Kubernetes fires termination event
2. Orchestrator watches pod status via k8s API
3. On termination detected:
   - Clean up HLS segments from R2 for that stream
   - Update internal state (`status: "disconnected"`)
   - Cloud sees status change on next poll of `/live_inputs/:id`

No manual intervention needed. Orphaned R2 segments are cleaned up automatically.

---

## Monitoring & Observability

### Health Endpoint

```
GET /health

{
  "status": "healthy",
  "version": "1.0.0",
  "mode": "kubernetes",
  "streams": {
    "active": 42,
    "max": 100
  },
  "workers": {
    "running": 42,
    "pending": 2,
    "failed": 0
  }
}
```

### Metrics (Future)

Expose Prometheus metrics at `/metrics`:

- `muxer_streams_active`
- `muxer_streams_total`
- `muxer_worker_restarts`
- `muxer_output_errors`
- `muxer_input_reconnects`

### Logging

Structured JSON logs:

```json
{
  "level": "info",
  "service": "orchestrator",
  "streamId": "abc123",
  "event": "stream_started",
  "userId": "user@example.com"
}
```

---

## Phase 2 Implementation Phases

### Phase 2a: MVP (Week 1-2)

- [ ] Orchestrator with `local` mode
- [ ] Basic API: create/delete/get live inputs (returns `whip`, `whep`, `hls` URLs)
- [ ] MediaMTX config with WHEP enabled
- [ ] Single output per stream
- [ ] FFmpeg pipeline with fallback (Option A)
- [ ] docker-compose for local testing
- [ ] Cloud integration (env-based switch)
- [ ] `whepUrl` in `ManagedStreamResult` and `MANAGED_STREAM_STATUS`

### Phase 2b: Production Ready (Week 3-4)

- [ ] Kubernetes driver
- [ ] Multiple outputs per stream
- [ ] Porter deployment config
- [ ] Health checks and basic monitoring
- [ ] Error handling and retries
- [ ] Documentation (including WHEP playback guide for miniapp developers)

### Phase 2c: Scale & Polish (Week 5+)

- [ ] Improved fallback switching (GStreamer if FFmpeg isn't clean enough)
- [ ] Prometheus metrics
- [ ] Helm chart
- [ ] Alibaba ACK deployment
- [ ] HLS CDN integration (Azure Blob + CDN or Cloudflare R2)
- [ ] Recording support (save HLS segments to object storage)
- [ ] GPU encoding option (NVENC) if CPU scaling becomes painful
- [ ] SDK WHEP helpers: `MentraSDK.playStream()` for webview, frame-extraction utilities for servers

---

## Design Decisions

1. **HLS playback**: **YES, required.** Apps use `hlsUrl` to let users watch streams in-browser. Workers push HLS segments to Cloudflare R2; viewers fetch from R2 CDN edge.

2. **HLS storage**: **Cloudflare R2.** We already use R2 for images. Workers upload segments every 500ms. China uses Alibaba OSS instead.

3. **Recording**: **Future feature.** Not needed for MVP. We'll accept `recording: { mode: "automatic" }` in the API but ignore it. Can implement later by just keeping HLS segments in R2 instead of deleting them.

4. **GPU encoding**: **CPU-only for now.** Porter/Azure has CPU allocated. Revisit GPU (NVENC) only if we hit scaling ceiling and need higher density.

5. **Worker modes**: **Two modes only** - `local` (self-hosting/dev) and `kubernetes` (production). No docker-in-docker middle ground.

6. **WebRTC playback (WHEP)**: **YES, required from Phase 1.** Miniapp webviews need low-latency preview (<1s) and miniapp servers need low-latency frame access for processing. MediaMTX natively supports WHEP on the same HTTP/UDP ports as WHIP — no additional infrastructure. `whepUrl` returned in API response and forwarded through SDK's `ManagedStreamResult`. HLS remains for public/embed viewers.

7. **Multiple WHIP inputs**: **No.** One connection per live input. No failover/backup device support.

8. **WHIP routing**: **Shared MediaMTX.** One MediaMTX service handles all WHIP ingest. Workers pull streams via RTSP. This avoids per-worker LoadBalancers and keeps networking simple.

9. **Secrets**: **Kubernetes Secrets.** R2 credentials injected into worker pods via secretKeyRef. Standard k8s pattern.

10. **Orchestrator HA**: **Single instance per region.** No Redis needed for MVP. Deploy one muxer in US, add Europe/Asia later as separate deployments.

## Resolved Questions

1. **HLS serving**: Use Cloudflare R2. Workers upload segments, viewers fetch from R2 CDN edge. See "HLS Playback" section above.

2. **Multiple simultaneous inputs**: No. One WHIP connection per live input. Keep it simple.

3. **Low-latency preview for miniapps**: Use WHEP (WebRTC playback) from MediaMTX. Miniapp webviews use `RTCPeerConnection` in JS; miniapp servers can use a WebRTC library (werift, aiortc, pion). `whepUrl` is returned alongside `hlsUrl` in the muxer API and forwarded through `ManagedStreamResult`. No additional infrastructure — WHEP shares the same HTTP ingress and UDP port as WHIP. See "WHEP Playback" section above.

4. **Miniapp server frame processing**: Miniapp servers receive `whepUrl` in `ManagedStreamResult` and can consume the WebRTC stream for low-latency frame access. For MVP, this is a raw URL — SDK frame-extraction helpers are a Phase 3 enhancement.

---

## References

- [Cloudflare Stream Live](https://developers.cloudflare.com/stream/stream-live/)
- [Cloudflare Stream SRT Ingest](https://developers.cloudflare.com/stream/stream-live/start-stream-live/)
- [Cloudflare WebRTC (WHIP/WHEP)](https://developers.cloudflare.com/stream/webrtc-beta/)
- [MediaMTX Documentation](https://github.com/bluenviron/mediamtx)
- [WHIP Specification](https://datatracker.ietf.org/doc/html/draft-ietf-wish-whip)
- [WHEP Specification](https://datatracker.ietf.org/doc/html/draft-ietf-wish-whep)
- [FFmpeg Streaming Guide](https://trac.ffmpeg.org/wiki/StreamingGuide)
- [Kubernetes Client for Node.js](https://github.com/kubernetes-client/javascript)
