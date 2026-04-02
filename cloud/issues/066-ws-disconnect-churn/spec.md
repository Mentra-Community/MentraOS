# Spec: WebSocket Disconnect Churn — Cloud-Side Observability

## Overview

**What this doc covers:** Exact specification for adding diagnostic instrumentation to the cloud server that proves whether WebSocket disconnects are client-initiated or server-initiated. Seven new tracked fields on UserSession, two new structured log events (`ws-close` and `ws-reconnect`), connection churn counters in SystemVitalsLogger, and removal of the wasteful `gc-after-disconnect` feature.
**Why this doc exists:** The team has been told the disconnect churn is a client-side issue but there's no instrumented proof. The cloud currently cannot distinguish "client went dark" from "server killed the connection" because `lastClientMessageTime`, reconnect count, close code context, and downtime duration are not tracked. This spec adds the minimum instrumentation to produce definitive evidence.
**What you need to know first:** [066 spike](./spike.md) for the full investigation — client liveness monitor is commented out, 40% of closes are code 1006, session lifetimes cluster at 70–180s, and `disconnectedAt` is destroyed before anyone reads it.
**Who should read this:** Anyone reviewing the PR.

## The Problem in 30 Seconds

When a glasses WebSocket disconnects, we log the close code and reason — but not how long the client had been silent before the close, not how many times this session has reconnected, not how long the downtime lasted, and not whether the client was responding to our pings. The key line in `createOrReconnect()` clears `disconnectedAt` before computing the downtime gap. The result: we have 84 code-1006 close events in 6 hours and no way to prove whether the server or the client caused them.

This spec adds diagnostic-only instrumentation. Zero behavioral changes. No new features, no changed timeouts, no modified reconnect logic. Just data.

## Spec

### A1. New fields on UserSession

**File:** `packages/cloud/src/services/session/UserSession.ts`

Add these fields to the `UserSession` class alongside the existing heartbeat fields:

| Field                   | Type                  | Updated by               | Purpose                                                                   |
| ----------------------- | --------------------- | ------------------------ | ------------------------------------------------------------------------- |
| `reconnectCount`        | `number` (init 0)     | `createOrReconnect()`    | How many times this session has reconnected since creation                |
| `lastCloseCode`         | `number \| undefined` | `handleGlassesClose()`   | The close code from the most recent disconnect                            |
| `lastCloseReason`       | `string \| undefined` | `handleGlassesClose()`   | The close reason from the most recent disconnect                          |
| `lastClientMessageTime` | `number \| undefined` | `handleGlassesMessage()` | `Date.now()` on every message received FROM the client                    |
| `lastAppLevelPongTime`  | `number \| undefined` | `handleGlassesMessage()` | `Date.now()` when client responds `{"type":"pong"}` to our app-level ping |

These fields are read-only to the rest of the system. No manager or handler modifies them except at the specified call sites.

### A2. Track `lastClientMessageTime` on every glasses message

**File:** `packages/cloud/src/services/websocket/bun-websocket.ts`, inside `handleGlassesMessage()`

After confirming the `userSession` exists (after the `if (!userSession)` guard, before the try block), add:

```
userSession.lastClientMessageTime = Date.now();
```

This runs on every message — text, binary (audio), ping responses, everything. It's a single assignment, negligible overhead.

### A3. Track `lastAppLevelPongTime` on client pong

**File:** `packages/cloud/src/services/websocket/bun-websocket.ts`, inside `handleGlassesMessage()`

In the existing `if (parsed.type === "pong")` early-return block, add before the `return`:

```
userSession.lastAppLevelPongTime = Date.now();
```

This tracks when the client last responded to our `{"type":"ping"}` messages. If this timestamp is stale (>10 seconds old) at close time, the client stopped responding to our pings before the connection died — definitive proof of client-side failure.

### A4. Structured `ws-close` log event

**File:** `packages/cloud/src/services/websocket/bun-websocket.ts`, inside `handleGlassesClose()`

Replace the existing `userSession.logger.warn({ code, reason }, "Glasses connection closed")` with a structured log that captures connection health at the moment of death:

Before logging, stash the close code/reason on the session:

```
userSession.lastCloseCode = code;
userSession.lastCloseReason = reason;
```

Then log:

```json
{
  "feature": "ws-close",
  "level": "warn",
  "code": 1006,
  "reason": "",
  "sessionDurationSeconds": 142,
  "reconnectCount": 3,
  "timeSinceLastClientMessage": 34500,
  "timeSinceLastPong": 120000,
  "timeSinceLastAppPong": 34200,
  "message": "Glasses connection closed: code=1006, silent=34500ms, session=142s, reconnects=3"
}
```

**Fields:**

| Field                        | Type                  | Computation                                                         |
| ---------------------------- | --------------------- | ------------------------------------------------------------------- |
| `feature`                    | `"ws-close"`          | Constant — for BetterStack filtering                                |
| `code`                       | `number`              | The WebSocket close code                                            |
| `reason`                     | `string \| undefined` | The close reason (omit if empty)                                    |
| `sessionDurationSeconds`     | `number`              | `Math.round((Date.now() - session.startTime.getTime()) / 1000)`     |
| `reconnectCount`             | `number`              | `session.reconnectCount`                                            |
| `timeSinceLastClientMessage` | `number \| null`      | `Date.now() - session.lastClientMessageTime` or `null` if never set |
| `timeSinceLastPong`          | `number \| null`      | `Date.now() - session.lastPongTime` or `null`                       |
| `timeSinceLastAppPong`       | `number \| null`      | `Date.now() - session.lastAppLevelPongTime` or `null`               |

**This is the key diagnostic log.** If `timeSinceLastClientMessage` is >10 seconds on a 1006 close, the client went dark. If it's <2 seconds, something on the server side killed an active connection. This single field proves the case.

### A5. Structured `ws-reconnect` log event

**File:** `packages/cloud/src/services/session/UserSession.ts`, inside `createOrReconnect()`

**Before** clearing `disconnectedAt`, compute the downtime gap and increment the reconnect counter:

```
const downtimeMs = existingSession.disconnectedAt
  ? Date.now() - existingSession.disconnectedAt.getTime()
  : null;
const sessionAgeSeconds = Math.round(
  (Date.now() - existingSession.startTime.getTime()) / 1000
);
existingSession.reconnectCount++;
```

Then log:

```json
{
  "feature": "ws-reconnect",
  "level": "info",
  "reconnectCount": 4,
  "downtimeMs": 7200,
  "sessionAgeSeconds": 3400,
  "lastCloseCode": 1006,
  "lastCloseReason": "",
  "timeSinceLastClientMessage": 41700,
  "timeSinceLastPong": 127200,
  "timeSinceLastAppPong": 41400,
  "message": "Glasses reconnect #4: downtime=7200ms, lastClose=1006"
}
```

**Fields:**

| Field                        | Type                  | Computation                                                                                                             |
| ---------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `feature`                    | `"ws-reconnect"`      | Constant — for BetterStack filtering                                                                                    |
| `reconnectCount`             | `number`              | After incrementing                                                                                                      |
| `downtimeMs`                 | `number \| null`      | Gap between `disconnectedAt` and now. `null` if `disconnectedAt` was already cleared (shouldn't happen in normal flow). |
| `sessionAgeSeconds`          | `number`              | Total session age since creation                                                                                        |
| `lastCloseCode`              | `number \| undefined` | From the session field set in A4                                                                                        |
| `lastCloseReason`            | `string \| undefined` | From the session field set in A4                                                                                        |
| `timeSinceLastClientMessage` | `number \| null`      | Staleness of client communication at reconnect time                                                                     |
| `timeSinceLastPong`          | `number \| null`      | Staleness of protocol-level pong                                                                                        |
| `timeSinceLastAppPong`       | `number \| null`      | Staleness of app-level pong — the most reliable signal because it travels through Cloudflare as a regular data frame    |

**After** logging, proceed with the existing logic (clear `disconnectedAt`, clear cleanup timer, return).

### A6. Connection churn counters in SystemVitalsLogger

**File:** `packages/cloud/src/services/metrics/SystemVitalsLogger.ts`

Add a `ConnectionChurnTracker` class (same pattern as `OperationTimers`):

```
class ConnectionChurnTracker {
  disconnects: number = 0
  reconnects: number = 0
  closeCodes: Record<number, number> = {}
  totalDowntimeMs: number = 0
  downtimeSamples: number = 0

  recordDisconnect(closeCode: number): void
  recordReconnect(downtimeMs: number | null): void
  getAndReset(): { disconnects, reconnects, closeCodes, avgDowntimeMs }
}
```

Export as singleton `connectionChurnTracker`.

**Call sites:**

- `handleGlassesClose()` calls `connectionChurnTracker.recordDisconnect(code)` on every non-stale close
- `createOrReconnect()` calls `connectionChurnTracker.recordReconnect(downtimeMs)` on every reconnect

**Output in system-vitals log (every 30 seconds):**

| Field             | Type                  | Meaning                                                                                        |
| ----------------- | --------------------- | ---------------------------------------------------------------------------------------------- |
| `wsDisconnects`   | `number`              | Glasses WS disconnects in the last 30s                                                         |
| `wsReconnects`    | `number`              | Glasses WS reconnects in the last 30s                                                          |
| `wsAvgDowntimeMs` | `number`              | Average downtime between disconnect and reconnect                                              |
| `wsCloseCodeDist` | `string \| undefined` | JSON string of close code → count map (e.g. `{"1006":5,"1000":2}`). Omitted if no disconnects. |

**Why `wsCloseCodeDist` is a JSON string, not a nested object:** BetterStack's ClickHouse ingestion stores the entire vitals log as a single `raw` JSON blob. Nested objects require `JSONExtract` with path traversal. A flat string is queryable with `JSONExtract(raw, 'wsCloseCodeDist', 'Nullable(String)')` and can be further parsed if needed.

### A8. Structured `ws-dispose` log event

**File:** `packages/cloud/src/services/session/UserSession.ts`, inside `dispose()`

Right before the existing `this.logger.info({ duration }, ...)` log in `dispose()`, enhance it with the full connection health context. This is the **session lifecycle summary** — it fires when the 1-minute grace period expires and no reconnect arrived.

```json
{
  "feature": "ws-dispose",
  "level": "info",
  "sessionDurationSeconds": 142,
  "reconnectCount": 3,
  "lastCloseCode": 1006,
  "lastCloseReason": "",
  "timeSinceLastClientMessage": 94500,
  "timeSinceLastAppPong": 94200,
  "disposalReason": "grace_period_timeout",
  "message": "Session disposed: duration=142s, reconnects=3, lastClose=1006, silent=94500ms"
}
```

**Fields (in addition to what `dispose()` already logs):**

| Field                        | Type                  | Computation                                                         |
| ---------------------------- | --------------------- | ------------------------------------------------------------------- |
| `feature`                    | `"ws-dispose"`        | Constant — for BetterStack filtering                                |
| `sessionDurationSeconds`     | `number`              | Already computed in `dispose()` as `duration`                       |
| `reconnectCount`             | `number`              | `this.reconnectCount`                                               |
| `lastCloseCode`              | `number \| undefined` | From the session field set in A4                                    |
| `lastCloseReason`            | `string \| undefined` | From the session field set in A4                                    |
| `timeSinceLastClientMessage` | `number \| null`      | `Date.now() - this.lastClientMessageTime` or `null`                 |
| `timeSinceLastAppPong`       | `number \| null`      | `Date.now() - this.lastAppLevelPongTime` or `null`                  |
| `disposalReason`             | `string`              | Already tracked — `"grace_period_timeout"` or `"explicit_disposal"` |

**Why this matters:** The `ws-close` event fires at the moment of disconnect. The `ws-reconnect` event fires if the client comes back. But `ws-dispose` fires when the client **doesn't** come back — the session is gone for good. This is the final verdict: "This session lasted 142 seconds, reconnected 3 times during its life, the final close was a 1006 with the client silent for 94 seconds, and they never came back." It ties the entire lifecycle together in one log line.

This also captures sessions where `ws-close` and `ws-reconnect` fired multiple times — the `reconnectCount` in the dispose log tells you how many cycles happened before the session finally died.

### A7. Remove `gc-after-disconnect`

**File:** `packages/cloud/src/services/session/UserSession.ts`, inside `dispose()`

Remove the block that calls `Bun.gc(true)` after session disposal (approximately lines 807–851, the section guarded by `canRunPostDisconnectGc()`). Also remove the static fields `lastPostDisconnectGc` and `POST_DISCONNECT_GC_COOLDOWN_MS`, and the static method `canRunPostDisconnectGc()`.

**Why:** Confirmed wasteful. In the last hour on US Central: 31 forced GC calls, 2,242ms total event loop blocking, freed exactly 0 bytes every single time. The `gc-probe` (which runs every 60 seconds) already provides the same diagnostic data. The `gc-after-disconnect` feature was added in issue 061 for diagnostic purposes — that purpose is served. It's now actively harmful during disconnect storms.

**What stays:** The `gc-probe` in SystemVitalsLogger stays. It runs on a fixed 60-second interval, is not triggered by user behavior, and provides continuous GC timing data.

## What This Does NOT Include

| Explicitly out of scope                  | Why                                                |
| ---------------------------------------- | -------------------------------------------------- |
| Enabling the client liveness monitor     | Mobile release — separate issue                    |
| Adding exponential backoff to the client | Mobile release — separate issue                    |
| Changing any timeout values              | Behavioral change — needs its own spec             |
| Fixing East Asia ghost connections       | Separate investigation                             |
| JSC GC tuning env vars                   | Separate config change                             |
| Re-enabling `PONG_TIMEOUT_ENABLED`       | Cloudflare still absorbs pongs — problem unchanged |

## Decision Log

| Decision                                                                                 | Alternatives considered                                 | Why we chose this                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Track `lastClientMessageTime` on ALL messages including binary audio                     | Track only on text messages                             | Audio is the most frequent client→server traffic. If audio stops, that's a strong signal. The overhead is a single `Date.now()` assignment — negligible.                                                                                                                                                      |
| Store `lastCloseCode` on the session instead of passing through function args            | Pass close code to `createOrReconnect()` as a parameter | Storing on the session is simpler and doesn't change any function signatures. The field is set in `handleGlassesClose()` and read in `createOrReconnect()` — both are called on the same session object.                                                                                                      |
| JSON-stringify `closeCodes` in vitals instead of nested object                           | Nested object in the log entry                          | BetterStack ClickHouse queries are simpler with a flat string. Nested objects require chained `JSONExtract` calls. A flat string works with a single `JSONExtract` and can be parsed client-side if needed.                                                                                                   |
| Remove `gc-after-disconnect` entirely instead of making it opt-in                        | Add an env var to disable it                            | The data is in: 31 calls/hour, 2,242ms blocking, 0 bytes freed, every single time. There's no scenario where it's useful. The `gc-probe` provides the same diagnostic data on a fixed schedule without being triggered by user behavior.                                                                      |
| Log `ws-close` at `warn` level, `ws-reconnect` at `info` level                           | Both at `info`, or both at `warn`                       | Closes are noteworthy events (especially 1006). Reconnects are normal recovery — they happen constantly and `warn` would create noise.                                                                                                                                                                        |
| Log `ws-dispose` at `info` level, not `warn`                                             | `warn` level                                            | Session disposal after grace period timeout is normal system behavior — the client just didn't come back. The interesting data is in the fields (reconnect count, silence duration, close code), not the severity level.                                                                                      |
| Include `timeSinceLastClientMessage` in `ws-dispose` even though it's also in `ws-close` | Only include it in `ws-close`                           | The dispose log fires 60 seconds after the close. Having the silence duration in both events means you can query either one independently without joining. The staleness values will be ~60s larger in dispose, which is expected — they measure "time since last client activity" at each event's timestamp. |

## Testing

### Verify locally

1. Start the cloud server locally
2. Connect a phone (or use the WebSocket test tool)
3. Disconnect the phone (airplane mode or force-close)
4. Check logs for `feature: "ws-close"` with `timeSinceLastClientMessage`
5. Reconnect the phone
6. Check logs for `feature: "ws-reconnect"` with `downtimeMs` and `lastCloseCode`
7. Check the next `feature: "system-vitals"` log for `wsDisconnects` and `wsReconnects`

### Verify in production

After deploying to one region:

```sql
-- Find all ws-close events with client silence duration
SELECT
  dt,
  JSONExtract(raw, 'code', 'Nullable(Int32)') AS code,
  JSONExtract(raw, 'timeSinceLastClientMessage', 'Nullable(Int64)') AS silent_ms,
  JSONExtract(raw, 'timeSinceLastAppPong', 'Nullable(Int64)') AS pong_stale_ms,
  JSONExtract(raw, 'sessionDurationSeconds', 'Nullable(Int32)') AS session_s,
  JSONExtract(raw, 'reconnectCount', 'Nullable(Int32)') AS reconnects,
  JSONExtract(raw, 'userId', 'Nullable(String)') AS userId
FROM remote(t373499_mentracloud_prod_logs)
WHERE dt >= now() - INTERVAL 1 HOUR
  AND JSONExtract(raw, 'feature', 'Nullable(String)') = 'ws-close'
ORDER BY dt DESC
LIMIT 50
```

**Expected result for client-side disconnects:**

- `code = 1006`
- `silent_ms > 10000` (client was silent for >10 seconds before the close)
- `pong_stale_ms > 10000` (client stopped responding to our pings)

**Expected result for server-side disconnects:**

- `code = 1001`
- `silent_ms < 2000` (client was actively communicating right before the close)
- `pong_stale_ms < 4000` (client was responding to pings)

```sql
-- Connection churn rate over time
SELECT
  toStartOfFiveMinutes(dt) AS period,
  max(JSONExtract(raw, 'wsDisconnects', 'Nullable(Int32)')) AS max_disconnects,
  max(JSONExtract(raw, 'wsReconnects', 'Nullable(Int32)')) AS max_reconnects,
  max(JSONExtract(raw, 'wsCloseCodeDist', 'Nullable(String)')) AS close_codes
FROM remote(t373499_mentracloud_prod_logs)
WHERE dt >= now() - INTERVAL 6 HOUR
  AND JSONExtract(raw, 'feature', 'Nullable(String)') = 'system-vitals'
ORDER BY period DESC
LIMIT 50
```

## Rollout

1. Deploy to `cloud-debug` first (zero user impact)
2. Verify logs appear in BetterStack with correct fields
3. Deploy to US Central (highest session count — most data)
4. Wait 24 hours, collect data
5. Deploy to all regions
6. Build the evidence case from the data
