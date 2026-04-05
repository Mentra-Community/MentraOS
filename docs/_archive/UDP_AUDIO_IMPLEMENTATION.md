# UDP Audio Streaming - Implementation Guide

## Overview

UDP audio streaming provides low-latency, lossy audio transport as an alternative to LiveKit/WebSocket. This implementation includes automatic fallback to WebSocket when UDP is unavailable (e.g., local dev with ngrok).

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                           UDP AUDIO ARCHITECTURE                              │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  Mobile App                              Cloud (Go + TypeScript)              │
│  ─────────                               ──────────────────────               │
│      │                                         │                              │
│      │  1. WS: udp_register ─────────────────► │ (TS receives, calls gRPC)   │
│      │     {userIdHash: 12345}                 │                              │
│      │                                         ▼                              │
│      │                                   Go UDP Listener                      │
│      │                                   RegisterUser(hash, id)               │
│      │                                         │                              │
│      │  2. Mobile derives UDP endpoint         │                              │
│      │     from backend_url (same host:8000)   │                              │
│      │                                         │                              │
│      │  3. UDP ping ───────────────────────► :8000                           │
│      │     [hash(4) + seq(0) + "PING"]         │                              │
│      │                                         ▼                              │
│      │                                   Go detects ping                      │
│      │                                   Notifies TS via gRPC stream          │
│      │                                         │                              │
│      │  4. WS: udp_ping_ack ◄────────────────  │                              │
│      │                                         │                              │
│      │  5. UDP audio ──────────────────────► :8000                           │
│      │     [hash(4) + seq(2) + PCM data]       │                              │
│      │                                         ▼                              │
│      │                                   Go routes to session                 │
│      │                                   AudioManager.processAudioData()      │
│      │                                         │                              │
│      │                                         ▼                              │
│      │                                   Transcription, etc.                  │
│                                                                               │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Key Design Decision

**Mobile derives UDP endpoint from `backend_url`**: The mobile app already knows the backend URL (it uses it for WebSocket connection). For UDP, it simply uses the same hostname with port 8000. This eliminates the need for any additional environment variables or server-to-client endpoint configuration.

## Packet Format

### Audio Packet

```
┌────────────────┬────────────────┬─────────────────────┐
│  userIdHash    │  sequence      │  PCM audio data     │
│  (4 bytes)     │  (2 bytes)     │  (variable)         │
│  big-endian    │  big-endian    │                     │
└────────────────┴────────────────┴─────────────────────┘
```

### Ping Packet

```
┌────────────────┬────────────────┬──────────┐
│  userIdHash    │  sequence (0)  │  "PING"  │
│  (4 bytes)     │  (2 bytes)     │  (4 bytes)│
└────────────────┴────────────────┴──────────┘
```

- **userIdHash**: FNV-1a 32-bit hash of userId (computed identically on mobile and server)
- **sequence**: Rolling counter 0-65535 for detecting packet loss
- **"PING"**: ASCII magic bytes to identify probe packets

## Files Changed

### Go Bridge

| File                                                             | Description                                              |
| ---------------------------------------------------------------- | -------------------------------------------------------- |
| `cloud/packages/cloud-livekit-bridge/udp_audio.go`               | **NEW** - UDP listener, user registration, ping handling |
| `cloud/packages/cloud-livekit-bridge/service.go`                 | Added UDP fields and methods                             |
| `cloud/packages/cloud-livekit-bridge/main.go`                    | Start UDP listener on startup                            |
| `cloud/packages/cloud-livekit-bridge/proto/livekit_bridge.proto` | Added UDP RPCs                                           |

### TypeScript Cloud

| File                                                                            | Description                             |
| ------------------------------------------------------------------------------- | --------------------------------------- |
| `cloud/packages/cloud/src/services/session/livekit/LiveKitGrpcClient.ts`        | gRPC methods for UDP registration       |
| `cloud/packages/cloud/src/services/session/livekit/LiveKitManager.ts`           | UDP registration, ping subscription     |
| `cloud/packages/cloud/src/services/session/UserSession.ts`                      | `userIdHash`, `udpAudioEnabled` fields  |
| `cloud/packages/cloud/src/services/session/handlers/glasses-message-handler.ts` | Handle UDP_REGISTER/UNREGISTER messages |
| `cloud/packages/cloud/proto/livekit_bridge.proto`                               | Copied from bridge                      |

### SDK Types

| File                                                        | Description                           |
| ----------------------------------------------------------- | ------------------------------------- |
| `cloud/packages/sdk/src/types/message-types.ts`             | Added UDP message types               |
| `cloud/packages/sdk/src/types/messages/glasses-to-cloud.ts` | UdpRegister, UdpUnregister interfaces |
| `cloud/packages/sdk/src/types/messages/cloud-to-glasses.ts` | UdpPingAck interface                  |

### Android Native

| File                                                         | Description                                 |
| ------------------------------------------------------------ | ------------------------------------------- |
| `mobile/modules/core/android/.../services/UdpAudioSender.kt` | **NEW** - UDP sender                        |
| `mobile/modules/core/android/.../Bridge.kt`                  | UDP methods, routes audio to UDP when ready |
| `mobile/modules/core/android/.../CoreModule.kt`              | Expo module functions                       |

### iOS Native

| File                                                           | Description                                 |
| -------------------------------------------------------------- | ------------------------------------------- |
| `mobile/modules/core/ios/Source/services/UdpAudioSender.swift` | **NEW** - UDP sender                        |
| `mobile/modules/core/ios/Source/Bridge.swift`                  | UDP methods, routes audio to UDP when ready |
| `mobile/modules/core/ios/CoreModule.swift`                     | Expo module functions                       |

### React Native

| File                                 | Description                                                       |
| ------------------------------------ | ----------------------------------------------------------------- |
| `mobile/src/services/SocketComms.ts` | UDP probe, register/unregister, derives endpoint from backend_url |

### Deployment

| File                        | Description                        |
| --------------------------- | ---------------------------------- |
| `cloud/porter-livekit.yaml` | UDP port configuration (port 8000) |

## Deployment

### No Environment Variables Needed!

The mobile app derives the UDP endpoint from the existing `backend_url` setting:

- If `backend_url` is `https://cloud.augmentos.org`, UDP goes to `cloud.augmentos.org:8000`
- If `backend_url` is `https://staging.augmentos.org`, UDP goes to `staging.augmentos.org:8000`

### Porter Configuration

The `porter-livekit.yaml` already includes:

```yaml
additionalPorts:
  - port: 8000
    protocol: UDP
    name: udp-audio
```

### Steps to Deploy

1. **Push the code changes**
2. **Porter will build and deploy**
3. **The UDP LoadBalancer should be created automatically**

### Verify Deployment

- Check Porter logs for: `✅ UDP Audio Listener started on port 8000`
- Check that a UDP LoadBalancer was created in AKS on port 8000

## How It Works

### Mobile Flow

1. Mobile connects via WebSocket (existing flow)
2. On `connection_ack`, mobile triggers UDP registration:
   - Computes `userIdHash = FNV1a(userId)` (32-bit hash)
   - Derives UDP endpoint from `backend_url` (same host, port 8000)
   - Sends `{type: "udp_register", userIdHash: ...}` via WebSocket
3. Cloud registers the hash with Go bridge via gRPC
4. Mobile sends a UDP ping packet to test connectivity
5. If cloud sends `{type: "udp_ping_ack"}` within 2 seconds → use UDP
6. Otherwise → fallback to existing WebSocket

### Server Flow

1. Go UDP listener starts on port 8000
2. TypeScript cloud subscribes to UDP ping notifications via gRPC streaming
3. When mobile registers, TS tells Go the userIdHash → userId mapping
4. Go receives UDP packets, looks up userId by hash, forwards to session
5. When Go receives a ping, it notifies TS, which sends WebSocket ack

### Native Audio Routing

When audio data is generated by the mic:

1. Native code (Android/iOS) checks if UDP is ready (`UdpAudioSender.isReady()`)
2. If ready → sends via UDP (low latency)
3. If not ready → falls back to WebSocket (existing path)

## Fallback Behavior

UDP automatically falls back to WebSocket when:

- UDP ping times out (2 second timeout)
- Mobile is behind firewall that blocks UDP
- Local development with ngrok (no UDP support)

No code changes needed for fallback - it's automatic.

## Monitoring

Check Go bridge logs for:

```
UDP: Stats - received=1000, dropped=5, pings=3
UDP: Registered user abc123 with hash 12345
UDP: Ping received from user abc123 (hash 12345)
```

Check TypeScript logs for:

```
UDP register request received {userIdHash: 12345, feature: "udp-audio"}
UDP audio registered successfully
UDP ping received, sending WebSocket ack
```

## Rollback

If UDP causes issues:

1. **Quick disable on mobile:** Comment out `this.registerUdpAudio()` in `SocketComms.ts` `handle_connection_ack()`
2. **Full rollback:** Revert code changes, redeploy

## Security Notes

- `userIdHash` provides minimal obfuscation (not encryption)
- Acceptable for beta - attacker needs server IP, port, AND valid hash
- Future: Could add HMAC signatures if needed

## Testing Locally

With ngrok (no UDP support):

1. UDP probe will timeout after 2 seconds
2. Falls back to WebSocket automatically
3. Everything works as before

To test UDP locally:

1. Run cloud without ngrok on a machine mobile can reach directly
2. Make sure mobile's `backend_url` points to that machine's IP/hostname
3. Mobile should successfully probe UDP on port 8000
