# LiveKit Client Room Detection

After WebSocket reconnection, the mobile client may fail to rejoin the LiveKit room, causing audio to silently stop flowing. The cloud needs to detect this state and trigger the client to reconnect.

## Documents

- **001-problem-analysis.md** - Root cause analysis and proposed solution

## Quick Context

**Current**: Mobile receives `CONNECTION_ACK` on reconnect → calls `livekit.connect()` → can fail silently → audio drops with no recovery.

**Problem**: Cloud thinks everything is fine ("bridge already connected"), but mobile client is not in the LiveKit room, so no audio flows.

**Fix**: Use LiveKit Server SDK to detect when client is missing from room, then send `CONNECTION_ACK` to trigger rejoin.

## Evidence

From logs (2025-12-19):

```
21:13:12 | Received audio chunks from gRPC bridge     ← Audio flowing
21:13:13 | AUDIO_CHUNK: no subscribed apps
21:13:36 | Glasses reconnected
21:13:36 | Bridge subscriber already connected        ← Cloud thinks OK
21:13:36 | Included LiveKit info in CONNECTION_ACK
         | ... no more audio chunks after this        ← Client not in room
```

## Root Cause

Mobile client's `livekit.connect()` can fail silently:

- No retry logic on failure
- `Disconnected` event handler just logs
- Audio silently dropped when room not connected

## Solution

### Phase 1: Detection (this issue)

- Add `isClientInRoom()` method using `RoomServiceClient.listParticipants()`
- Expose as debug API endpoint
- Log when client missing from room

### Phase 2: Auto-recovery (future)

- Cloud detects: no audio + client missing from room
- Cloud sends `CONNECTION_ACK` to trigger mobile reconnect
- Mobile already handles this (calls `livekit.connect()` on every ACK)

## Key Files

| File                                                            | Purpose                       |
| --------------------------------------------------------------- | ----------------------------- |
| `packages/cloud/src/services/session/livekit/LiveKitManager.ts` | Add `isClientInRoom()` method |
| `packages/cloud/src/routes/client.routes.ts`                    | Add debug endpoint            |

## Status

- [x] Problem identified
- [x] Root cause confirmed (mobile can fail to rejoin LiveKit)
- [x] Add `isClientInRoom()` using LiveKit Server SDK
- [x] Add `getRoomStatus()` for detailed debugging
- [x] Add debug API endpoint (`GET /api/client/livekit/room-status`)
- [ ] Test detection in production
- [ ] Phase 2: Auto-recovery via CONNECTION_ACK

## LiveKit Identities

| Entity        | Identity Format        | Example                              |
| ------------- | ---------------------- | ------------------------------------ |
| Mobile client | `{userId}`             | `isaiahballah@gmail.com`             |
| Cloud bridge  | `cloud-agent:{userId}` | `cloud-agent:isaiahballah@gmail.com` |
| Room name     | `{userId}`             | `isaiahballah@gmail.com`             |

## API Design

```
GET /api/client/livekit/room-status

Response:
{
  "roomName": "isaiahballah@gmail.com",
  "clientInRoom": false,
  "bridgeInRoom": true,
  "participants": ["cloud-agent:isaiahballah@gmail.com"]
}
```
