# LiveKit Bridge Reconnection Bug

Go LiveKit bridge gets kicked from room when switching servers, never rejoins on reconnection within grace period.

## Documents

- **livekit-reconnect-spec.md** - Problem analysis, reproduction steps
- **livekit-reconnect-architecture.md** - Technical design for fix

## Quick Context

**Current**: User switches from cloud-prod → cloud-debug → cloud-prod within 60s = no audio (bridge dead)
**Proposed**: On reconnect, Cloud queries the bridge for room status; if disconnected → rejoin, if connected → keep session (no teardown)

## Key Context

When a user reconnects to a server within the grace period (60s), the UserSession reconnects successfully but the Go LiveKit bridge remains dead. This happens because LiveKit uses identity-based participant management: when cloud-debug's bridge joined with the same identity (`cloud-agent:isaiah@mentra.glass`), it kicked cloud-prod's bridge out of the room. On reconnection, cloud-prod's session is reused but the bridge never rejoins.

## Problem Reproduction

1. Connect to cloud-prod (works, audio flowing) ✅
2. Switch to cloud-debug within 60s (works, audio flowing, cloud-prod bridge kicked) ✅
3. Switch back to cloud-prod within 60s (broken, no audio) ❌
4. Wait 65s, switch back to cloud-prod (works, new session created) ✅

## Root Cause

- Grace period keeps cloud-prod session alive for 60s after disconnect
- LiveKit allows only ONE participant per identity per room
- cloud-debug's bridge joins with same identity → kicks cloud-prod's bridge out
- User reconnects to cloud-prod's zombie session
- Bridge is still dead from being kicked, never reinitializes
- TypeScript sees successful reconnection, doesn't know bridge is dead

## Relevant Files & Code Pointers

Core reconnection and LiveKit integration:

- `cloud/packages/cloud/src/services/session/UserSession.ts` — Session lifecycle, grace period timer (`cleanupTimerId`), reconnection path selection.
- `cloud/packages/cloud/src/services/session/livekit/LiveKitManager.ts` — LiveKit init/teardown; mints tokens; starts/stops the gRPC bridge client; `dispose()` and bridge re-init are key.
- `cloud/packages/cloud/src/services/session/livekit/LiveKitGrpcClient.ts` — gRPC audio bridging; connect/stream/dispose; endianness handling; logging for “Connected to LiveKit room via gRPC” and audio flow.
- `cloud/packages/cloud/src/services/session/translation/TranslationManager.ts` — Verifies downstream audio consumption and helps confirm “audio flowing” vs “no listeners”.

Switching/grace-period behavior touchpoints:

- `cloud/packages/cloud/src/api/middleware/client.middleware.ts` and `cloud/packages/cloud/src/middleware/client/client-auth-middleware.ts` — entry points where sessions are looked up/created on connect.
- `cloud/packages/cloud/src/services/websocket/websocket-glasses.service.ts` — Glasses WebSocket close/open handlers; where grace period typically begins.

Go bridge (for visibility and health when reproducing):

- `cloud/packages/cloud-livekit-bridge/main.go` — process bootstrap, health, listener.
- `cloud/packages/cloud-livekit-bridge/service.go` — JoinRoom/StreamAudio/LeaveRoom; logs to Better Stack via `logger/betterstack.go`.
- `cloud/packages/cloud-livekit-bridge/session.go` — room session lifecycle, publish track management.

Config and deployment (affects behavior across environments):

- `cloud/docker-compose.dev.yml` — local dev env vars (e.g., `LIVEKIT_GRPC_SOCKET`, `LIVEKIT_PCM_ENDIAN`).
- `cloud/porter.yaml` and `cloud/porter-livekit.yaml` — production/debug deploy env; ensure `LIVEKIT_PCM_ENDIAN` and bridge logging vars are set.

Log pipeline:

- `cloud/packages/cloud/src/services/logging/pino-logger.ts` — Better Stack transport and filtering.

## Selected Approach (Bridge status RPC on reconnect)

- On glasses reconnect (reconnection === true), if LiveKit was previously enabled:
  - Cloud asks the bridge for room status (connected, participant_id, participant_count, last_disconnect_at, last_disconnect_reason?).
  - If connected == false → mint fresh token and JoinRoom (rejoin).
  - If connected == true → do nothing (preserve the healthy bridge).

Why this:

- Avoids killing healthy bridges during ordinary network blips.
- Deterministic per-server (no cross-region confusion).
- Fixes the “kicked due to duplicate identity across servers” case immediately.

## Alternatives Considered

- Always reinitialize on reconnect:
  - Simple but wasteful; adds 1–2s delay and churn for normal blips where the bridge is healthy.
- Dispose bridge when entering grace period:
  - Defeats the benefit of grace; penalizes brief disconnects by forcing full reinit every time.
- LiveKit webhooks for duplicate identity:
  - Ambiguous in multi-server setups; hard to attribute if “we were kicked” vs “we kicked another server”. Useful for observability, not for control logic.
- Per-server identities (cloud-agent-prod:user, cloud-agent-debug:user):
  - Avoids LiveKit kicks but introduces multiple bridges in the room and coordination/cleanup complexity.

## Next Steps

- Add bridge Status RPC (or extend HealthCheck) to return:
  - connected: boolean, participant_id: string, participant_count: number,
  - last_disconnect_at: timestamp, last_disconnect_reason?: enum/string (best-effort).
- Update LiveKitManager reconnect path:
  - If reconnection && livekit previously enabled → call Status; rejoin only if disconnected.
  - Add concise logs: reconnect_detected, bridge_status, action_taken.
- Add basic rejoin backoff (e.g., once every 2–5 seconds per session) to avoid storms.
- Optional TS watchdog: if audio expected but none for N seconds, query Status and rejoin if needed.
- Test matrix: prod→debug→prod within grace; multiple rapid toggles; assert <2s time-to-audio and no unnecessary reinitialization.

## Status

- [x] Identified root cause (identity conflict + grace period)
- [x] Reproduced consistently
- [x] Documented in Better Stack logs
- [ ] Design solution
- [ ] Implement fix
- [ ] Test with rapid server switches
- [ ] Deploy to production

## Key Metrics

| Metric                        | Current                 | Target          |
| ----------------------------- | ----------------------- | --------------- |
| Reconnection success rate     | ~50% (timing-dependent) | 100%            |
| Time to audio after reconnect | ∞ (never works)         | <2s             |
| Grace period behavior         | Broken                  | Works correctly |

## Related Issues

- `cloud/issues/livekit-ios-bug/` - Original investigation that uncovered this
- LiveKit identity conflicts across servers
- Grace period cleanup behavior
