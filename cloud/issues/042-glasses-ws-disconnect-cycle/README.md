# 042 — Glasses WebSocket Disconnect Cycle

Glasses WS connection drops every ~5–60 seconds with code 1000 (normal closure), reconnects, and repeats. Disrupts realtime audio streaming sessions because the SDK app's `onStop` fires on each disconnect.

## Documents

- This README covers the full investigation — no separate spec needed.

## Quick Context

**Observed**: Glasses WS closes (code 1000, empty reason), reconnects 5s later, cycle repeats. Discovered while debugging audio streaming (041). Each disconnect tears down any active SDK app session.

**Root cause**: The `cloud/sdk-hono` feature branch diverged from `dev` before issues 034/035 (WS liveness detection) were merged. The branch is missing both the server-side app-level pings and the mobile-side liveness monitor. Without app-level pings, multiple timeout mechanisms kill the connection.

**Fix**: Merge `dev` into `cloud/sdk-hono`. All fixes already exist on `dev`.

## Investigation

### Observed behavior

From cloud logs on `cloud/sdk-hono` branch:

```
13:43:54.066  UDP audio registered successfully
13:43:55.056  Glasses WebSocket closed (code: 1000, reason: "")
13:43:58.978  Heartbeat cleared for glasses connection
13:44:00.626  Existing session found, updating WebSocket (reconnection: true)
13:44:00.626  Heartbeat established for glasses connection
```

1 second between last successful message and disconnect. 5 seconds to reconnect. Cycle repeats.

### Branch comparison

| Feature | `cloud/sdk-hono` (stale) | `origin/dev` (current) |
|---|---|---|
| Server app-level pings (2s `{"type":"ping"}`) | ❌ Missing | ✅ `appLevelPingInterval` in `UserSession.ts` L237 |
| `PONG_TIMEOUT_ENABLED` | `true` (kills connections after 30s) | `false` (disabled) |
| Mobile liveness monitor (4s timeout) | ❌ Missing | ✅ `startLivenessMonitor()` in `WebSocketManager.ts` |
| Mobile `actuallyReconnect()` handles ERROR state | ❌ Only DISCONNECTED | ✅ Both DISCONNECTED and ERROR |
| Mobile `detachAndCloseSocket()` (null handlers before close) | ❌ Missing | ✅ Prevents stale `onclose` rogue reconnects |

### Why code 1000 (not 1001)?

Code 1000 = phone-initiated normal closure. Without server app-level pings, no app-level messages flow server→client between sporadic control messages. Multiple things can kill the connection:

1. **Cloudflare idle timeout (100s)** — no bidirectional traffic to keep it alive
2. **Cloud `PONG_TIMEOUT_ENABLED = true` (30s)** — server sends protocol-level pings, but Cloudflare absorbs the pongs before they reach the server. Server thinks phone is dead, closes with 1001. Phone receives this as 1000 (close handshake completes).
3. **nginx `proxy-send-timeout`** — if the nginx fix from 035 isn't in the branch's porter.yaml
4. **Phone OS / BLE state changes** — glasses BLE cycling triggers phone to restart the cloud WS

The dev branch fixes #1 and #2 by sending app-level pings every 2s (bypasses Cloudflare's pong absorption) and disabling `PONG_TIMEOUT_ENABLED`.

### Key files (on `origin/dev`)

**Cloud — server pings:**
- `cloud/packages/cloud/src/services/session/UserSession.ts` L237: `appLevelPingInterval` sends `{"type":"ping"}` every 2s
- `cloud/packages/cloud/src/services/session/UserSession.ts` L148: `PONG_TIMEOUT_ENABLED = false`

**Mobile — liveness detection:**
- `mobile/src/services/WebSocketManager.ts`: `startLivenessMonitor()`, `stopLivenessMonitor()`, `detachAndCloseSocket()`, `lastMessageTime` tracking, 4s `LIVENESS_TIMEOUT_MS`

**Cloud — pong responder:**
- Glasses WS message handler responds to `{"type":"ping"}` with `{"type":"pong"}`

## Impact on 041 (Audio Streaming)

Each disconnect cycle fires `onStop` in the SDK test app → `UserSession.remove(userId)` → kills the realtime AI session. This is why audio streaming appeared broken on the feature branch even after fixing the Gemini model name and stream creation ordering.

With the 034/035 fixes merged, the connection should be stable enough for multi-turn conversational AI sessions.

## Status

- [x] Root cause identified (branch divergence, missing 034/035 fixes)
- [x] Verified fixes exist on `origin/dev`
- [ ] Merge `dev` into `cloud/sdk-hono` (resolve conflicts in sdk/package.json, app/server/index.ts, types/index.ts)
- [ ] Verify glasses WS stays stable during a 5-minute realtime session
- [ ] Close this issue

## Related

- [034-ws-liveness](../034-ws-liveness/) — designed and implemented the app-level ping/pong
- [035-nginx-ws-timeout](../035-nginx-ws-timeout/) — extended nginx timeouts for WS paths
- [041-sdk-audio-output-streaming](../041-sdk-audio-output-streaming/) — where this was discovered