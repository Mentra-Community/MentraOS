# Client Disconnect Investigation

## Trigger

Users reporting: "my apps stopped", "captions disappeared", "glasses disconnected", or general connectivity complaints. Or: high `wsDisconnects` count in system-vitals.

## Quick Check (30 seconds)

```bash
bstack health
```

If all regions show `ok` with high uptime, the server is healthy. Client disconnects don't crash the server — they're handled gracefully via `createOrReconnect()`.

```bash
bstack sql "SELECT dt, JSONExtract(raw, 'wsDisconnects', 'Nullable(Int32)') as dc, JSONExtract(raw, 'wsReconnects', 'Nullable(Int32)') as rc, JSONExtract(raw, 'wsCloseCodeDist', 'Nullable(String)') as codes, JSONExtract(raw, 'activeSessions', 'Nullable(Int32)') as sessions FROM remote(t373499_mentracloud_prod_logs) WHERE dt >= now() - INTERVAL 10 MINUTE AND JSONExtract(raw, 'feature', 'Nullable(String)') = 'system-vitals' AND JSONExtract(raw, 'region', 'Nullable(String)') = 'us-central' ORDER BY dt DESC LIMIT 5"
```

Look at `codes` — if it's all `{"1006": N}`, that's client-side (abnormal closure, no close frame from client).

## Diagnose (2-5 minutes)

### Step 1: Check the close events — was the client silent before dying?

```bash
bstack sql "SELECT dt, JSONExtract(raw, 'code', 'Nullable(Int32)') as code, JSONExtract(raw, 'timeSinceLastClientMessage', 'Nullable(Int64)') as silent_ms, JSONExtract(raw, 'timeSinceLastAppPong', 'Nullable(Int64)') as pong_stale_ms, JSONExtract(raw, 'sessionDurationSeconds', 'Nullable(Int32)') as session_s, JSONExtract(raw, 'reconnectCount', 'Nullable(Int32)') as reconnects, JSONExtract(raw, 'userId', 'Nullable(String)') as userId FROM remote(t373499_mentracloud_prod_logs) WHERE dt >= now() - INTERVAL 1 HOUR AND JSONExtract(raw, 'feature', 'Nullable(String)') = 'ws-close' AND JSONExtract(raw, 'region', 'Nullable(String)') = 'us-central' ORDER BY dt DESC LIMIT 20"
```

This is the definitive proof:

| `silent_ms`            | `code` | Verdict                                                                                                                                                |
| ---------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| > 10,000 (10+ seconds) | 1006   | **CLIENT-SIDE.** Client stopped sending messages AND stopped responding to server pings. The server was sending pings every 2 seconds the entire time. |
| < 2,000 (< 2 seconds)  | 1006   | Possible server-side issue. The client was actively communicating right before the close. Investigate event loop gaps and GC probes at that timestamp. |
| Any                    | 1000   | Clean close — either side initiated properly. Check if the server was deploying (graceful shutdown sends 1001, client sees 1000).                      |
| Any                    | 1001   | Server going away — likely a deploy. Check deploy history.                                                                                             |

### Step 2: Identify the worst churners

```bash
bstack sql "SELECT JSONExtract(raw, 'userId', 'Nullable(String)') as userId, count() as disconnects, avg(JSONExtract(raw, 'timeSinceLastClientMessage', 'Nullable(Int64)')) as avg_silent_ms, avg(JSONExtract(raw, 'sessionDurationSeconds', 'Nullable(Int32)')) as avg_session_s, groupArray(JSONExtract(raw, 'code', 'Nullable(Int32)')) as codes FROM remote(t373499_mentracloud_prod_logs) WHERE dt >= now() - INTERVAL 1 HOUR AND JSONExtract(raw, 'feature', 'Nullable(String)') = 'ws-close' AND JSONExtract(raw, 'region', 'Nullable(String)') = 'us-central' GROUP BY userId ORDER BY disconnects DESC LIMIT 15"
```

If specific users disconnect 10-30 times per hour while others are stable for hours on the same server, the problem is user/device/network-specific, not server-side.

### Step 3: Check a specific user's disconnect/reconnect timeline

Replace the userId:

```bash
bstack sql "SELECT dt, JSONExtract(raw, 'message', 'Nullable(String)') as msg, JSONExtract(raw, 'code', 'Nullable(Int32)') as code FROM s3Cluster(primary, t373499_mentracloud_prod_s3) WHERE _row_type = 1 AND dt >= now() - INTERVAL 1 HOUR AND JSONExtract(raw, 'userId', 'Nullable(String)') = 'USER_EMAIL_HERE' AND JSONExtract(raw, 'region', 'Nullable(String)') = 'us-central' AND (JSONExtract(raw, 'message', 'Nullable(String)') LIKE '%closed%' OR JSONExtract(raw, 'message', 'Nullable(String)') LIKE '%opened%' OR JSONExtract(raw, 'message', 'Nullable(String)') LIKE '%reconnect%') ORDER BY dt LIMIT 50"
```

Look for patterns:

- **Exact cadence** (e.g., every 5 minutes) → client-side timer or deliberate close
- **Random intervals, all 1006** → network instability (cell tower handoff, WiFi flicker, app backgrounding)
- **Rapid cycle** (connect → disconnect in < 10 seconds) → client can't maintain connection, possibly bad network or Cloudflare killing it

### Step 4: Confirm the server was healthy at the time of disconnect

```bash
bstack diagnostics --region us-central --duration 30m
```

Check:

- Event loop gaps: **should be zero.** If there are gaps around the disconnect timestamps, the server contributed.
- GC probes: **should be < 100ms.** If > 100ms, the heap is large and GC is contributing to event loop pressure.
- Operation budget: **should be < 20%.** If higher, the event loop is overloaded.

### Step 5: Show stable vs unstable users on the same server

This is the strongest argument — same server, same code, same time window, different outcomes:

```bash
bstack sql "SELECT JSONExtract(raw, 'userId', 'Nullable(String)') as userId, JSONExtract(raw, 'sessionDurationSeconds', 'Nullable(Int32)') as duration_s, JSONExtract(raw, 'reconnectCount', 'Nullable(Int32)') as reconnects, JSONExtract(raw, 'lastCloseCode', 'Nullable(Int32)') as last_close FROM remote(t373499_mentracloud_prod_logs) WHERE dt >= now() - INTERVAL 1 HOUR AND JSONExtract(raw, 'feature', 'Nullable(String)') = 'ws-dispose' AND JSONExtract(raw, 'region', 'Nullable(String)') = 'us-central' ORDER BY reconnects DESC LIMIT 20"
```

If some users have `reconnects: 0, duration: 3600s` (stable for an hour) and others have `reconnects: 15, duration: 120s` (churning every 8 seconds), the server is not the problem.

## Fix

### If it's client-side (the common case)

The server handles reconnections gracefully. The issues users experience ("apps stopped") happen because:

1. Client's WebSocket dies (network loss, app backgrounded, cell handoff)
2. Client-side liveness monitor is **commented out** — takes 30-120 seconds to detect dead connection via OS TCP keepalive
3. Grace period expires (60 seconds) → session disposed → all apps stopped
4. Client reconnects → new session → apps restart from scratch

**Client-side fixes needed (mobile team):**

- Enable the liveness monitor in `WebSocketManager.ts` (detects dead connections in 4 seconds instead of 120)
- Add exponential backoff to reconnect interval (currently fixed 5 seconds forever)
- Add max retry cap with longer delays
- Differentiate close codes — don't reconnect on clean 1000 from server shutdown
- Wire up the dead `reconnectAttempts` counter

See: `cloud/issues/066-ws-disconnect-churn/spike.md` for the full mobile client audit.

### If it's server-side (rare after fixes)

If `timeSinceLastClientMessage < 2000` on the close events:

1. Check event loop gaps at that timestamp — was the server frozen?
2. Check if the `/health` endpoint was slow (search for `feature="health-timing"`)
3. Check if a GC pause occurred at that time (search for `feature="gc-probe"` with high `gcDurationMs`)
4. Check if the server was deploying (graceful shutdown sends close frames)

### If it's Cloudflare

If the BetterStack incident shows status 521 or 522, and the server vitals show no issues:

- Check [Cloudflare Status](https://www.cloudflarestatus.com/)
- Check if the disconnect pattern affects ALL users simultaneously (Cloudflare) vs specific users (client network)
- See runbook: `pod-crash.md` → "Check if it's Cloudflare"
- See issue 072 for a documented Cloudflare 521 example

## Verify

After investigating:

```bash
bstack health
bstack diagnostics --region us-central --duration 10m
```

Server should be healthy. If the user is still connected:

```bash
bstack sql "SELECT dt, JSONExtract(raw, 'service', 'Nullable(String)') as service, JSONExtract(raw, 'message', 'Nullable(String)') as message FROM remote(t373499_mentracloud_prod_logs) WHERE dt >= now() - INTERVAL 5 MINUTE AND JSONExtract(raw, 'userId', 'Nullable(String)') = 'USER_EMAIL_HERE' ORDER BY dt DESC LIMIT 10"
```

Should show active logs (display updates, audio stats, etc.) confirming the session is alive.

## Presenting Evidence to the Team

When someone says "the cloud is dropping connections," present this data:

1. **Close code distribution**: "100% of disconnects are code 1006 — the client dropped without a close frame. The server never produces 1006."
2. **Client silence duration**: "On every 1006 close, the client had been silent for 10-140 seconds. The server was sending pings every 2 seconds the entire time."
3. **Stable vs unstable users**: "On the same server, same code, same time: User A was stable for 2 hours. User B disconnected 30 times in 42 minutes. The difference is the client/network, not the server."
4. **Server health at disconnect time**: "Zero event loop gaps, GC probes at 30ms, operation budget at 5%. The server was healthy."

## Close Code Reference

| Code | Name             | Who sends it        | What it means                                                                                                       |
| ---- | ---------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1000 | Normal Closure   | Either side         | Clean, intentional close. Check if it was a deploy (server) or user action (client).                                |
| 1001 | Going Away       | Server              | Server is shutting down (deploy, graceful shutdown). Expected during deploys.                                       |
| 1006 | Abnormal Closure | Neither (TCP level) | No close frame was sent. The TCP connection died. Almost always client-side: network loss, app killed, phone sleep. |
| 1008 | Policy Violation | Server              | Server rejected the connection (e.g., "Session not found"). Usually app-ws ghost connections.                       |
| 1011 | Internal Error   | Server              | Server had an error processing the connection. Rare.                                                                |

## History

| Date      | Finding                                                         | Resolution                                                      |
| --------- | --------------------------------------------------------------- | --------------------------------------------------------------- |
| Mar 28-29 | Client liveness monitor commented out in mobile app             | Documented in issue 066. Mobile fix pending.                    |
| Mar 28-29 | 40% of closes are 1006, clients silent for 10-140s before death | Proved client-side with ws-close observability (issue 069).     |
| Mar 29    | nikita@ has exact 5-minute disconnect cycle (code 1000)         | Client-side timer or deliberate close every 300 seconds.        |
| Mar 29    | kddyqfr5hq@ disconnected 30 times in 42 minutes, all 1006       | Client network instability. Server reconnected them every time. |

## References

- [066 Spike: WS Disconnect Churn](../../issues/066-ws-disconnect-churn/spike.md) — full mobile client audit, liveness monitor disabled, no backoff
- [069 Spike: WS Disconnect Observability](../../issues/069-ws-disconnect-observability/spike.md) — the instrumentation that proves client-side issues
- [034 WS Liveness](../../issues/034-ws-liveness/) — server app-level pings, client liveness detection design
- [035 nginx WS Timeout](../../issues/035-nginx-ws-timeout/) — nginx/Cloudflare timeout fixes
