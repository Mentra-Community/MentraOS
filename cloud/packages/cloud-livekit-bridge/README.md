# LiveKit gRPC Bridge

Go service providing gRPC interface between TypeScript cloud and LiveKit rooms.

## What This Does

- Connects to LiveKit rooms via WebRTC (Go SDK)
- Provides gRPC API for TypeScript cloud service
- Handles bidirectional audio streaming
- Server-side audio playback (MP3/WAV → LiveKit track)

## Why Go

LiveKit TypeScript SDK can't publish custom PCM audio. Go SDK works perfectly.

## Architecture

```
TypeScript Cloud ←─ gRPC (Unix socket) ─→ Go Bridge ←─ WebRTC ─→ LiveKit SFU
```

## Running

```bash
# Build
go build -o livekit-bridge

# Run with Unix socket (recommended)
export LIVEKIT_GRPC_SOCKET=/tmp/livekit-bridge.sock
./livekit-bridge

# Run with TCP (fallback)
export PORT=9090
./livekit-bridge
```

## Environment Variables

```bash
# Connection mode (pick one)
LIVEKIT_GRPC_SOCKET=/path/to/socket  # Unix socket (preferred)
PORT=9090                             # TCP port (fallback)

# LiveKit connection
LIVEKIT_URL=wss://...
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...

# Optional
LOG_LEVEL=debug
```

## Testing

```bash
# Test Unix socket locally
./test-unix-socket.sh
```

## Protocol

See proto definition: `proto/livekit_bridge.proto`

For gRPC usage examples, see design docs: `../../issues/livekit-grpc/`

## Performance

Unix socket mode provides:

- 2-3x lower latency vs TCP localhost
- 10-20% less CPU usage
- No network exposure

## Key Metrics

| Metric                 | Target |
| ---------------------- | ------ |
| Memory per session     | <5MB   |
| Audio latency          | <50ms  |
| Goroutines per session | 2-3    |

---

**Design docs**: `../../issues/livekit-grpc/`
