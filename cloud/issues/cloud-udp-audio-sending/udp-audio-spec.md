# UDP Audio Spec (Bun-native)

## Overview

Replace the Go-based UDP audio listener with a Bun-native implementation. Mobile clients send raw PCM audio over UDP for lowest latency. Previously this went through Go → gRPC → TypeScript. We eliminated the **new** Go UDP code entirely since Bun supports UDP natively.

**Important**: We keep the existing LiveKit bridge and audio code path. This is an alternative transport, not a replacement.

**Status**: ✅ Implemented

## Problem

The current `udp-audio-sending` branch introduces UDP audio streaming with this architecture:

```
Mobile → UDP:8000 → Go (udp_audio.go) → gRPC → TypeScript → AudioManager
```

This works, but:

1. **Unnecessary Go dependency** - We added ~350 lines of new Go code for UDP handling
2. **IPC overhead** - gRPC round-trips add latency and complexity
3. **Two processes** - More deployment surface, more failure modes
4. **Registration complexity** - userIdHash registration requires gRPC calls
5. **Ping notification complexity** - Go must notify TS via streaming gRPC when pings arrive

### New Go UDP Code to Remove

From `cloud/packages/cloud-livekit-bridge/udp_audio.go` (NEW file, ~350 lines):

- UDP listener on port 8000
- Packet parsing (userIdHash, sequence, PCM data)
- Ping detection and callback system
- User registration map (hash → userId)

New gRPC methods to remove from `livekit_bridge.proto`:

- `RegisterUdpUser`
- `UnregisterUdpUser`
- `SubscribeUdpPings`

### What We Keep

- **Existing LiveKit bridge** (`service.go`, `main.go` core functionality)
- **Existing gRPC audio streaming** (JoinRoom, StreamAudio, etc.)
- **Existing mobile LiveKit integration** (fallback path)
- **All existing AudioManager code paths**

### Constraints

- **Mobile implementation is done** - Android (`UdpAudioSender.kt`) and iOS (`UdpAudioSender.swift`) are already implemented
- **Packet format is fixed** - Can't change without mobile code changes:
  - Bytes 0-3: userIdHash (FNV-1a, big-endian)
  - Bytes 4-5: sequence number (big-endian)
  - Bytes 6+: PCM data (or "PING" for ping packets)
- **Port 8000** - Already configured in porter-livekit.yaml
- **Fallback to WebSocket/LiveKit** - Mobile falls back if UDP ping doesn't get ack within 2s
- **SDK types exist** - Keep `UdpRegister`, `UdpUnregister`, `UdpPingAck` message types (mobile uses them)

### Registration Flow (unchanged from mobile's perspective)

```
1. Mobile → WS: UDP_REGISTER {userIdHash: 12345}
   Cloud: udpAudioManager.handleRegister() → udpAudioServer.registerSession()

2. Mobile → UDP: [ping packet to port 8000]
   Cloud: udpAudioServer receives ping → session.udpAudioManager.sendPingAck()

3. Mobile receives ack → switches to UDP for audio
   (If no ack within 2s → falls back to LiveKit)

4. Mobile → UDP: [audio packets]
   Cloud: udpAudioServer → session.audioManager.processAudioData(pcm)
```

## Goals

1. **Single process for UDP** - UDP handling in the same Bun process as cloud server
2. **Direct routing** - UDP packets go straight to AudioManager, no IPC
3. **Same mobile protocol** - No changes to mobile code
4. **Lower latency** - Remove gRPC hop from audio path
5. **Keep LiveKit working** - Existing audio path remains as fallback

## Non-Goals

- **Changing packet format** - Mobile is already implemented
- **Removing LiveKit entirely** - Still used for audio playback cloud→mobile AND as fallback
- **Encrypting UDP packets** - userIdHash obfuscation is acceptable for beta
- **Removing existing Go bridge code** - Only removing the new UDP-specific additions

## Final Implementation

```
UDP Path:    Mobile → UDP:8000 → UdpAudioServer → AudioManager.processAudioData()
LiveKit Path: Mobile → LiveKit → Go bridge → gRPC → AudioManager (unchanged)
```

### New TypeScript Components

| Component         | Location                                  | Responsibility                               |
| ----------------- | ----------------------------------------- | -------------------------------------------- |
| `UdpAudioServer`  | `src/services/udp/UdpAudioServer.ts`      | Global singleton, UDP socket, packet routing |
| `UdpAudioManager` | `src/services/session/UdpAudioManager.ts` | Per-session state, registration, ping ack    |

### Go Changes (Reverted)

- ✅ Removed `udp_audio.go` (~350 lines)
- ✅ Removed UDP-related gRPC methods from proto
- ✅ Removed UDP startup code from `main.go`
- ✅ Removed UDP fields/methods from `service.go`
- ✅ **Kept all existing LiveKit bridge functionality**

### TypeScript Changes (Reverted)

- ✅ `LiveKitGrpcClient.ts` - removed UDP gRPC methods
- ✅ `LiveKitManager.ts` - removed UDP subscription methods

### SDK Types (Kept)

- ✅ `glasses-to-cloud.ts` - `UdpRegister`, `UdpUnregister` interfaces
- ✅ `cloud-to-glasses.ts` - `UdpPingAck` interface
- ✅ `message-types.ts` - UDP message type enums

## Notes

### userIdHash Collision Probability

We use a 4-byte (32-bit) FNV-1a hash of userId to identify UDP packets. Collision probability:

| Concurrent Users | Collision Probability |
| ---------------- | --------------------- |
| 1,000            | ~0.01%                |
| 10,000           | ~1.2%                 |
| 50,000           | ~25%                  |

**Acceptable for beta** with <10k concurrent users. Worst case on collision: audio from user A routes to user B's session (garbled transcription, not a security breach).

**If we scale to 50k+ concurrent UDP users**, consider:

- Check for existing hash on registration, reject duplicates
- Upgrade to 8-byte hash (requires mobile changes)

## Resolved Decisions

1. **Bun UDP API stability?**
   - ✅ Using `Bun.udpSocket()` - simple and works
   - Fallback to Node's `dgram` available if needed

2. **Session lookup strategy?**
   - ✅ Option A: Global `Map<userIdHash, UserSession>` in UdpAudioServer
   - O(1) lookup on every packet

3. **Port 8000 exposure?**
   - ✅ Added to `porter.yaml` and `porter-dev.yaml`
   - Bun binds directly, Go bridge doesn't use this port

4. **Per-session state management?**
   - ✅ Created `UdpAudioManager` per-session manager
   - Follows pattern of other managers (AudioManager, MicrophoneManager)
   - Handles registration, state, ping ack, cleanup

5. **Graceful shutdown?**
   - ✅ `UdpAudioServer.stop()` closes socket and clears session map
   - `UdpAudioManager.dispose()` unregisters session on cleanup
