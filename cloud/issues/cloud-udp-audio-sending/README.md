# Cloud UDP Audio Sending (Bun-native)

Replace Go bridge UDP listener with Bun-native UDP for simpler architecture.

## Documents

- **udp-audio-spec.md** - Problem, goals, constraints
- **udp-audio-architecture.md** - Technical design

## Quick Context

**Before**: Mobile → UDP → Go bridge (port 8000) → gRPC → TypeScript cloud → AudioManager
**After**: Mobile → UDP → Bun UDP server (port 8000) → AudioManager (direct)

**Existing LiveKit path unchanged**: Mobile → LiveKit → Go bridge → gRPC → AudioManager (fallback)

## Key Insight

Bun has native UDP support via `Bun.udpSocket()`. We don't need Go code to receive UDP packets. This eliminates:

- The NEW Go UDP listener (`udp_audio.go` - ~350 lines)
- NEW gRPC calls for UDP registration/ping notifications
- IPC overhead between Go and TypeScript for UDP path

We **keep** the existing LiveKit bridge code for:

- Audio playback (cloud → mobile)
- Fallback audio path when UDP unavailable
- All existing gRPC audio streaming

The mobile-side implementation from `udp-audio-sending` branch is already complete and doesn't need changes.

## Architecture

```
UDP packet → UdpAudioServer (global) → lookup session by hash
                                     → audio: session.audioManager.processAudioData()
                                     → ping: session.udpAudioManager.sendPingAck()

WS UDP_REGISTER → glasses-message-handler → session.udpAudioManager.handleRegister()
                                          → udpAudioServer.registerSession()
```

### New Files

| File                                      | Description                                               |
| ----------------------------------------- | --------------------------------------------------------- |
| `src/services/udp/UdpAudioServer.ts`      | Global singleton, UDP socket on port 8000, packet routing |
| `src/services/udp/index.ts`               | Module exports                                            |
| `src/services/session/UdpAudioManager.ts` | Per-session manager, handles registration/state           |

## Status

### Revert Go/gRPC UDP code from PR #1770

- [x] Remove `cloud/packages/cloud-livekit-bridge/udp_audio.go`
- [x] Revert UDP changes in `main.go` (UDP listener startup)
- [x] Revert UDP changes in `service.go` (UDP fields/methods)
- [x] Remove UDP RPCs from `proto/livekit_bridge.proto`
- [x] Revert generated proto files

### Revert TypeScript gRPC UDP code

- [x] Revert `LiveKitGrpcClient.ts` UDP methods
- [x] Revert `LiveKitManager.ts` UDP methods

### Keep (don't revert)

- [x] SDK types (`UdpRegister`, `UdpUnregister`, `UdpPingAck`)
- [x] Other non-UDP changes from the branch

### Implement Bun UDP

- [x] Create `UdpAudioServer.ts` using `Bun.udpSocket()`
- [x] Create `UdpAudioManager.ts` (per-session manager)
- [x] Add session registration (userIdHash → UserSession map)
- [x] Handle UDP ping → WebSocket ack flow
- [x] Route audio to `AudioManager.processAudioData()`
- [x] Wire up WebSocket handlers for `UDP_REGISTER`/`UDP_UNREGISTER`
- [x] Add UDP port 8000 to porter.yaml

### Test

- [ ] Test UDP path with mobile client
- [ ] Verify LiveKit fallback still works
- [ ] Verify existing audio path unchanged

## Stats

- **Removed**: ~1690 lines (Go UDP code, gRPC methods)
- **Added**: ~420 lines (Bun UDP server, UdpAudioManager)
- **Net**: -1270 lines
