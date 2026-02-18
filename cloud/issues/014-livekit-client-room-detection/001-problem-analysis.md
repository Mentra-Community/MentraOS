# Problem Analysis: LiveKit Client Room Detection

## Summary

After a WebSocket reconnection, the mobile client may fail to rejoin the LiveKit room. The cloud has no way to detect this state, so audio silently stops flowing with no recovery mechanism.

## The Failure Scenario

```
1. User connected, everything working
   - Mobile WebSocket → Cloud ✓
   - Mobile → LiveKit room (publishing audio) ✓
   - Cloud bridge → LiveKit room (receiving audio) ✓

2. Network blip - Mobile WebSocket disconnects

3. Mobile WebSocket reconnects
   - Cloud: "Existing session found, updating WebSocket"
   - Cloud: "Bridge subscriber already connected"
   - Cloud sends CONNECTION_ACK with LiveKit info

4. Mobile receives CONNECTION_ACK
   - Calls livekit.connect()
   - livekit.connect() fails silently (network issue, race condition, etc.)
   - Mobile is NOT in LiveKit room

5. Result:
   - Cloud thinks everything is fine
   - Bridge is connected to LiveKit, waiting for audio
   - Mobile is NOT publishing to LiveKit
   - Audio silently drops
   - No recovery
```

## Evidence from Logs

```
21:12:48 | Received audio chunks from gRPC bridge     ← Audio flowing normally
21:12:49 | AudioManager received PCM chunk
21:13:12 | Received audio chunks from gRPC bridge
21:13:13 | AUDIO_CHUNK: no subscribed apps            ← Still receiving audio

21:13:36 | Glasses connection closed (1000)           ← WebSocket disconnect
21:13:36 | Existing session found, updating WebSocket ← Reconnect
21:13:36 | Bridge subscriber already connected        ← Cloud thinks OK
21:13:36 | Included LiveKit info in CONNECTION_ACK    ← Sent to mobile

         | ... silence ...                            ← No more audio chunks
         |                                            ← Mobile not in LiveKit room
```

## Mobile Client Code Analysis

### CONNECTION_ACK Handler

```typescript
// SocketComms.ts
private async handle_connection_ack(msg: any) {
  console.log("SOCKET: connection ack, connecting to livekit")
  const isChina = await useSettingsStore.getState().getSetting(SETTINGS.china_deployment.key)
  if (!isChina) {
    await livekit.connect()  // ← Called on EVERY CONNECTION_ACK
  }
  GlobalEventEmitter.emit("APP_STATE_CHANGE", msg)
}
```

### LiveKit Connect

```typescript
// Livekit.ts
public async connect() {
  if (this.room) {
    await this.room.disconnect()
    this.room = null
  }

  const res = await restComms.getLivekitUrlAndToken()  // ← REST call for fresh token
  if (res.is_error()) {
    console.error("LivekitManager: Error connecting to room", res.error)
    return  // ← Silent failure, no retry
  }

  const {url, token} = res.value
  this.room = new Room()
  await this.room.connect(url, token)  // ← Can fail

  this.room.on(RoomEvent.Disconnected, () => {
    console.log("LivekitManager: Disconnected from room")  // ← Just logs, no reconnect
  })
}
```

### Audio Publishing

```typescript
// MantleBridge.tsx
if (!isChinaDeployment && livekit.isRoomConnected()) {
  livekit.addPcm(bytes)
} else {
  socketComms.sendBinary(bytes)  // ← Falls back to WebSocket (China mode)
}

// Livekit.ts
public async addPcm(data: Uint8Array) {
  if (!this.room || this.room.state !== ConnectionState.Connected) {
    console.log("LivekitManager: Room not connected")  // ← Silent drop
    return
  }
  this.room?.localParticipant.publishData(data, {reliable: false})
}
```

## Why Cloud Can't Detect This

Currently, the cloud only knows:

1. WebSocket is connected ✓
2. Bridge is connected to LiveKit ✓
3. Bridge says it's subscribed to the target identity ✓

But the cloud does NOT know:

- Whether the mobile client is actually in the LiveKit room
- Whether audio is being published by the mobile

The bridge waits for audio from the target identity, but if that identity never joins, it just waits silently.

## Solution: Use LiveKit Server SDK

LiveKit provides a Server SDK that can query room state directly:

```typescript
import {RoomServiceClient} from "livekit-server-sdk"

const roomService = new RoomServiceClient(httpUrl, apiKey, apiSecret)
const participants = await roomService.listParticipants(roomName)

// Check if mobile client is in the room
const clientInRoom = participants.some((p) => p.identity === userId)
```

### Participant Identities

| Entity        | Identity                             | Present when working |
| ------------- | ------------------------------------ | -------------------- |
| Mobile client | `isaiahballah@gmail.com`             | ✓ Must be present    |
| Cloud bridge  | `cloud-agent:isaiahballah@gmail.com` | ✓ Usually present    |

If `clientInRoom === false` but bridge is connected and mic is enabled, we know the mobile failed to join.

## Implementation Plan

### Phase 1: Detection & Debug API

Add to `LiveKitManager`:

```typescript
async isClientInRoom(): Promise<boolean> {
  const httpUrl = this.livekitUrl.replace(/^wss?:\/\//, (m) =>
    m === "wss://" ? "https://" : "http://"
  );
  const roomService = new RoomServiceClient(httpUrl, this.apiKey, this.apiSecret);

  try {
    const participants = await roomService.listParticipants(this.getRoomName());
    return participants.some(p => p.identity === this.session.userId);
  } catch (err) {
    this.logger.error({ err }, "Failed to check if client in room");
    return false;
  }
}

async getRoomParticipants(): Promise<string[]> {
  // Similar, returns list of all participant identities
}
```

Add debug endpoint:

```
GET /api/client/livekit/room-status

{
  "roomName": "isaiahballah@gmail.com",
  "clientInRoom": false,
  "bridgeInRoom": true,
  "participants": ["cloud-agent:isaiahballah@gmail.com"],
  "micEnabled": true,
  "audioFlowing": false
}
```

### Phase 2: Auto-Recovery

When cloud detects:

- `micEnabled === true`
- `clientInRoom === false`
- No audio received for X seconds

Cloud sends `CONNECTION_ACK` to trigger mobile to reconnect to LiveKit.

This works because the mobile already calls `livekit.connect()` on every `CONNECTION_ACK`.

### Phase 3: Mobile-Side Fix (Separate Issue)

The proper fix is on mobile:

- Retry `livekit.connect()` on failure
- Auto-reconnect on `Disconnected` event
- Detect when audio is being dropped

But Phase 1 & 2 can be done entirely cloud-side without an app update.

## Open Questions

1. **How often to check `isClientInRoom()`?**
   - On every mic enable?
   - Periodically when mic is on but no audio?
   - Only on reconnection?

2. **Rate limiting for `CONNECTION_ACK` re-sends?**
   - Don't want to spam the client
   - Need backoff if client keeps failing to join

3. **Should we track "last audio received" timestamp?**
   - Would help detect "bridge connected but no audio" state
   - Could trigger check when audio stops

## Files to Modify

| File                                                            | Change                                          |
| --------------------------------------------------------------- | ----------------------------------------------- |
| `packages/cloud/src/services/session/livekit/LiveKitManager.ts` | Add `isClientInRoom()`, `getRoomParticipants()` |
| `packages/cloud/src/routes/client.routes.ts`                    | Add `/api/client/livekit/room-status` endpoint  |

## Timeline Estimate

| Task                              | Estimate |
| --------------------------------- | -------- |
| Add `isClientInRoom()` method     | 30 min   |
| Add debug API endpoint            | 30 min   |
| Test with actual failure scenario | 1 hour   |
| **Phase 1 Total**                 | ~2 hours |
