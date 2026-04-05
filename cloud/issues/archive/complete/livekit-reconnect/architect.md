# LiveKit Reconnect Architecture

Deterministic, low-churn reconnection that preserves healthy bridges during network blips and immediately fixes “kicked on region switch” failures.

## Quick Context

- Current: Reconnecting within the 60s grace window can reuse a session whose Go LiveKit bridge was kicked (duplicate identity) and never rejoins → no audio until grace cleanup.
- Proposed: On reconnect, Cloud asks the bridge if it’s still in the room; rejoin only if disconnected. No teardown of healthy bridges.

## Current System

- Glasses connect to Cloud (WebSocket).
- Cloud mints LiveKit tokens and starts a Go bridge which joins room as identity `cloud-agent:{userId}`.
- Audio path: Glasses → LiveKit SFU → Go Bridge → gRPC → Cloud (TS) → Translation/Apps.
- Grace period (60s): UserSession persists for quick reconnects; current flow doesn’t ensure bridge rejoin when it was kicked.

```
Glasses → LiveKit SFU → Go Bridge ↔ gRPC ↔ Cloud (TS) → Translation/Apps
            (room join)        (Unix socket/TCP)
```

## Problem (Observed)

- When switching servers (prod → debug → prod) inside grace:
  - LiveKit enforces one participant per identity → New server kicks the old server’s bridge.
  - Reconnect to the old server reuses zombie session; bridge remains disconnected and never rejoins.
  - No audio until grace timer disposes session and a new bridge is created.

## Proposed System (Selected)

- Bridge Status RPC on reconnect:
  - On reconnect AND LiveKit enabled, Cloud asks the bridge if it’s connected to the room.
  - If `connected == false` → Mint fresh token and rejoin room.
  - If `connected == true` → Do nothing (preserve healthy bridge).
- Add small backoff on rejoin attempts (2–5s) to avoid storms.
- High-signal logs for decisions and outcomes.
- Gated by a feature flag for safe rollout.

## Key Code Paths (where changes integrate)

- Reconnect handling:
  - `cloud/packages/cloud/src/services/websocket/websocket-glasses.service.ts` (handleConnectionInit)
  - `cloud/packages/cloud/src/services/session/UserSession.ts` (session lifecycle, grace period)
- LiveKit management:
  - `cloud/packages/cloud/src/services/session/livekit/LiveKitManager.ts` (mint tokens; start/stop bridge; new: getBridgeStatus, rejoinBridge, backoff)
  - `cloud/packages/cloud/src/services/session/livekit/LiveKitGrpcClient.ts` (new: getStatus RPC call; rejoin)
- Go bridge:
  - `cloud/packages/cloud-livekit-bridge/proto/livekit_bridge.proto` (new: GetStatus RPC)
  - `cloud/packages/cloud-livekit-bridge/service.go` (track room state; implement GetStatus)
  - `cloud/packages/cloud-livekit-bridge/session.go` (room session fields for connectivity/last disconnect)

## API Additions (Go gRPC)

- `GetStatus(BridgeStatusRequest) → BridgeStatusResponse`
  - Request: `user_id: string`
  - Response:
    - `connected: bool`
    - `participant_id: string`
    - `participant_count: int32`
    - `last_disconnect_at: int64` (unix ms)
    - `last_disconnect_reason?: string` (best-effort)
    - `server_version?: string` (optional)

Bridge behavior:

- On successful JoinRoom: set `connected=true`, populate `participant_id`, `participant_count`.
- On OnDisconnected: set `connected=false`, capture `last_disconnect_at`, optional `reason` if available.

## Cloud TypeScript Changes

- `LiveKitGrpcClient.ts`
  - Add `getStatus(userId): Promise<BridgeStatusResponse>`
  - Add `rejoin(params): Promise<void>` (JoinRoom with fresh agent-bridge token).
- `LiveKitManager.ts`
  - Persist last-known join params (url, roomName) when starting bridge subscriber.
  - Add `getBridgeStatus()` → client.getStatus(userId).
  - Add `rejoinBridge()` → mint fresh agent-bridge token and call client.rejoin.
  - Backoff guard: store `lastRejoinAttemptAt` and skip if too soon (2–5s).
- `websocket-glasses.service.ts` (handleConnectionInit)
  - On reconnect AND LiveKit enabled:
    - If feature flag ON: `status = liveKitManager.getBridgeStatus()`
    - If `!status.connected` → `liveKitManager.rejoinBridge()`
    - Else → keep alive (no teardown)

## Feature Flag & Config

- `LIVEKIT_RECONNECT_STATUS_CHECK=on|off` (default off initially).
- Endianness stays `LIVEKIT_PCM_ENDIAN=off` by default (no auto detection).

## Logging (Better Stack)

Emit structured info logs for:

- `reconnect_detected`: `{ reconnect: true, livekit_enabled }`
- `bridge_status`: `{ connected, participant_id, participant_count }`
- `decision`: `{ action: 'rejoin' | 'keep-alive' }`
- `rejoin_result`: `{ joined: true, participant_id, participant_count }` or error details

## Edge Cases & Handling

- Bridge binary not yet upgraded (no GetStatus RPC):
  - Fallback once: attempt rejoin with fresh token; log fallback.
- Rejoin failure (network/token):
  - Log and respect backoff before retrying.
- Optional v2: TS audio-flow watchdog (if active subscriptions and no audio for N seconds, query status and rejoin if needed).

## Alternatives Considered (and why not)

- Always reinitialize on reconnect:
  - Simple but wasteful; penalizes ordinary blips with 1–2s restarts.
- Dispose bridge on grace-period entry:
  - Defeats grace; forces reinit for trivial disconnects.
- LiveKit webhooks to detect duplicate identity:
  - Ambiguous across regions (can’t tell “we were kicked” vs “we kicked them”).
- Per-server identities (`cloud-agent-prod:user`, `cloud-agent-debug:user`):
  - Avoids kicks but introduces multiple bridges in the room; coordination and cleanup complexity.

## Migration Strategy

1. Implement Go Status RPC + TS integration on a branch.
2. Enable the flag in debug; validate with prod→debug→prod within 60s:
   - Expect: reconnect triggers status, disconnected → rejoin → audio <2s.
   - Ordinary blips: connected → keep-alive (no reinit).
3. Enable flag in prod; monitor reconnection success/time-to-audio/errors/memory.
4. If stable, default flag ON and eventually remove it.

## Acceptance Criteria

- Reconnect back to a server within grace after switching away triggers immediate rejoin when needed (no wait for grace cleanup).
- Healthy bridges are preserved (no unnecessary reinit on regular blips).
- Time-to-audio on reconnect ≤ 2 seconds.
- High-signal logs confirm decisions and results.
