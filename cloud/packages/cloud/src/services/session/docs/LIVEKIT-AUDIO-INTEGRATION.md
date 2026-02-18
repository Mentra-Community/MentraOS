# LiveKit Audio Integration (Plan)

## Overview

We will offload audio transport to LiveKit (an open-source SFU/media server for WebRTC) while keeping our existing WebSocket control plane and app messaging intact. Clients publish microphone audio to a LiveKit room; a cloud-side media agent subscribes to those tracks and feeds PCM into our `TranscriptionManager`.

- Control plane: unchanged (WS for VAD, app control, transcription delivery)
- Media plane: LiveKit publish/subscribe (WebRTC)
- Benefits: lower latency, better NAT traversal and reconnection, multi-user scalability, simpler media fanout

## Components

- LiveKit server (Cloud recommended): identified by `LIVEKIT_URL`
- Admin creds (backend only): `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` for minting access tokens
- Access token: short-lived JWT granting room join + publish/subscribe
- Client SDK (mobile/glasses): connect + publish mic track
- Cloud media agent: connect + subscribe to mic track; provide PCM to `TranscriptionManager`

## Room and identity strategy

- `roomId`: derived from `UserSession` (e.g., the `userId` or `userId:<timestamp>` for uniqueness)
- Client identity: `userId`
- Agent identity: `cloud-agent:<userId>` (or a single privileged agent process)
- Track naming: client publishes track named `mic` (metadata may include model & codec)

## Backend changes (cloud)

### 1) LiveKitTokenService

- Purpose: mint access tokens with specific grants
- Grants (examples):
  - Client: `roomJoin: true`, `canPublish: true` (no subscribe)
  - Agent: `roomJoin: true`, `canSubscribe: true` (no publish)
- Scope tokens by `roomId` and identity
- TTL: short (minutes)

### 2) LiveKitSessionManager

- Purpose: map `UserSession` → `roomId` and coordinate publish/subscribe lifecycle
- On WS connect:
  - Generate client publish token and send to client over WS
  - Optionally instruct when to start/stop publishing based on VAD
- On WS disconnect/dispose:
  - Mark session inactive; agent can leave room/stop subscription after a grace period

### 3) LiveKitMediaAgent

- Purpose: subscribe to client audio and feed PCM to `TranscriptionManager`
- Behavior:
  - Join `roomId` with subscribe-only token
  - Subscribe to track `mic` for `userId`
  - Receive audio frames (PCM float/int); resample to 16kHz mono 16-bit
  - Call `TranscriptionManager.feedAudio(ArrayBuffer)`
  - On VAD stop or inactivity, finalize tokens and optionally leave room

### 4) VAD & orchestration

- Option A (recommended start): keep current VAD flow via WS; use it to:
  - Notify client to (start/stop) publishing
  - Instruct agent to (join/leave) the room or (subscribe/unsubscribe)
- Option B (always-on): keep publish/subscribe active; simpler but uses more resources

## Client changes (glasses/mobile)

- After WS connect, request/receive LiveKit publish token and room info
- Connect to `LIVEKIT_URL` and `roomId`, then publish mic track (Opus/48k)
- Start/stop publish on VAD or remain always-on depending on orchestration
- No other changes needed; WS control plane and app logic unchanged

## Security

- Never expose `LIVEKIT_API_SECRET` to clients
- Client tokens: publish-only, room-scoped, short TTL
- Agent tokens: subscribe-only, room-scoped, or a privileged agent with enforced rules

## Testing flow

1. Backend: mint a publish token for a test user/room
2. Desktop/web LiveKit example: join room and publish mic
3. Cloud agent: join room with subscribe token and verify PCM arrives; confirm `TranscriptionManager` produces interims/finals
4. Wire mobile/glasses to publish instead of desktop

## Rollout plan

- Phase 0: Configure `.env` with `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`
- Phase 1: Implement `LiveKitTokenService` and `LiveKitSessionManager` (server)
- Phase 2: Implement `LiveKitMediaAgent` (server-side subscriber → PCM → `TranscriptionManager`)
- Phase 3: Integrate client publishing (glasses/mobile)
- Phase 4: Metrics, reconnection/backoff, fallback to WS PCM if needed
- Phase 5: Gradual rollout with feature flag; performance tuning

## Potential improvements

- Query-token fallback for WS auth: if a proxy strips Authorization, allow `?token=` fallback
- Better resampling (WASM soxr/speexdsp) for quality
- Multi-user rooms: add room-based transcription mixing or per-user subscriptions

## Example grants (pseudocode)

- Client publish token:

```
AccessToken {
  identity: userId,
  ttl: 300s,
  grants: {
    roomJoin: true,
    canPublish: true,
    canSubscribe: false,
    room: roomId
  }
}
```

- Agent subscribe token:

```
AccessToken {
  identity: `cloud-agent:${userId}`,
  ttl: 600s,
  grants: {
    roomJoin: true,
    canPublish: false,
    canSubscribe: true,
    room: roomId
  }
}
```

## Notes

- Using LiveKit Cloud simplifies TURN/STUN and scaling; self-hosting requires TURN setup for NAT traversal.
- Keep all app communication and subscription logic unchanged; only swap the media path.
