# LiveKit gRPC Bridge Specification

## Overview

Replace WebSocket-based IPC between Go LiveKit bridge and TypeScript cloud with gRPC bidirectional streaming.

**Why this exists**: LiveKit TS SDK for Node is broken (can't publish custom PCM). We need Go for WebRTC, but WebSocket is wrong tool for high-throughput IPC between services.

## Problem

### Current Architecture Issues

1. **Memory Leaks**
   - PacingBuffer spawns unbounded goroutines (600+ per slow client)
   - Each goroutine waits on blocked WebSocket write
   - Memory grows 500MB/hour under load
   - Porter metrics show sawtooth pattern: climb to 7GB → restart → repeat

2. **No Flow Control**
   - Audio streams at 30KB/sec (10 frames × 3KB)
   - No backpressure when TypeScript can't keep up
   - PacingBuffer drops frames or accumulates
   - Apps relay to slow WebSockets without checking `bufferedAmount`

3. **Resource Management Hell**
   - Multiple cleanup paths race (defer, error handlers, disposal)
   - `BridgeClient.Close()` can be called multiple times → panic
   - Async disposal not awaited in UserSession
   - Reconnection timers not canceled properly
   - Event listeners accumulate on TypeScript side

4. **WebSocket Wrong for IPC**
   - Designed for browser ↔ server, not service ↔ service
   - Manual framing, buffering, reconnection
   - No type safety (mixing JSON + binary)
   - Head-of-line blocking (control + data on same stream)

### Constraints

- **LiveKit TS SDK is broken**: Can't publish custom PCM via WebRTC track
- **Client uses DataChannel**: Client → Cloud audio via LiveKit DataChannel (workaround)
- **Cloud uses WebRTC Track**: Cloud → Client audio via real WebRTC publisher (works great)
- **Isaiah better at TypeScript**: Keep business logic in TS, Go only for LiveKit WebRTC
- **Zero downtime required**: Gradual migration with feature flags
- **Bursty audio delivery**: Client sends 100ms chunks steadily, but LiveKit/network delivers bursty (e.g., 4 chunks in 5ms, then 300ms gap). Soniox transcription requires smooth 100ms cadence, so jitter buffering needed.

## Goals

### Primary

1. **Fix memory leaks**: <5MB per session (currently 25MB), 0 leak rate (currently +500MB/hr)
2. **Automatic backpressure**: gRPC HTTP/2 flow control, no manual buffering
3. **Simplify Go bridge**: Remove WebSocket handling, PacingBuffer, reconnection logic
4. **Type safety**: Protocol buffers for all messages
5. **Better resource management**: Single cleanup path with `sync.Once`, proper context cancellation

### Secondary

1. **Lower latency**: 10-30ms (currently 50-100ms due to buffering)
2. **Fewer goroutines**: 2-3 per session (currently 600+ when slow)
3. **Better monitoring**: gRPC interceptors for automatic metrics
4. **Easier debugging**: Structured errors with status codes

### Success Metrics

| Metric                 | Current (WebSocket) | Target (gRPC) |
| ---------------------- | ------------------- | ------------- |
| Memory per session     | ~25MB               | <5MB          |
| Goroutines per session | 600+ (slow clients) | 2-3           |
| Memory leak rate       | +500MB/hour         | ~0            |
| Audio latency          | 50-100ms            | 10-30ms       |
| CPU usage (5 users)    | 2-3 cores           | <1 core       |
| Reconnection time      | 8-30 seconds        | <2 seconds    |

## Non-Goals

1. **Not fixing LiveKit TS SDK**: Out of scope, would require forking upstream
2. **Not changing client-side LiveKit**: Mobile/glasses still use LiveKit SDK as-is
3. **Not migrating Apps to gRPC**: Apps still use WebSocket to cloud, only bridge ↔ cloud changes
4. **Not replacing LiveKit server**: Still using LiveKit SFU for WebRTC routing
5. **Not changing SDK API**: App developers see no changes to `session.audio.playAudio()` etc.

## Audio Flow Paths (for context)

### Forward Path: Client → Cloud → Apps

```
Client (glasses/mobile)
  └─> Publishes PCM via LiveKit DataChannel (SDK limitation workaround)
        └─> LiveKit Room receives DataPackets
              └─> Go Bridge subscribes to room
                    └─> [gRPC bidirectional stream] (NEW)
                          └─> TypeScript LiveKitClient receives
                                └─> AudioManager.processAudioData()
                                      ├─> TranscriptionManager (Soniox)
                                      ├─> TranslationManager
                                      └─> Apps (relay via WebSocket)
```

### Reverse Path: Apps → Cloud → Client

```
App calls session.audio.playAudio({ audioUrl })
  └─> SDK sends AUDIO_PLAY_REQUEST via WebSocket
        └─> Cloud AppWebSocketService receives
              ├─> Forward to client glasses (client-side playback)
              └─> SpeakerManager.start()
                    └─> [gRPC unary call] (NEW)
                          └─> Go Bridge Publisher
                                ├─> HTTP GET audio file
                                ├─> Decode MP3/WAV
                                ├─> Resample to 16kHz
                                └─> Publish to LiveKit track (WebRTC)
                                      └─> Client receives via WebRTC
```

### TTS Path: App → Cloud → ElevenLabs → Client

```
App calls session.audio.speak("hello world")
  └─> SDK generates TTS URL: /api/tts?text=hello+world
        └─> TypeScript HTTP handler
              ├─> Call ElevenLabs API
              ├─> Stream MP3 response back
              └─> App receives URL, calls playAudio()
                    └─> (follows Reverse Path above)
```

## Technical Requirements

### Protocol Definition

- Use Protocol Buffers v3
- Separate control plane (unary RPCs) from data plane (streams)
- Support bidirectional audio streaming
- Include health check RPC

### Go Bridge Service

- Single gRPC server on port 9090 (or unix socket)
- One LiveKit room per UserSession
- Automatic reconnection via gRPC (no manual logic)
- Resource cleanup with `sync.Once`
- Context-based cancellation

### TypeScript Integration

- gRPC client shared across all UserSessions
- Each session gets its own bidirectional stream
- Connection pooling (HTTP/2 multiplexing)
- Drop-in replacement for current LiveKitClient class
- No changes to AudioManager, SpeakerManager APIs

### Migration Strategy

- Implement gRPC service in `packages/cloud-livekit-bridge/`
- Keep old WebSocket code in `livekit-client-2/` for reference only (not running)
- Test thoroughly in dev environment
- Deploy to staging, test thoroughly
- Deploy to production (gRPC only)
- Monitor memory, CPU, latency, error rates
- Rollback: Revert to previous deployment (old WebSocket image)
- After 1 week stable: Delete `livekit-client-2/`

## Jitter Buffering Requirements

### Problem

Client sends audio in steady 100ms chunks, but LiveKit/network causes **bursty delivery**:

- Example: 4 chunks arrive within 5ms → 300ms gap → 4 more chunks
- This breaks Soniox streaming transcription (expects steady cadence)

### Current Solution (WebSocket)

PacingBuffer in Go re-paces delivery to 100ms intervals:

```go
pb.ticker = time.NewTicker(100 * time.Millisecond)
// Smooths bursty input → steady output
```

**Problem**: Spawns unbounded goroutines → memory leak

### Proposed Solution (gRPC)

**Move pacing to TypeScript AudioManager**:

```typescript
class AudioManager {
  private soniaxPacingQueue: Buffer[] = [];

  processAudioData(audioData: Buffer) {
    // Receive bursty from gRPC (OK)
    this.relayAudioToApps(audioData); // Apps can handle bursty

    // Queue for Soniox smoothing
    this.soniaxPacingQueue.push(audioData);
  }

  private startSoniaxPacing() {
    setInterval(() => {
      if (this.soniaxPacingQueue.length > 0) {
        const chunk = this.soniaxPacingQueue.shift()!;
        this.transcriptionManager.feedAudio(chunk); // Smooth 100ms cadence
        this.translationManager.feedAudio(chunk);
      }
    }, 100);
  }
}
```

**Benefits**:

- ✅ Pacing only where needed (Soniox/translation)
- ✅ Apps get low-latency bursty delivery (they just relay)
- ✅ No Go goroutine spawning
- ✅ Easy to monitor/adjust in TypeScript
- ✅ gRPC does simple forwarding

**Question**: Can apps handle bursty audio or do they also need smoothing?

## Open Questions

1. **Unix socket vs TCP?** (localhost:9090 vs /tmp/livekit-bridge.sock)
   - Unix socket: 20-30% lower latency, better security
   - TCP: easier debugging, works if containers separate
   - **Decision needed**

2. **Single gRPC client or pool?**
   - Shared client with multiplexed streams (recommended)
   - Pool of clients for load distribution
   - **Leaning towards shared client**

3. **Audio chunk size?**
   - Current: 100ms chunks (1600 bytes at 16kHz)
   - gRPC optimal: 20ms chunks? 50ms?
   - **Need to benchmark**

4. **Jitter buffering details?**
   - Max burst size observed?
   - Do apps need smoothing or just Soniox?
   - Soniox tolerance (exactly 100ms or ±50ms OK)?
   - **Need to measure burst patterns**

5. **Error handling strategy?**
   - Retry logic in gRPC interceptor?
   - Circuit breaker pattern?
   - **TBD during implementation**

6. **Metrics collection?**
   - Prometheus interceptor?
   - Custom OpenTelemetry?
   - **Defer to monitoring doc**
