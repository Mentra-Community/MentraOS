# LiveKit Reconnect Architecture

Deterministic, low-churn reconnection flow that preserves healthy LiveKit bridges during network blips while immediately fixing “kicked on region switch” failures.

## Current System

Client (glasses) connects to a Cloud server; Cloud mints LiveKit tokens and starts a Go LiveKit bridge that joins the user’s room with identity `cloud-agent:{userId}`. Audio flows from client → bridge → TypeScript services → apps.

- Audio path
  - Client → LiveKit SFU → Go Bridge (subscriber) → gRPC → TypeScript (Audio/Translation managers)
- Session lifecycle
  - On disconnect, a 60s grace period keeps the `UserSession` alive for quick reconnects.
  - On reconnect within grace, we currently reuse the session/managers without reinitializing LiveKit.

```
Glasses → LiveKit SFU → Go Bridge ↔ gRPC ↔ Cloud (TS) → Translation/Apps
            (room join)        (Unix socket/TCP)
```

## Key Code Paths

- Session + reconnection
  - cloud/packages/cloud/src/services/session/UserSession.ts
  - cloud/packages/cloud/src/services/websocket/websocket-glasses.service.ts (handleConnectionInit, grace-period)
- LiveKit management (TS)
  - cloud/packages/cloud/src/services/session/livekit/LiveKitManager.ts
  - cloud/packages/cloud/src/services/session/livekit/LiveKitGrpcClient.ts
- Go bridge (room join, audio relay)
  - cloud/packages/cloud-livekit-bridge/{main.go, service.go, session.go}
- Deployment/config (affects behavior across environments)
  - cloud/docker-compose.dev.yml
  - cloud/porter.yaml, cloud/porter-livekit.yaml

## The Problem (with evidence)

When a user quickly switches servers (prod → debug → prod) within the 60s grace window:

1. LiveKit enforces a single participant per identity; when a new server joins with the same identity, the old server’s bridge is kicked from the room.
2. If the user reconnects to the old server within grace, we reuse the zombie session (OK) but the bridge remains dead (never rejoins).
3. Result: No audio until the grace period expires and a new session/bridge is created.

Observed in logs:

- “Joined LiveKit room” on server B kicks server A’s bridge (same identity).
- Reconnect to server A (within grace) shows no “Joined LiveKit room” nor audio chunks.
- Waiting past grace forces cleanup → new bridge → audio works.

## Proposed System

On reconnect, ask the bridge if it’s still in the room. Rejoin only if disconnected.

- Bridge responsibility
  - Track room connectivity and expose a Status RPC (connected, participant_id, participant_count, last_disconnect_at, best-effort reason).
- Cloud responsibility
  - On glasses reconnect, if LiveKit is enabled for the session, call the bridge Status.
  - If `connected == false` → rejoin (mint fresh token, JoinRoom).
  - If `connected == true` → do nothing (preserve healthy bridge).
- Guardrails
  - Lightweight backoff for rejoin attempts (e.g., >= 2–5s apart).
  - High-signal logs for decisions and outcomes.
  - Feature flag to enable this behavior progressively.

Why this works

- Fixes the duplicate-identity “kicked” path deterministically without killing healthy sessions for ordinary network blips.
- Avoids cross-region ambiguity inherent in webhooks (“who kicked whom?”).
- Minimal code churn with clear observability.

## Key Changes

1. Go Bridge: add Status RPC

- Proto: `GetStatus(BridgeStatusRequest) → BridgeStatusResponse`
- State tracking:
  - Set `connected=true` on successful room join; capture `participant_id`, `participant_count`.
  - Set `connected=false` in `OnDisconnected`; capture `last_disconnect_at`, optional `reason` (best-effort).
- No behavior changes to audio; purely observability/control surface.

2. Cloud TS: conditional rejoin on reconnect

- LiveKitGrpcClient:
  - Add `getStatus(userId)`.
  - Add `rejoin(params)` to call JoinRoom again with a fresh token.
- LiveKitManager:
  - Persist last-known join parameters (url, roomName).
  - Add `getBridgeStatus()` and `rejoinBridge()` (mints a fresh agent-bridge token).
  - Add rejoin backoff (track `lastRejoinAttemptAt`).
- WebSocket reconnection hook:
  - In glasses `handleConnectionInit()`: if `reconnection === true` and LiveKit enabled, call `getBridgeStatus()`. Rejoin only if disconnected.

3. Feature flag + logs

- Env: `LIVEKIT_RECONNECT_STATUS_CHECK=on|off` (default off for rollout).
- Logs:
  - reconnect_detected
  - bridge_status (connected/participant_id/count)
  - decision (rejoin vs keep-alive)
  - rejoin_result (joined/error)

## Implementation Details

### Go Bridge (gRPC)

- Proto (new messages)
  - BridgeStatusRequest: { user_id: string }
  - BridgeStatusResponse: {
    connected: bool,
    participant_id: string,
    participant_count: int32,
    last_disconnect_at: int64, // unix ms
    last_disconnect_reason?: string, // best-effort
    server_version?: string
    }
- Service changes (service.go)
  - Maintain per-session fields on `RoomSession`:
    - connected bool
    - participantID string
    - participantCount int
    - lastDisconnectAt time.Time
    - lastDisconnectReason string
  - Set/update fields on JoinRoom success and OnDisconnected callback.
  - Implement GetStatus: look up session by user_id; return fields (connected=false if not found).

### Cloud (TypeScript)

- LiveKitGrpcClient.ts
  - `getStatus(userId): Promise<BridgeStatusResponse>`
  - `rejoin(params): Promise<void>` (calls JoinRoom with minted token)
- LiveKitManager.ts
  - Persist last `url` and `roomName` when starting the bridge subscriber.
  - `getBridgeStatus()` calls client.getStatus(userId).
  - `rejoinBridge()` mints a fresh agent bridge token and calls client.rejoin.
  - Backoff: store `lastRejoinAttemptAt`, skip rejoin if too soon.
- Websocket flow (glasses)
  - In `handleConnectionInit()` (reconnect path):
    - If LiveKit previously enabled (or `livekitRequested`):
      - If flag `LIVEKIT_RECONNECT_STATUS_CHECK=on`:
        - status = `liveKitManager.getBridgeStatus()`
        - If `!status.connected`: `liveKitManager.rejoinBridge()`
        - Else: keep alive
- Endianness
  - Keep default `LIVEKIT_PCM_ENDIAN=off` (no detection) to prevent random swaps.

### Logging (Better Stack)

Emit structured logs for:

- Reconnect detected: `{ reconnect: true, livekit_enabled: bool }`
- Bridge status: `{ connected, participant_id, participant_count }`
- Decision: `{ action: 'rejoin' | 'keep-alive' }`
- Result: `{ joined: true, participant_id, participant_count }` or error with stack/message

## Migration Strategy

1. Develop on branch (debug-only)

- Implement Go Status RPC + TS integration.
- Gate reconnection logic with feature flag (`LIVEKIT_RECONNECT_STATUS_CHECK=on` in debug).

2. Validate on debug

- Switch prod → debug → prod within 60s repeatedly:
  - Expect: prod reconnect triggers status check; if disconnected, rejoin; audio resumes <2s.
- Observe logs for decisions and outcomes.
- Verify ordinary blips don’t cause unnecessary reinit (connected=true → keep-alive).

3. Roll to prod

- Enable flag in prod.
- Monitor:
  - Reconnection success rate
  - Time-to-audio after reconnect (<2s target)
  - No increase in errors/memory usage

4. Stabilize and make default

- If stable for N days, default flag to on and remove flag later.

## Risks & Mitigations

- Bridge status false positives/negatives (stale state)
  - Mitigation: Status reflects room-level connectivity (not just gRPC). Optional: validate local participant in current room membership if available.
- Rejoin storms in unstable networks
  - Backoff guard + bounded retries.
- Old bridge binary without Status RPC
  - Fallback: single rejoin attempt; log fallback path and surface warning.

## Open Questions

- Do we want a push event from the bridge (OnDisconnected) to proactively mark state in Cloud? Not required for v1; status-on-reconnect is sufficient.
- Do we add an audio flow watchdog (TS): “expected audio but none for N seconds → query status → rejoin if down”? Useful safety net; can be v2.

## Acceptance Criteria

- Reconnecting back to a server within grace after switching away causes an immediate rejoin (no need to wait for grace cleanup).
- No unnecessary teardowns for normal network blips (healthy bridges are preserved).
- Time-to-audio on reconnect ≤ 2 seconds.
- High-signal logs clearly show reconnect, status, decision, and outcome.
