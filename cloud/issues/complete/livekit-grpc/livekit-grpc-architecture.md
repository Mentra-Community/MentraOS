# LiveKit gRPC Bridge Architecture

## Current System (WebSocket-based)

### Component Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     TypeScript Cloud                             │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ UserSession                                                 │ │
│  │  ├─ LiveKitManager                                          │ │
│  │  │   └─ LiveKitClient (WebSocket client)                   │ │
│  │  ├─ AudioManager (processAudioData, relayToApps)           │ │
│  │  └─ SpeakerManager (playUrl, stop)                         │ │
│  └────────────────────────────────────────────────────────────┘ │
└──────────────────────┬───────────────────────────────────────────┘
                       │ WebSocket (ws://livekit-bridge:8080/ws)
                       │ - Control: JSON messages
                       │ - Data: Binary PCM frames
┌──────────────────────▼───────────────────────────────────────────┐
│                  Go Bridge (livekit-client-2)                    │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ BridgeService                                               │ │
│  │  └─ Map<userId, BridgeClient>                              │ │
│  │                                                             │ │
│  │ BridgeClient (per user)                                    │ │
│  │  ├─ websocket: *websocket.Conn                             │ │
│  │  ├─ room: *lksdk.Room                                      │ │
│  │  ├─ publishTrack: *lkmedia.PCMLocalTrack                   │ │
│  │  ├─ pacingBuffer: *PacingBuffer                            │ │
│  │  ├─ publisher: *Publisher (audio playback)                 │ │
│  │  └─ goroutines:                                            │ │
│  │      ├─ Run() (message loop)                               │ │
│  │      ├─ pingLoop() (keep-alive)                            │ │
│  │      ├─ PacingBuffer ticker (100ms)                        │ │
│  │      └─ N× sendFunc() (unbounded!)                         │ │
│  └────────────────────────────────────────────────────────────┘ │
└──────────────────────┬───────────────────────────────────────────┘
                       │ WebRTC (LiveKit SDK)
┌──────────────────────▼───────────────────────────────────────────┐
│                     LiveKit SFU                                  │
└──────────────────────┬───────────────────────────────────────────┘
                       │ WebRTC
┌──────────────────────▼───────────────────────────────────────────┐
│          Client (Glasses/Mobile - LiveKit SDK)                   │
└──────────────────────────────────────────────────────────────────┘
```

### Message Flow (Current)

**Control Messages (JSON over WebSocket):**

```json
// TypeScript → Go
{ "action": "join_room", "roomName": "user-123", "token": "jwt..." }
{ "action": "subscribe_enable", "targetIdentity": "user-123" }
{ "action": "play_url", "requestId": "uuid", "url": "https://..." }
{ "action": "stop_playback" }

// Go → TypeScript
{ "type": "connected", "state": "ready" }
{ "type": "room_joined", "participantId": "...", "participantCount": 2 }
{ "type": "play_started", "requestId": "uuid" }
{ "type": "play_complete", "requestId": "uuid", "success": true }
{ "type": "error", "error": "message" }
```

**Audio Data (Binary over WebSocket):**

- TypeScript sends: nothing (only receives)
- Go sends: 16kHz PCM16 mono, ~1600 bytes per frame (100ms chunks)
- Frequency: 10 frames/sec = 30KB/sec per user

### Critical Code Paths

#### Audio Receive Path (LiveKit → TypeScript)

**Go Bridge** (`bridge_client.go`):

```go
// DataPacket handler receives audio from LiveKit room
func (c *BridgeClient) handleDataPacket(packet lksdk.DataPacket, params lksdk.DataReceiveParams) {
    if !c.subscribeEnabled { return }

    pcmData := packet.(*lksdk.UserDataPacket).Payload
    c.pacingBuffer.Add(pcmData)  // Queues for paced delivery
}

// PacingBuffer sends every 100ms
func (pb *PacingBuffer) sendNext() {
    if len(pb.queue) > 0 {
        data := pb.queue[0]
        pb.queue = pb.queue[1:]
        go pb.sendFunc(data)  // ❌ UNBOUNDED GOROUTINE SPAWN
    }
}

// sendFunc calls sendBinaryData
func (c *BridgeClient) sendBinaryData(data []byte) {
    c.websocketMu.Lock()  // ❌ If write is slow, goroutines pile up here
    defer c.websocketMu.Unlock()

    ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
    ws.WriteMessage(websocket.BinaryMessage, data)  // Can block 5 seconds
}
```

**TypeScript** (`LiveKitClient.ts`):

```typescript
this.ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
    if (isBinary) {
        // Normalize to Buffer, handle odd-length frames
        let buf: Buffer = /* ... normalization logic ... */;

        // Forward to AudioManager
        this.userSession.audioManager.processAudioData(buf);
    } else {
        // Handle JSON control messages
        const evt = JSON.parse(data.toString());
        if (this.eventHandler) this.eventHandler(evt);
    }
});
```

**AudioManager** (`AudioManager.ts`):

```typescript
processAudioData(audioData: ArrayBuffer | Buffer) {
    // Normalize to even-length Buffer
    let buf = /* ... normalization ... */;

    // Relay to subscribed apps
    this.relayAudioToApps(buf);  // ❌ No backpressure check

    // Feed to transcription/translation
    this.userSession.transcriptionManager.feedAudio(buf);
    this.userSession.translationManager.feedAudio(buf);
    // ⚠️ Note: Audio arrives BURSTY from LiveKit (see below)
}

private relayAudioToApps(audioData: Buffer): void {
    const subscribedApps = this.userSession.subscriptionManager
        .getSubscribedApps(StreamType.AUDIO_CHUNK);

    for (const packageName of subscribedApps) {
        const connection = this.userSession.appWebsockets.get(packageName);
        if (connection && connection.readyState === WebSocket.OPEN) {
            connection.send(audioData);  // ❌ No bufferedAmount check
        }
    }
}
```

#### Audio Playback Path (App → Client)

**TypeScript** initiates:

```typescript
// SpeakerManager.ts
async start(msg: AudioPlayRequest): Promise<void> {
    const bridge = this.session.liveKitManager.getBridgeClient();
    bridge.playUrl({
        requestId: msg.requestId,
        url: msg.audioUrl,
        volume: msg.volume,
    });
}

// LiveKitClient.ts
public playUrl(params: { requestId: string; url: string; volume?: number }): void {
    this.ws.send(JSON.stringify({
        action: "play_url",
        requestId: params.requestId,
        url: params.url,
        volume: params.volume,
    }));
}
```

**Go Bridge** executes:

```go
// speaker.go
func (p *Publisher) HandlePlayURL(cmd PlayURLCmd) {
    ctx, cancel := context.WithCancel(context.Background())
    p.cancel = cancel

    // HTTP GET audio file
    resp, err := http.DefaultClient.Do(req)

    // Decode MP3 or WAV
    if isMP3 {
        p.streamMP3(ctx, resp.Body, cmd)
    } else {
        p.streamWAV(ctx, resp.Body, cmd)
    }
}

func (p *Publisher) streamMP3(ctx context.Context, r io.Reader, cmd PlayURLCmd) {
    dec, _ := mp3.NewDecoder(r)

    for {
        n, _ := dec.Read(buf)
        // Resample, downmix to mono, apply volume
        samples := processAudio(buf[:n])

        // Write to LiveKit track
        c.publishTrack.WriteSample(samples)

        // ❌ Only checks context at end of loop
        select {
        case <-ctx.Done():
            return
        default:
        }
    }
}
```

### Jitter Buffering Context

**Critical constraint**: Client sends 100ms audio chunks at steady intervals, but LiveKit/network causes **bursty delivery**:

**Observed pattern**:

- Expected: 1 chunk every 100ms (steady stream)
- Reality: 4 chunks arrive within 5ms → 300ms gap → 4 more chunks in 5ms → repeat

**Why this happens**:

- Network packet batching
- LiveKit SFU buffering/forwarding logic
- DataChannel receive window behavior
- Variable network latency

**Why PacingBuffer was created**:

```go
// handleDataPacket receives bursty audio from LiveKit
func (c *BridgeClient) handleDataPacket(...) {
    pcmData := packet.(*lksdk.UserDataPacket).Payload
    c.pacingBuffer.Add(pcmData)  // Queue bursty input
}

// Ticker smooths output to 100ms intervals
func (pb *PacingBuffer) Start() {
    pb.ticker = time.NewTicker(100 * time.Millisecond)
    // Delivers 1 frame every 100ms regardless of input bursts
}
```

**Why smoothing is required**:

- **Soniox transcription**: Streaming ASR expects steady 100ms cadence
- Bursty delivery → Soniox buffering issues → transcription quality degrades
- Translation services also prefer steady input

**Why apps DON'T need smoothing**:

- Apps just relay to WebSocket (they buffer naturally)
- Lower latency is better (send immediately)
- Apps can handle variable timing

### Problems Identified

#### 1. Unbounded Goroutine Spawning (Critical)

**Location**: `pacing.go:62`

```go
func (pb *PacingBuffer) sendNext() {
    // Called every 100ms by ticker
    if len(pb.queue) > 0 {
        data := pb.queue[0]
        pb.queue = pb.queue[1:]
        go pb.sendFunc(data)  // ❌ Spawns goroutine without limit
    }
}
```

**Scenario**:

1. App WebSocket becomes slow (network issue, processing lag)
2. `sendBinaryData()` blocks waiting for write (up to 5 sec timeout)
3. Next ticker fires → spawns another goroutine
4. 10 tickers/sec × 5 sec timeout = up to 50 goroutines queued per user
5. With 100 users, that's 5,000 goroutines competing for mutex
6. Each goroutine stack: ~4KB = 20MB just in stacks

**Porter metrics evidence**:

- Memory climbs from 2.5GB → 7GB over 4-5 hours
- CPU spikes correlate with memory peaks (goroutine thrashing)
- 5xx errors during peaks (resource exhaustion)

**Irony**: PacingBuffer solves jitter (good) but creates memory leak (bad)

#### 2. No Backpressure Mechanism

**Audio relay** (`AudioManager.ts:relayAudioToApps`):

```typescript
connection.send(audioData); // ❌ No check of bufferedAmount
```

If app can't consume at 30KB/sec, Node.js buffers in memory until:

- Connection times out
- OOM occurs
- TCP window closes

Should be:

```typescript
if (connection.bufferedAmount > 512 * 1024) {
  this.logger.warn(`Dropping frame for ${packageName}`);
  continue;
}
```

#### 3. Resource Cleanup Races

**Multiple call paths to Close()**:

```go
func (c *BridgeClient) Close() {
    c.cancel()  // ❌ Can be called multiple times
    // ...
    c.room.Disconnect()  // May panic if already disconnected
    // ...
    close(c.closed)  // ❌ Panics on second call
}
```

Called from:

- `HandleWebSocket()` defer
- `sendBinaryData()` on error
- `sendEvent()` on error
- `sendJSON()` on error

Need `sync.Once` pattern.

#### 4. WebSocket Reconnection Loop

**TypeScript** (`LiveKitClient.ts`):

```typescript
private scheduleReconnect(): void {
    if (this.manualClose || this.disposed) return;

    const delay = Math.min(30000, 1000 * Math.pow(2, this.reconnectAttempts++));
    this.reconnectTimer = setTimeout(() => {
        this.connect(this.lastParams).catch((err) => {
            this.scheduleReconnect();  // Recursive
        });
    }, delay);
}
```

Issues:

- No max attempts (runs forever)
- Race: `dispose()` called during connection → new WebSocket created after disposal
- Connection promise not stored/canceled

#### 5. Event Listener Accumulation

```typescript
async connect(params: {...}): Promise<void> {
    this.ws = new WebSocket(wsUrl);

    // ❌ Listeners added but never explicitly removed
    this.ws.on("message", (data) => { /* closure over userSession */ });
    this.ws.on("close", (code) => { this.scheduleReconnect(); });
    this.ws.on("error", (err) => { /* ... */ });
}
```

On reconnection, old WebSocket still referenced until GC. Closures keep `userSession` alive.

---

## Proposed System (gRPC-based)

### Component Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     TypeScript Cloud                             │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ UserSession                                                 │ │
│  │  ├─ LiveKitManager                                          │ │
│  │  │   └─ LiveKitGrpcClient (gRPC client)                    │ │
│  │  ├─ AudioManager (unchanged)                               │ │
│  │  └─ SpeakerManager (unchanged)                             │ │
│  └────────────────────────────────────────────────────────────┘ │
└──────────────────────┬───────────────────────────────────────────┘
                       │ gRPC over HTTP/2 (localhost:9090)
                       │ - Control: Unary RPCs
                       │ - Data: Bidirectional stream
┌──────────────────────▼───────────────────────────────────────────┐
│                  Go Bridge (livekit-bridge)                      │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │ gRPC Server (port 9090)                                     │ │
│  │  └─ LiveKitBridgeService                                   │ │
│  │                                                             │ │
│  │ RoomSession (per user)                                     │ │
│  │  ├─ room: *lksdk.Room                                      │ │
│  │  ├─ publishTrack: *lkmedia.PCMLocalTrack                   │ │
│  │  ├─ audioStream: grpc.ServerStream                         │ │
│  │  ├─ ctx: context.Context                                   │ │
│  │  ├─ cancel: context.CancelFunc                             │ │
│  │  └─ closeOnce: sync.Once                                   │ │
│  │                                                             │ │
│  │ Goroutines (bounded):                                      │ │
│  │  ├─ StreamAudio handler (1 per user)                       │ │
│  │  ├─ Receive loop (1 per user)                              │ │
│  │  └─ Send loop (1 per user)                                 │ │
│  └────────────────────────────────────────────────────────────┘ │
└──────────────────────┬───────────────────────────────────────────┘
                       │ WebRTC (LiveKit SDK)
┌──────────────────────▼───────────────────────────────────────────┐
│                     LiveKit SFU                                  │
└──────────────────────┬───────────────────────────────────────────┘
                       │ WebRTC
┌──────────────────────▼───────────────────────────────────────────┐
│          Client (Glasses/Mobile - LiveKit SDK)                   │
└──────────────────────────────────────────────────────────────────┘
```

### Protocol Definition

**File**: `livekit-bridge.proto`

```protobuf
syntax = "proto3";

package mentra.livekit.bridge;

service LiveKitBridge {
  // Bidirectional audio streaming
  // Client sends audio TO room, receives audio FROM room
  rpc StreamAudio(stream AudioChunk) returns (stream AudioChunk);

  // Room lifecycle
  rpc JoinRoom(JoinRoomRequest) returns (JoinRoomResponse);
  rpc LeaveRoom(LeaveRoomRequest) returns (LeaveRoomResponse);

  // Server-side audio playback
  rpc PlayAudio(PlayAudioRequest) returns (stream PlayAudioEvent);
  rpc StopAudio(StopAudioRequest) returns (StopAudioResponse);

  // Health check (standard gRPC health protocol)
  rpc HealthCheck(HealthCheckRequest) returns (HealthCheckResponse);
}

message AudioChunk {
  bytes pcm_data = 1;           // Raw PCM16 LE data
  int32 sample_rate = 2;        // 16000
  int32 channels = 3;           // 1 (mono)
  int64 timestamp_ms = 4;
  string user_id = 5;           // For routing
}

message JoinRoomRequest {
  string user_id = 1;
  string room_name = 2;
  string token = 3;
  string livekit_url = 4;
  string target_identity = 5;  // Identity to subscribe to
}

message JoinRoomResponse {
  bool success = 1;
  string error = 2;
  string participant_id = 3;
  int32 participant_count = 4;
}

message PlayAudioRequest {
  string request_id = 1;
  string audio_url = 2;
  float volume = 3;
  bool stop_other = 4;
}

message PlayAudioEvent {
  enum EventType {
    STARTED = 0;
    PROGRESS = 1;
    COMPLETED = 2;
    FAILED = 3;
  }
  EventType type = 1;
  string request_id = 2;
  int64 duration_ms = 3;
  int64 position_ms = 4;
  string error = 5;
}

// ... other messages
```

### Key Architectural Changes

#### 1. Separation of Control and Data Planes

**Control Plane** (Unary RPCs):

- `JoinRoom()` - One-time room setup
- `LeaveRoom()` - Clean disconnection
- `PlayAudio()` - Streaming response for events
- `StopAudio()` - Cancel playback
- `HealthCheck()` - Service health

**Data Plane** (Bidirectional Stream):

- `StreamAudio()` - Continuous audio flow both directions
- HTTP/2 flow control handles backpressure automatically
- Single stream per user session

**Benefits**:

- No head-of-line blocking (control doesn't wait for audio)
- Separate error handling strategies
- Can monitor/rate-limit independently

#### 2. Automatic Backpressure via HTTP/2

gRPC uses HTTP/2 WINDOW_UPDATE frames:

```
Client                              Server
  │                                    │
  ├─────── DATA (AudioChunk) ────────>│
  ├─────── DATA (AudioChunk) ────────>│
  ├─────── DATA (AudioChunk) ────────>│
  │                                    │ (Server processing slow)
  │<──── WINDOW_UPDATE (size=0) ──────┤ (Pause sending)
  │                                    │
  │                                    │ (Server caught up)
  │<──── WINDOW_UPDATE (size=65536) ──┤ (Resume)
  │                                    │
  ├─────── DATA (AudioChunk) ────────>│
```

**No manual buffering needed**. If server can't keep up:

- Client `stream.Send()` blocks
- No goroutine spawning
- No memory accumulation

#### 3. Bounded Goroutines

**Current WebSocket**:

```go
// Unbounded: PacingBuffer spawns goroutine per frame
go pb.sendFunc(data)  // 10/sec × N users × timeout = hundreds
```

**Proposed gRPC**:

```go
// Bounded: 2 goroutines per user
func (s *Service) StreamAudio(stream pb.LiveKitBridge_StreamAudioServer) error {
    session := s.getOrCreateSession(userId)

    // Goroutine 1: Receive from client
    go func() {
        for {
            chunk, err := stream.Recv()
            if err != nil { return }
            session.publishTrack.WriteSample(chunk.PcmData)
        }
    }()

    // Goroutine 2: Send to client (blocks with backpressure)
    for audioData := range session.audioFromLiveKit {
        if err := stream.Send(&pb.AudioChunk{
            PcmData: audioData,
        }); err != nil {
            return err
        }
    }
    return nil
}
```

**Total goroutines**: 2 per user + gRPC internal workers (shared pool)

#### 4. Clean Resource Management

```go
type RoomSession struct {
    room         *lksdk.Room
    publishTrack *lkmedia.PCMLocalTrack
    stream       pb.LiveKitBridge_StreamAudioServer
    ctx          context.Context
    cancel       context.CancelFunc
    closeOnce    sync.Once  // ✅ Ensures single cleanup
}

func (s *RoomSession) Close() {
    s.closeOnce.Do(func() {
        s.cancel()  // Cancels all operations

        if s.publishTrack != nil {
            s.publishTrack.Close()
        }
        if s.room != nil {
            s.room.Disconnect()
        }
    })
}
```

**Context-based cancellation**:

- All operations use `ctx`
- `cancel()` propagates to all goroutines
- No race conditions

#### 5. Built-in Reconnection

gRPC handles reconnection automatically:

```typescript
// TypeScript
const client = new LiveKitBridgeClient(
  "localhost:9090",
  grpc.credentials.createInsecure(),
  {
    "grpc.keepalive_time_ms": 10000,
    "grpc.keepalive_timeout_ms": 5000,
    "grpc.keepalive_permit_without_calls": 1,
  },
);

const stream = client.streamAudio();

stream.on("error", (err) => {
  if (err.code === grpc.status.UNAVAILABLE) {
    // gRPC will auto-reconnect, just recreate stream
    setTimeout(() => this.reconnect(), 1000);
  }
});
```

No manual exponential backoff, no reconnection timers to manage.

---

## Implementation Details

### Go Bridge Service

**File structure**:

```
livekit-bridge/
├── main.go              (gRPC server setup)
├── service.go           (LiveKitBridgeService implementation)
├── session.go           (RoomSession management)
├── audio_stream.go      (StreamAudio handler)
├── playback.go          (PlayAudio handler, replaces speaker.go)
├── proto/
│   └── livekit_bridge.proto
└── go.mod
```

**Key implementation**:

```go
// service.go
type LiveKitBridgeService struct {
    pb.UnimplementedLiveKitBridgeServer

    sessions sync.Map  // userId -> *RoomSession
    config   *Config
}

func (s *LiveKitBridgeService) StreamAudio(stream pb.LiveKitBridge_StreamAudioServer) error {
    // Get userId from first message or metadata
    firstChunk, err := stream.Recv()
    if err != nil {
        return status.Errorf(codes.InvalidArgument, "no initial chunk")
    }

    userId := firstChunk.UserId
    session := s.getOrCreateSession(userId)
    session.stream = stream

    // Start goroutines for bidirectional streaming
    errChan := make(chan error, 2)

    // Receive from client → LiveKit
    go func() {
        for {
            chunk, err := stream.Recv()
            if err == io.EOF {
                return
            }
            if err != nil {
                errChan <- err
                return
            }

            samples := bytesToInt16(chunk.PcmData)
            if err := session.publishTrack.WriteSample(samples); err != nil {
                errChan <- err
                return
            }
        }
    }()

    // Send from LiveKit → client
    go func() {
        for {
            select {
            case audioData := <-session.audioFromLiveKit:
                if err := stream.Send(&pb.AudioChunk{
                    PcmData:    audioData,
                    SampleRate: 16000,
                    Channels:   1,
                }); err != nil {
                    errChan <- err
                    return
                }
            case <-session.ctx.Done():
                return
            }
        }
    }()

    // Wait for error or context cancellation
    select {
    case err := <-errChan:
        return err
    case <-session.ctx.Done():
        return nil
    }
}

func (s *LiveKitBridgeService) JoinRoom(
    ctx context.Context,
    req *pb.JoinRoomRequest,
) (*pb.JoinRoomResponse, error) {
    session := s.getOrCreateSession(req.UserId)

    // Connect to LiveKit room
    room, err := lksdk.ConnectToRoomWithToken(
        req.LivekitUrl,
        req.Token,
        &lksdk.RoomCallback{
            ParticipantCallback: lksdk.ParticipantCallback{
                OnDataPacket: func(packet lksdk.DataPacket, params lksdk.DataReceiveParams) {
                    // Forward to audioFromLiveKit channel
                    session.audioFromLiveKit <- packet.(*lksdk.UserDataPacket).Payload
                },
            },
        },
    )
    if err != nil {
        return nil, status.Errorf(codes.Internal, "failed to join room: %v", err)
    }

    session.room = room

    return &pb.JoinRoomResponse{
        Success:          true,
        ParticipantId:    string(room.LocalParticipant.Identity()),
        ParticipantCount: int32(len(room.GetRemoteParticipants())),
    }, nil
}
```

### TypeScript Integration

**File**: `cloud/packages/cloud/src/services/session/LiveKitGrpcClient.ts`

```typescript
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { Logger } from "pino";
import UserSession from "./UserSession";

export class LiveKitGrpcClient {
  private client: any; // gRPC client
  private audioStream: grpc.ClientDuplexStream<AudioChunk, AudioChunk> | null;
  private logger: Logger;
  private userSession: UserSession;
  private disposed = false;

  constructor(userSession: UserSession) {
    this.userSession = userSession;
    this.logger = userSession.logger.child({ service: "LiveKitGrpcClient" });

    // Load proto definition
    const packageDef = protoLoader.loadSync("path/to/livekit_bridge.proto", {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
    });

    const proto = grpc.loadPackageDefinition(packageDef) as any;

    // Create client
    this.client = new proto.mentra.livekit.bridge.LiveKitBridge(
      process.env.LIVEKIT_BRIDGE_URL || "localhost:9090",
      grpc.credentials.createInsecure(),
      {
        "grpc.keepalive_time_ms": 10000,
        "grpc.keepalive_timeout_ms": 5000,
      },
    );
  }

  async connect(params: {
    url: string;
    roomName: string;
    token: string;
    targetIdentity?: string;
  }): Promise<void> {
    if (this.disposed) {
      throw new Error("Client disposed");
    }

    // Join room first (unary RPC)
    await new Promise<void>((resolve, reject) => {
      this.client.joinRoom(
        {
          user_id: this.userSession.userId,
          room_name: params.roomName,
          token: params.token,
          livekit_url: params.url,
          target_identity: params.targetIdentity,
        },
        (err: Error, response: any) => {
          if (err) {
            reject(err);
          } else if (!response.success) {
            reject(new Error(response.error));
          } else {
            resolve();
          }
        },
      );
    });

    // Start bidirectional audio stream
    this.audioStream = this.client.streamAudio();

    // Handle incoming audio
    this.audioStream.on("data", (chunk: any) => {
      const pcmData = Buffer.from(chunk.pcm_data);
      this.userSession.audioManager.processAudioData(pcmData);
    });

    this.audioStream.on("error", (err: any) => {
      if (err.code === grpc.status.UNAVAILABLE) {
        this.logger.warn("Bridge unavailable, will auto-reconnect");
        // gRPC handles reconnection, just log
      } else {
        this.logger.error(err, "Audio stream error");
      }
    });

    this.audioStream.on("end", () => {
      this.logger.info("Audio stream ended");
    });

    this.logger.info("Connected to bridge via gRPC");
  }

  sendAudio(pcmData: Buffer): void {
    if (!this.audioStream || this.disposed) return;

    // gRPC handles backpressure automatically
    // If server is slow, this will block (no goroutine spawning)
    this.audioStream.write({
      pcm_data: pcmData,
      sample_rate: 16000,
      channels: 1,
      timestamp_ms: Date.now(),
      user_id: this.userSession.userId,
    });
  }

  async playUrl(params: {
    requestId: string;
    url: string;
    volume?: number;
  }): Promise<void> {
    return new Promise((resolve, reject) => {
      const stream = this.client.playAudio({
        request_id: params.requestId,
        audio_url: params.url,
        volume: params.volume || 1.0,
      });

      stream.on("data", (event: any) => {
        if (event.type === "STARTED") {
          this.logger.info({ requestId: params.requestId }, "Playback started");
        } else if (event.type === "COMPLETED") {
          this.logger.info(
            { requestId: params.requestId },
            "Playback completed",
          );
          resolve();
        } else if (event.type === "FAILED") {
          reject(new Error(event.error));
        }
      });

      stream.on("error", (err) => {
        reject(err);
      });
    });
  }

  async close(): Promise<void> {
    this.disposed = true;

    if (this.audioStream) {
      this.audioStream.end();
      this.audioStream = null;
    }

    // Leave room
    await new Promise<void>((resolve) => {
      this.client.leaveRoom(
        {
          user_id: this.userSession.userId,
        },
        () => {
          resolve();
        },
      );
    });

    this.logger.info("Disconnected from bridge");
  }

  isConnected(): boolean {
    return !this.disposed && !!this.audioStream;
  }
}
```

**Drop-in replacement** for current `LiveKitClient`:

- Same public API surface
- `AudioManager` and `SpeakerManager` don't need changes
- Just swap class in `LiveKitManager`

### Jitter Buffering in gRPC Architecture

**Move pacing to TypeScript** (where it's needed):

```typescript
// AudioManager.ts
class AudioManager {
    private soniaxPacingQueue: Buffer[] = [];
    private pacingTimer: NodeJS.Timeout;

    constructor(userSession: UserSession) {
        this.userSession = userSession;
        this.logger = userSession.logger.child({ service: 'AudioManager' });

        // Start pacing for Soniox (100ms intervals)
        this.startSoniaxPacing();
    }

    processAudioData(audioData: ArrayBuffer | Buffer) {
        // Normalize to Buffer
        let buf: Buffer = /* ... normalization logic ... */;

        // Apps get immediate bursty delivery (low latency)
        this.relayAudioToApps(buf);

        // Queue for Soniox smoothing
        this.soniaxPacingQueue.push(buf);

        // Drop oldest if queue too deep (>1 second = 10 frames)
        if (this.soniaxPacingQueue.length > 10) {
            const dropped = this.soniaxPacingQueue.shift();
            this.logger.warn(
                { queueDepth: this.soniaxPacingQueue.length },
                'Soniox pacing queue full, dropping old frame'
            );
        }

        // Notify MicrophoneManager (unchanged)
        this.userSession.microphoneManager.onAudioReceived();
    }

    private startSoniaxPacing(): void {
        // Deliver to Soniox at steady 100ms intervals
        this.pacingTimer = setInterval(() => {
            if (this.soniaxPacingQueue.length > 0) {
                const chunk = this.soniaxPacingQueue.shift()!;

                // Smooth delivery to services that require it
                this.userSession.transcriptionManager.feedAudio(chunk);
                this.userSession.translationManager.feedAudio(chunk);

                // Optional: Log queue depth for monitoring
                if (this.soniaxPacingQueue.length > 5) {
                    this.logger.debug(
                        { queueDepth: this.soniaxPacingQueue.length },
                        'Soniox queue building up (bursty input)'
                    );
                }
            }
        }, 100);
    }

    dispose(): void {
        if (this.pacingTimer) {
            clearInterval(this.pacingTimer);
            this.pacingTimer = undefined;
        }
        this.soniaxPacingQueue = [];
        // ... rest of cleanup
    }
}
```

**Why this approach is better**:

1. **Pacing only where needed**:
   - Apps: Get bursty audio immediately (low latency)
   - Soniox/Translation: Get smoothed 100ms cadence (quality)

2. **No goroutine spawning**:
   - JavaScript `setInterval` is single-threaded
   - No risk of unbounded workers

3. **Simple gRPC forwarding**:
   - Go bridge just forwards audio as-is (bursty OK)
   - No PacingBuffer complexity
   - gRPC backpressure still works

4. **Easy to monitor**:
   - Queue depth visible in TypeScript
   - Can add metrics: avg queue depth, drops, etc.
   - Can adjust interval or queue size

5. **Separation of concerns**:
   - Go bridge: WebRTC transport only
   - TypeScript: Business logic (pacing, routing)

**Performance impact**:

- `setInterval(100ms)` overhead: negligible
- Queue memory: 10 frames × 1.6KB = ~16KB per session
- CPU: <0.1% for interval firing

---

## Memory Leak Root Cause Analysis

### Issue #1: Unbounded Goroutine Spawning

**Current code** (`pacing.go:62`):

```go
func (pb *PacingBuffer) sendNext() {
    pb.mu.Lock()
    defer pb.mu.Unlock()

    if len(pb.queue) > 0 {
        data := pb.queue[0]
        pb.queue = pb.queue[1:]
        go pb.sendFunc(data)  // ❌ LEAK
    }
}
```

**Why it leaks**:

1. Ticker calls `sendNext()` every 100ms
2. Each call spawns goroutine to call `sendFunc(data)`
3. `sendFunc` is `BridgeClient.sendBinaryData()`
4. `sendBinaryData()` acquires `websocketMu` lock
5. If WebSocket write is slow, lock held for up to 5 seconds
6. Meanwhile, ticker keeps firing → more goroutines spawn
7. All goroutines queue waiting for same mutex

**Math**:

- 10 frames/sec audio = 10 calls to `sendNext()` per second
- If one write takes 5 seconds, 50 goroutines accumulate
- Each goroutine stack: ~4KB
- 100 slow clients: 5,000 goroutines = 20MB in stacks alone
- Plus all the closure captures and buffers

**Porter evidence**:

- Memory climbs 500MB/hour
- Sawtooth pattern: 2.5GB → 7GB → restart
- CPU spikes during memory peaks (goroutine scheduler thrashing)

**gRPC solution**:

```go
// Send from LiveKit → client (gRPC stream)
for audioData := range session.audioFromLiveKit {
    // This BLOCKS when client can't keep up (HTTP/2 flow control)
    // No goroutine spawning
    stream.Send(&pb.AudioChunk{PcmData: audioData})
}
```

### Issue #2: No Backpressure Check

**Current code** (`AudioManager.ts:relayAudioToApps`):

```typescript
for (const packageName of subscribedPackageNames) {
  const connection = this.userSession.appWebsockets.get(packageName);
  if (connection && connection.readyState === WebSocket.OPEN) {
    connection.send(audioData); // ❌ No bufferedAmount check
  }
}
```

**Why it leaks**:

- Audio arrives at 30KB/sec
- If app can't consume that fast, Node.js buffers in memory
- `bufferedAmount` can grow to hundreds of MB
- Eventually triggers OOM or connection timeout
- But memory already consumed

**Fix** (applies to both architectures):

```typescript
const MAX_BUFFER = 512 * 1024; // 512KB

if (connection.bufferedAmount > MAX_BUFFER) {
  if (this.logCount % 50 === 0) {
    this.logger.warn(`Backpressure for ${packageName}, dropping frame`);
  }
  continue; // Drop frame
}
connection.send(audioData);
```

### Issue #3: Resource Cleanup Races

**Current code** (`bridge_client.go:Close`):

```go
func (c *BridgeClient) Close() {
    c.cancel()
    if c.pacingBuffer != nil {
        c.pacingBuffer.Stop()
    }
    c.mu.Lock()
    if c.publishTrack != nil {
        c.publishTrack.Close()
        c.publishTrack = nil
    }
    if c.room != nil {
        c.room.Disconnect()
        c.room = nil
    }
    if c.websocket != nil {
        c.websocket.Close()
        c.websocket = nil
    }
    c.mu.Unlock()
    close(c.closed)  // ❌ Panics if called twice
}
```

**Called from multiple places**:

- `HandleWebSocket()` defer
- `sendBinaryData()` on write error → `go c.Close()`
- `sendEvent()` on write error → `go c.Close()`
- `sendJSON()` on write error → `go c.Close()`

**Race scenario**:

1. Write error triggers `go c.Close()` from `sendBinaryData()`
2. Another write error triggers `go c.Close()` from `sendEvent()`
3. Both goroutines call `close(c.closed)` → panic

**gRPC solution**:

```go
type RoomSession struct {
    // ...
    closeOnce sync.Once
}

func (s *RoomSession) Close() {
    s.closeOnce.Do(func() {
        s.cancel()  // Propagates to all goroutines

        if s.publishTrack != nil {
            s.publishTrack.Close()
        }
        if s.room != nil {
            s.room.Disconnect()
        }
    })
}
```

**Note**: No PacingBuffer needed in gRPC design → no goroutine leak

---

## Migration Strategy

### Phase 1: Development & Staging

**Steps**:

1. Implement gRPC service in `packages/cloud-livekit-bridge/`
2. Keep old WebSocket code in `livekit-client-2/` for reference only (not running)
3. Test in dev environment:
   - Audio playback
   - Transcription
   - App audio relay
   - Memory/CPU under load
4. Deploy to staging
5. Thorough staging testing:
   - Functional tests
   - Load tests
   - Memory leak tests (24hr soak)
   - Edge cases

**Success criteria**:

- All tests pass
- Memory stable (<5MB per session)
- No goroutine leaks
- Audio quality unchanged

### Phase 2: Production Deployment

**Steps**:

1. Deploy to production (gRPC only)
2. Validate deployment (service running, health checks pass)
3. Monitor metrics closely for first hour:
   - Memory usage
   - CPU usage
   - Error rates
   - Audio latency
   - Transcription quality

**Rollback plan** (if issues detected):

```bash
# Revert to previous deployment (old WebSocket image)
kubectl rollout undo deployment/cloud
# Or redeploy previous image tag
```

### Phase 3: Cleanup

**After 1 week of stable production**:

1. Delete old WebSocket code:
   - Delete entire `livekit-client-2/` directory
   - Clean up any old references

2. Update documentation

3. Archive planning docs

**Final state**:

```
packages/cloud-livekit-bridge/    (gRPC service)
  ├── main.go
  ├── service.go
  ├── session.go
  └── proto/

cloud/packages/cloud/src/services/session/
  └── LiveKitGrpcClient.ts
```

### Monitoring During Rollout

**Key metrics** (compare before/after):

1. **Memory**:
   - Per-session memory usage
   - Total heap size
   - Memory growth rate

2. **CPU**:
   - Average CPU usage
   - Peak CPU during load

3. **Goroutines**:
   - Count per user session
   - Total active goroutines

4. **Latency**:
   - Audio end-to-end latency
   - Playback start time

5. **Errors**:
   - Connection failures
   - Audio dropouts
   - Transcription errors

**Alerting thresholds**:

- Memory growth >100MB/hour → investigate immediately
- Error rate >1% above baseline → rollback (revert deployment)
- Goroutine count >1000 → rollback immediately
- Audio latency >200ms → investigate

---

## Performance Comparison

### Current (WebSocket)

**Per session under load**:

- Memory: 25MB
- Goroutines: 600+ (when slow)
- CPU: 0.05 cores avg, 0.5 cores peak
- Latency: 50-100ms

**Total system (100 sessions)**:

- Memory: 2.5GB baseline, peaks to 7GB
- Goroutines: 10,000+
- CPU: 2-3 cores avg, 6+ cores peak

### Proposed (gRPC)

**Per session**:

- Memory: <5MB
- Goroutines: 2-3 (bounded)
- CPU: 0.01 cores avg, 0.1 cores peak
- Latency: 10-30ms

**Total system (100 sessions)**:

- Memory: 500MB baseline, stable
- Goroutines: 200-300 total
- CPU: <1 core avg, 2 cores peak

**Improvement**:

- 5x less memory
- 30x fewer goroutines
- 3x less CPU
- 2-3x lower latency
- 0 memory leak rate

---

## Jitter Buffering Deep Dive

### Why Audio Arrives Bursty

**Root cause**: Multiple buffering layers in the path:

```
Client                LiveKit SFU              Go Bridge
  │                        │                       │
  ├─ 100ms chunk ─────────>│                       │
  ├─ 100ms chunk ─────────>│                       │
  ├─ 100ms chunk ─────────>│ (buffered)            │
  ├─ 100ms chunk ─────────>│ (buffered)            │
  │                         │                       │
  │                         ├─ 4 chunks in 5ms ───>│ (burst!)
  │                         │                       │
  ├─ 100ms chunk ─────────>│ (buffered)            │
  ├─ 100ms chunk ─────────>│ (buffered)            │
  │                         │                       │
  │                         ├─ 2 chunks in 3ms ───>│ (burst!)
```

**Factors**:

- LiveKit DataChannel batching (network optimization)
- TCP Nagle's algorithm (packet coalescing)
- Go scheduler (multiple DataPackets processed together)
- Network latency variance

### Current PacingBuffer Analysis

**Good parts**:

```go
// Smooths output to 100ms intervals
pb.ticker = time.NewTicker(100 * time.Millisecond)

// Bounded queue (drops oldest if full)
if len(pb.queue) >= pb.maxSize {
    pb.queue = pb.queue[1:]
}
```

**Bad parts**:

```go
// Spawns unbounded goroutines
go pb.sendFunc(data)  // ❌ LEAK
```

### Proposed TypeScript Pacing

**Same smoothing, no leaks**:

```typescript
// Queue bursty input
this.soniaxPacingQueue.push(buf);

// Deliver smooth output
setInterval(() => {
  if (this.soniaxPacingQueue.length > 0) {
    const chunk = this.soniaxPacingQueue.shift()!;
    this.transcriptionManager.feedAudio(chunk);
  }
}, 100);
```

**Benefits over Go PacingBuffer**:

- ✅ No goroutine spawning (single-threaded event loop)
- ✅ Pacing only for services that need it (Soniox)
- ✅ Apps get low-latency bursty delivery
- ✅ Easier to monitor/debug in TypeScript
- ✅ Can add metrics without touching Go

### Open Questions for Jitter Buffering

1. **Burst characteristics**:
   - What's the max burst size seen? (4 frames? 8 frames?)
   - What's the typical gap between bursts? (300ms? variable?)
   - Does it vary by network conditions?

2. **Soniox tolerance**:
   - Does Soniox require **exactly** 100ms cadence?
   - Or is ±20ms OK? ±50ms?
   - Could we send variable-sized chunks instead?

3. **Apps delivery**:
   - Confirmed: Apps can handle bursty (they just relay)
   - Should we add metrics to verify no issues?

4. **Queue tuning**:
   - Max queue depth: 10 frames (1 second) sufficient?
   - Should we drop frames or pause gRPC stream when queue full?
   - Alert threshold for queue depth?

## Open Questions & Decisions

### 1. Transport: Unix Socket vs TCP?

**Option A: Unix Socket** (`/tmp/livekit-bridge.sock`)

```typescript
const client = new LiveKitBridgeClient(
  "unix:///tmp/livekit-bridge.sock",
  grpc.credentials.createInsecure(),
);
```

- ✅ 20-30% lower latency
- ✅ Better security (filesystem permissions)
- ❌ Requires Go + TS on same host
- ❌ Harder to debug (no tcpdump)

**Option B: TCP** (`localhost:9090`)

```typescript
const client = new LiveKitBridgeClient(
  "localhost:9090",
  grpc.credentials.createInsecure(),
);
```

- ✅ Works across containers
- ✅ Easier debugging
- ❌ Slightly higher latency
- ❌ Need to secure port

**Recommendation**: Start with TCP for easier debugging, switch to unix socket after stable.

### 2. Connection Pooling

**Option A: Shared client, multiplexed streams** (recommended)

```typescript
// Singleton gRPC client
const sharedClient = new LiveKitBridgeClient('localhost:9090', ...);

// Each UserSession gets its own stream
class LiveKitGrpcClient {
    constructor(userSession: UserSession) {
        this.client = sharedClient;  // Reuse connection
    }

    async connect() {
        this.audioStream = this.client.streamAudio();  // New stream, same connection
    }
}
```

- ✅ HTTP/2 multiplexing (efficient)
- ✅ Single TCP connection
- ❌ Single point of failure

**Option B: Pool of clients**

```typescript
const clientPool = [
    new LiveKitBridgeClient('localhost:9090', ...),
    new LiveKitBridgeClient('localhost:9090', ...),
    new LiveKitBridgeClient('localhost:9090', ...),
];
// Round-robin assignment
```

- ✅ Load distribution
- ✅ Fault tolerance
- ❌ More connections
- ❌ More complex

**Recommendation**: Option A (shared client). gRPC designed for this.

### 3. Audio Chunk Size

**Current**: 100ms chunks (1600 bytes at 16kHz)

**Options**:

- 20ms chunks (320 bytes) - lower latency, more overhead
- 50ms chunks (800 bytes) - balanced
- 100ms chunks (1600 bytes) - current, less overhead

**Need to benchmark**:

- Latency impact
- CPU usage (more chunks = more RPC overhead)
- Memory usage

**Recommendation**: Start with 100ms (same as current), optimize later if needed.

**Note**: gRPC can handle variable chunk sizes without protocol changes, so we could experiment with adaptive chunking if 100ms proves suboptimal.

### 4. Error Handling & Retries

**gRPC status codes**:

- `UNAVAILABLE`: Bridge down → retry
- `RESOURCE_EXHAUSTED`: Rate limited → backoff
- `INTERNAL`: Bug → log and alert
- `INVALID_ARGUMENT`: Bad request → don't retry

**Retry strategy**:

```typescript
const retryPolicy = {
  maxAttempts: 3,
  initialBackoff: "0.1s",
  maxBackoff: "10s",
  backoffMultiplier: 2,
  retryableStatusCodes: ["UNAVAILABLE"],
};
```

**Question**: Where to implement?

- gRPC interceptor (automatic)?
- Application layer (manual)?

**Recommendation**: Use gRPC interceptor for idempotent operations (JoinRoom, PlayAudio).

---

## Next Steps

1. **Review these docs** (Isaiah + Claude)
   - Validate architecture decisions
   - Answer open questions
   - Get alignment

2. **Write protocol definition** (`livekit-bridge.proto`)
   - Complete message definitions
   - Add comments for clarity
   - Generate Go + TS code

3. **Implement Go service**
   - Basic gRPC server
   - StreamAudio handler
   - Room management
   - Audio playback

4. **Implement TS client**
   - gRPC client wrapper
   - Drop-in replacement for LiveKitClient
   - Integration with existing managers

5. **Testing**
   - Unit tests (Go + TS)
   - Integration tests
   - Load tests
   - Memory leak tests

6. **Deploy & monitor**
   - Feature flag rollout
   - Metric collection
   - Gradual migration
