# Protocol Buffer Usage Guide

Quick reference for implementing the LiveKit gRPC bridge protocol.

## Generation Commands

### Go

```bash
cd livekit-bridge
protoc --go_out=. --go_opt=paths=source_relative \
    --go-grpc_out=. --go-grpc_opt=paths=source_relative \
    proto/livekit_bridge.proto
```

Generates:

- `proto/livekit_bridge.pb.go` (message types)
- `proto/livekit_bridge_grpc.pb.go` (service stubs)

### TypeScript

```bash
cd cloud/packages/cloud
npm install -g grpc-tools

grpc_tools_node_protoc \
    --js_out=import_style=commonjs,binary:./src/generated \
    --grpc_out=grpc_js:./src/generated \
    --plugin=protoc-gen-grpc=`which grpc_tools_node_protoc_plugin` \
    ../../../issues/livekit-grpc/livekit_bridge.proto
```

Or use `@grpc/proto-loader` (runtime loading):

```typescript
import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";

const packageDef = protoLoader.loadSync("livekit_bridge.proto", {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});

const proto = grpc.loadPackageDefinition(packageDef);
```

## Message Examples

### AudioChunk

```typescript
// TypeScript
const chunk: AudioChunk = {
  pcm_data: Buffer.from(pcmData),
  sample_rate: 16000,
  channels: 1,
  timestamp_ms: Date.now(),
  user_id: "user-123",
};
```

```go
// Go
chunk := &pb.AudioChunk{
    PcmData:    pcmData,
    SampleRate: 16000,
    Channels:   1,
    TimestampMs: time.Now().UnixMilli(),
    UserId:     "user-123",
}
```

### JoinRoomRequest

```typescript
// TypeScript
const request: JoinRoomRequest = {
  user_id: "user-123",
  room_name: "user-123",
  token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  livekit_url: "wss://livekit.example.com",
  target_identity: "user-123",
};
```

```go
// Go
req := &pb.JoinRoomRequest{
    UserId:         "user-123",
    RoomName:       "user-123",
    Token:          "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    LivekitUrl:     "wss://livekit.example.com",
    TargetIdentity: "user-123",
}
```

### PlayAudioRequest

```typescript
// TypeScript
const request: PlayAudioRequest = {
  request_id: uuidv4(),
  audio_url: "https://example.com/sound.mp3",
  volume: 0.8,
  stop_other: true,
  user_id: "user-123",
};
```

## RPC Usage Examples

### StreamAudio (Bidirectional)

**TypeScript Client:**

```typescript
const stream = client.streamAudio();

// Send audio to room
stream.write({
  pcm_data: audioBuffer,
  sample_rate: 16000,
  channels: 1,
  timestamp_ms: Date.now(),
  user_id: this.userId,
});

// Receive audio from room
stream.on("data", (chunk: AudioChunk) => {
  const pcmData = Buffer.from(chunk.pcm_data);
  this.audioManager.processAudioData(pcmData);
});

stream.on("error", (err) => {
  console.error("Stream error:", err);
});

stream.on("end", () => {
  console.log("Stream ended");
});
```

**Go Server:**

```go
func (s *Service) StreamAudio(stream pb.LiveKitBridge_StreamAudioServer) error {
    // Get user ID from first message
    firstChunk, err := stream.Recv()
    if err != nil {
        return err
    }
    userId := firstChunk.UserId

    session := s.getOrCreateSession(userId)

    // Goroutine 1: Receive from client → LiveKit
    go func() {
        for {
            chunk, err := stream.Recv()
            if err == io.EOF {
                return
            }
            if err != nil {
                return
            }

            // Write to LiveKit track
            samples := bytesToInt16(chunk.PcmData)
            session.publishTrack.WriteSample(samples)
        }
    }()

    // Goroutine 2: Send from LiveKit → client
    for {
        select {
        case audioData := <-session.audioFromLiveKit:
            if err := stream.Send(&pb.AudioChunk{
                PcmData:    audioData,
                SampleRate: 16000,
                Channels:   1,
            }); err != nil {
                return err
            }
        case <-session.ctx.Done():
            return nil
        }
    }
}
```

### JoinRoom (Unary)

**TypeScript Client:**

```typescript
const response = await new Promise<JoinRoomResponse>((resolve, reject) => {
  client.joinRoom(request, (err, response) => {
    if (err) reject(err);
    else resolve(response);
  });
});

if (!response.success) {
  throw new Error(response.error);
}
```

**Go Server:**

```go
func (s *Service) JoinRoom(
    ctx context.Context,
    req *pb.JoinRoomRequest,
) (*pb.JoinRoomResponse, error) {
    room, err := lksdk.ConnectToRoomWithToken(
        req.LivekitUrl,
        req.Token,
        callbacks,
    )
    if err != nil {
        return &pb.JoinRoomResponse{
            Success: false,
            Error:   err.Error(),
        }, nil
    }

    return &pb.JoinRoomResponse{
        Success:          true,
        ParticipantId:    string(room.LocalParticipant.Identity()),
        ParticipantCount: int32(len(room.GetRemoteParticipants())),
    }, nil
}
```

### PlayAudio (Server Streaming)

**TypeScript Client:**

```typescript
const stream = client.playAudio(request);

stream.on("data", (event: PlayAudioEvent) => {
  switch (event.type) {
    case PlayAudioEvent.EventType.STARTED:
      console.log("Playback started");
      break;
    case PlayAudioEvent.EventType.PROGRESS:
      console.log(`Progress: ${event.position_ms}/${event.duration_ms}`);
      break;
    case PlayAudioEvent.EventType.COMPLETED:
      console.log("Playback completed");
      break;
    case PlayAudioEvent.EventType.FAILED:
      console.error("Playback failed:", event.error);
      break;
  }
});

stream.on("end", () => {
  console.log("Playback stream ended");
});
```

**Go Server:**

```go
func (s *Service) PlayAudio(
    req *pb.PlayAudioRequest,
    stream pb.LiveKitBridge_PlayAudioServer,
) error {
    // Send STARTED event
    stream.Send(&pb.PlayAudioEvent{
        Type:      pb.PlayAudioEvent_STARTED,
        RequestId: req.RequestId,
    })

    // Download and decode audio
    // ...

    // Send PROGRESS events periodically
    stream.Send(&pb.PlayAudioEvent{
        Type:       pb.PlayAudioEvent_PROGRESS,
        RequestId:  req.RequestId,
        PositionMs: currentPos,
        DurationMs: totalDuration,
    })

    // Send COMPLETED event
    return stream.Send(&pb.PlayAudioEvent{
        Type:       pb.PlayAudioEvent_COMPLETED,
        RequestId:  req.RequestId,
        DurationMs: totalDuration,
    })
}
```

## Error Handling

### gRPC Status Codes

```typescript
// TypeScript
import * as grpc from "@grpc/grpc-js";

stream.on("error", (err: any) => {
  switch (err.code) {
    case grpc.status.UNAVAILABLE:
      // Bridge service down, retry
      this.reconnect();
      break;
    case grpc.status.RESOURCE_EXHAUSTED:
      // Rate limited, backoff
      this.backoff();
      break;
    case grpc.status.INVALID_ARGUMENT:
      // Bad request, don't retry
      console.error("Invalid request:", err.message);
      break;
    default:
      console.error("gRPC error:", err);
  }
});
```

```go
// Go
import "google.golang.org/grpc/codes"
import "google.golang.org/grpc/status"

func (s *Service) JoinRoom(...) (*pb.JoinRoomResponse, error) {
    if req.UserId == "" {
        return nil, status.Errorf(codes.InvalidArgument, "user_id required")
    }

    room, err := connectToRoom(req)
    if err != nil {
        return nil, status.Errorf(codes.Internal, "failed to join room: %v", err)
    }

    return response, nil
}
```

## Testing

### TypeScript Unit Test

```typescript
import * as grpc from "@grpc/grpc-js";
import { LiveKitBridgeClient } from "./generated/livekit_bridge_grpc_pb";

describe("LiveKitGrpcClient", () => {
  let client: LiveKitBridgeClient;

  beforeEach(() => {
    client = new LiveKitBridgeClient(
      "localhost:9090",
      grpc.credentials.createInsecure(),
    );
  });

  it("should join room successfully", async () => {
    const response = await client.joinRoom(request);
    expect(response.success).toBe(true);
  });
});
```

### Go Unit Test

```go
import (
    "testing"
    pb "github.com/mentra/livekit-bridge/proto"
)

func TestJoinRoom(t *testing.T) {
    service := NewLiveKitBridgeService(config)

    req := &pb.JoinRoomRequest{
        UserId:   "test-user",
        RoomName: "test-room",
        Token:    "test-token",
    }

    resp, err := service.JoinRoom(context.Background(), req)
    if err != nil {
        t.Fatalf("JoinRoom failed: %v", err)
    }

    if !resp.Success {
        t.Errorf("Expected success, got error: %s", resp.Error)
    }
}
```

## Performance Considerations

### Audio Chunk Size

- Current: 100ms chunks = 1600 bytes at 16kHz
- Smaller chunks (20ms): Lower latency, more RPC overhead
- Larger chunks (200ms): Higher latency, less overhead
- **Recommendation**: Start with 100ms, benchmark later

### Backpressure

gRPC automatically handles backpressure via HTTP/2 flow control:

- `stream.Send()` blocks when client buffer full
- `stream.Recv()` blocks when no data available
- No manual buffering needed

### Connection Pooling

Share single gRPC client across all UserSessions:

```typescript
// Singleton pattern
class GrpcClientPool {
  private static instance: LiveKitBridgeClient;

  static getClient(): LiveKitBridgeClient {
    if (!this.instance) {
      this.instance = new LiveKitBridgeClient(
        "localhost:9090",
        grpc.credentials.createInsecure(),
      );
    }
    return this.instance;
  }
}

// Each session gets its own stream over shared connection
class LiveKitGrpcClient {
  constructor(userSession: UserSession) {
    this.client = GrpcClientPool.getClient();
  }

  async connect() {
    this.audioStream = this.client.streamAudio();
  }
}
```

## Monitoring

### Interceptors

```typescript
// TypeScript
const loggingInterceptor = (options, nextCall) => {
  return new grpc.InterceptingCall(nextCall(options), {
    start: (metadata, listener, next) => {
      console.log("RPC started:", options.method_definition.path);
      next(metadata, {
        ...listener,
        onReceiveStatus: (status, next) => {
          console.log("RPC completed:", status.code);
          next(status);
        },
      });
    },
  });
};

const client = new LiveKitBridgeClient(
  "localhost:9090",
  grpc.credentials.createInsecure(),
  { interceptors: [loggingInterceptor] },
);
```

```go
// Go
import "google.golang.org/grpc"

func loggingInterceptor(
    ctx context.Context,
    req interface{},
    info *grpc.UnaryServerInfo,
    handler grpc.UnaryHandler,
) (interface{}, error) {
    start := time.Now()
    resp, err := handler(ctx, req)
    log.Printf("%s took %v", info.FullMethod, time.Since(start))
    return resp, err
}

server := grpc.NewServer(
    grpc.UnaryInterceptor(loggingInterceptor),
)
```
