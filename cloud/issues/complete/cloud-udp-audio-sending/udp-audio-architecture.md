# UDP Audio Architecture (Bun-native)

## Previous System (udp-audio-sending branch)

```
Mobile App                  Go Bridge                    TypeScript Cloud
──────────                  ─────────                    ────────────────
    │                           │                              │
    │  WS: UDP_REGISTER ───────────────────────────────────►   │
    │  {userIdHash}             │                              │
    │                           │  ◄─── gRPC RegisterUdpUser   │
    │                           │       (hash→userId map)      │
    │                           │                              │
    │  UDP:8000 ───────────────►│                              │
    │  [hash|seq|PCM]           │                              │
    │                           │  ─── gRPC AudioStream ─────► │
    │                           │                              │
    │                           │                              ▼
    │                           │                        AudioManager
```

### Problems

1. **Two-process architecture** - Go and TypeScript must coordinate via gRPC
2. **gRPC streaming complexity** - Ping notifications require bidirectional stream management
3. **Latency overhead** - Every audio packet crosses process boundary
4. **Debugging difficulty** - Logs split between Go and TypeScript processes
5. **~350 lines of new Go code** - Added complexity to maintain

## New System (Bun-native)

```
Mobile App                          Bun Cloud
──────────                          ─────────
    │                                   │
    │  WS: UDP_REGISTER ───────────────►│ udpAudioManager.handleRegister()
    │  {userIdHash}                     │   → udpAudioServer.registerSession()
    │                                   │
    │  UDP:8000 ───────────────────────►│ UdpAudioServer.handlePacket()
    │  [hash|seq|PING]                  │   → session.udpAudioManager.sendPingAck()
    │                                   │
    │  WS: UDP_PING_ACK ◄───────────────│
    │                                   │
    │  UDP:8000 ───────────────────────►│ UdpAudioServer.handlePacket()
    │  [hash|seq|PCM]                   │   → session.audioManager.processAudioData()
    │                                   │
```

### Key Changes

1. **Single process** - UDP handled directly in Bun, no IPC
2. **No gRPC for UDP** - Registration and ping ack via WebSocket only
3. **Direct routing** - UDP packets go straight to AudioManager
4. **Unified logging** - All logs in one process
5. **Clean separation** - UdpAudioServer (transport) vs UdpAudioManager (per-session state)

## Component Overview

### UdpAudioServer (Global Singleton)

Location: `cloud/packages/cloud/src/services/udp/UdpAudioServer.ts`

Responsibilities:

- Bind UDP socket on port 8000
- Parse incoming packets (userIdHash, sequence, PCM/PING)
- Maintain userIdHash → UserSession mapping
- Route packets to appropriate session
- Track stats (packets received, dropped, pings)

```typescript
export class UdpAudioServer {
  private socket: any = null
  private sessionMap: Map<number, UserSession> = new Map()

  async start(): Promise<void> {
    this.socket = await Bun.udpSocket({
      port: 8000,
      socket: {
        data: (_socket, buf, port, addr) => {
          this.handlePacket(buf, port, addr)
        },
      },
    })
  }

  private handlePacket(buf: Buffer, port: number, addr: string): void {
    const userIdHash = buf.readUInt32BE(0)
    const sequence = buf.readUInt16BE(4)

    // Check for ping
    if (buf.length >= 10 && buf.slice(6, 10).toString() === "PING") {
      this.handlePing(userIdHash, addr, port)
      return
    }

    // Route audio to session
    const session = this.sessionMap.get(userIdHash)
    if (session) {
      session.audioManager.processAudioData(buf.slice(6))
    }
  }

  private handlePing(userIdHash: number, addr: string, port: number): void {
    const session = this.sessionMap.get(userIdHash)
    if (session) {
      session.udpAudioManager.sendPingAck()
    }
  }

  registerSession(userIdHash: number, session: UserSession): void {
    this.sessionMap.set(userIdHash, session)
  }

  unregisterSession(userIdHash: number): void {
    this.sessionMap.delete(userIdHash)
  }
}

export const udpAudioServer = new UdpAudioServer()
```

### UdpAudioManager (Per-Session)

Location: `cloud/packages/cloud/src/services/session/UdpAudioManager.ts`

Responsibilities:

- Handle UDP_REGISTER / UDP_UNREGISTER messages
- Manage session's UDP state (userIdHash, enabled)
- Send ping acknowledgments via WebSocket
- Cleanup on session disposal

```typescript
export class UdpAudioManager {
  private userSession: UserSession
  private _userIdHash?: number
  private _enabled = false

  constructor(userSession: UserSession) {
    this.userSession = userSession
  }

  handleRegister(message: UdpRegister): void {
    this._userIdHash = message.userIdHash
    this._enabled = true
    udpAudioServer.registerSession(message.userIdHash, this.userSession)
  }

  handleUnregister(message: UdpUnregister): void {
    udpAudioServer.unregisterSession(message.userIdHash)
    this._userIdHash = undefined
    this._enabled = false
  }

  sendPingAck(): void {
    this.userSession.websocket?.send(
      JSON.stringify({
        type: "udp_ping_ack",
        timestamp: Date.now(),
      }),
    )
  }

  dispose(): void {
    if (this._userIdHash !== undefined) {
      udpAudioServer.unregisterBySession(this.userSession)
    }
  }
}
```

### Integration Points

**glasses-message-handler.ts:**

```typescript
case GlassesToCloudMessageType.UDP_REGISTER:
  userSession.udpAudioManager.handleRegister(message);
  break;

case GlassesToCloudMessageType.UDP_UNREGISTER:
  userSession.udpAudioManager.handleUnregister(message);
  break;
```

**UserSession.ts:**

```typescript
// Declaration
public udpAudioManager: UdpAudioManager;

// Constructor
this.udpAudioManager = new UdpAudioManager(this);

// Dispose
if (this.udpAudioManager) this.udpAudioManager.dispose();
```

**index.ts:**

```typescript
import {udpAudioServer} from "./services/udp/UdpAudioServer"

// Startup
udpAudioServer.start()
```

## Packet Format

### Audio Packet (from mobile)

```
┌────────────────┬────────────────┬─────────────────────┐
│  userIdHash    │  sequence      │  PCM audio data     │
│  (4 bytes BE)  │  (2 bytes BE)  │  (variable)         │
└────────────────┴────────────────┴─────────────────────┘
```

### Ping Packet (from mobile)

```
┌────────────────┬────────────────┬──────────┐
│  userIdHash    │  sequence (0)  │  "PING"  │
│  (4 bytes BE)  │  (2 bytes BE)  │  (4 bytes)│
└────────────────┴────────────────┴──────────┘
```

- **userIdHash**: FNV-1a 32-bit hash of userId (big-endian)
- **sequence**: Rolling counter 0-65535 for packet ordering/loss detection
- **PCM data**: 16-bit signed little-endian mono audio at 16kHz

## Deployment

### Porter Configuration

```yaml
# cloud/porter.yaml
additionalPorts:
  - port: 8000
    protocol: UDP
    name: udp-audio
```

UDP port 8000 exposed on the Bun cloud pod (not Go bridge).

## Files Changed

### Removed (Go/gRPC)

| File                                                         | Lines |
| ------------------------------------------------------------ | ----- |
| `cloud-livekit-bridge/udp_audio.go`                          | -347  |
| `cloud-livekit-bridge/main.go` (UDP parts)                   | -32   |
| `cloud-livekit-bridge/service.go` (UDP parts)                | -64   |
| `cloud-livekit-bridge/proto/livekit_bridge.proto` (UDP RPCs) | -46   |
| `cloud/src/.../LiveKitGrpcClient.ts` (UDP methods)           | -141  |
| `cloud/src/.../LiveKitManager.ts` (UDP methods)              | -182  |

### Added (Bun-native)

| File                                            | Lines |
| ----------------------------------------------- | ----- |
| `cloud/src/services/udp/UdpAudioServer.ts`      | +287  |
| `cloud/src/services/udp/index.ts`               | +5    |
| `cloud/src/services/session/UdpAudioManager.ts` | +130  |

### Modified

| File                                                             | Change                    |
| ---------------------------------------------------------------- | ------------------------- |
| `cloud/src/index.ts`                                             | +11 (UDP server startup)  |
| `cloud/src/services/session/UserSession.ts`                      | +14 (manager integration) |
| `cloud/src/services/session/handlers/glasses-message-handler.ts` | Simplified handlers       |
| `cloud/porter.yaml`                                              | +4 (UDP port)             |
| `cloud/porter-dev.yaml`                                          | +4 (UDP port)             |

## Testing

1. **UDP path**: Mobile registers, sends ping, receives ack, sends audio
2. **LiveKit fallback**: When UDP unavailable (ngrok), falls back to LiveKit
3. **Existing path**: LiveKit audio playback (cloud → mobile) unchanged
4. **Cleanup**: Session disposal unregisters from UDP server
