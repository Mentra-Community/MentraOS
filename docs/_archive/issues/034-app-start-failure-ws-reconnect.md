# 034 — App Start Failures Due to WebSocket Reconnection Gap

**Date:** 2026-02-12
**Severity:** High
**Status:** Investigation complete, fixes pending
**Affected components:** `mobile` (WebSocketManager, applets store), `cloud` (UserSession, client middleware)

---

## Summary

Users are intermittently unable to start apps from the mobile client. The app appears to do nothing when tapped (loading state flickers briefly then reverts). The root cause is a gap between the mobile client's WebSocket disconnection from cloud and its reconnection — during which the cloud `UserSession` is disposed and all HTTP requests to start/stop apps are rejected with 401.

## Bug Reports

- **Feb 10, ~10:24 AM PST** — cayden@mentra.glass: "Can't start an app, it doesn't start." Device: SM-F956U1, Android 36, App 2.4.0, glasses connected, wifi connected.
- **Feb 12, ~5:56 PM PST** — Same user, similar failure pattern observed in Better Stack logs.

## Root Cause Analysis

### The Timeline (Feb 12 incident, UTC)

```
01:53:06  WebSocket connection opened (reconnect)
01:53:12  WebSocket connection opened (another reconnect)
01:54:00  Glasses connection closed (WS drops)
01:55:06  UserSession disposed (60s grace period expired)
01:55:11  HTTP 401 POST /apps/com.mentra.streamer/start  ← USER TRIES TO START APP
01:55:20  HTTP 401 POST /apps/com.mentra.streamer/start  ← USER RETRIES
01:55:28  "requireUserSession: No active session found"
...repeated 401s for ~90 seconds...
01:56:41  New WebSocket connection → session recreated → apps work again
```

### Why this happens

The system has three interacting behaviors that create the failure window:

1. **Cloud `UserSession` 60-second grace period.** When the mobile client's WebSocket to cloud disconnects, the `UserSession` stays alive for 60 seconds before disposing itself. After disposal, all HTTP endpoints guarded by `requireUserSession` middleware return 401.

2. **Mobile client 5-second reconnect interval.** `WebSocketManager.startReconnectInterval()` attempts reconnection every 5 seconds. In theory, this should reconnect well within the 60-second grace period. **But in the observed incidents, the client took ~97 seconds to reconnect** — far exceeding the grace window. This is the core mystery.

3. **Mobile client does not gate app operations on connection state.** `startApplet()` in `applets.ts` immediately fires `POST /apps/:pkg/start` without checking `WebSocketManager.isConnected()` or `useConnectionStore.status`. If the session is gone, the request silently fails and the optimistic UI state reverts — the user sees a brief flicker and nothing else.

### Why didn't the client reconnect within 60 seconds?

This is the key unanswered question. Possible causes to investigate:

- **`BackgroundTimer.setInterval` reliability.** The reconnect uses `BackgroundTimer.setInterval` at 5000ms. On Android, background timers can be throttled or killed by the OS even when the app is in the foreground, especially on Samsung devices with aggressive battery management (the device is a Galaxy Z Fold — SM-F956U1).
- **`actuallyReconnect()` guard condition.** The reconnect function checks `if (store.status === WebSocketStatus.DISCONNECTED)` before calling `connect()`. If the status is stuck on `CONNECTING` or `ERROR` (rather than `DISCONNECTED`), the reconnect attempt is skipped entirely. The `onerror` handler sets status to `ERROR`, not `DISCONNECTED` — so if the connection attempt errors out, subsequent reconnect ticks may be no-ops.
- **Reconnect interval cleared but not restarted.** `startReconnectInterval` clears any existing interval before creating a new one. If there's a race condition where the interval is cleared but the new one isn't set (e.g., `manuallyDisconnected` check), reconnection stops entirely.
- **Network-level issues.** The phone may have had a momentary network state change (wifi ↔ cellular handoff) that caused the WebSocket to drop but didn't immediately resolve, delaying reconnection.

## Secondary Issues Found

### Ghost apps in "previously running" list

Every reconnect shows:

```
App com.augmentos.calendarreminder not found
App com.mentra.mentraai.beta2 not found
```

These apps were deleted/renamed from the store but remain in the user's `runningApps` list in MongoDB. On every session reconnect, `startPreviouslyRunningApps` tries to start them, fails, logs errors, and moves on. This adds latency to every reconnect and pollutes logs.

**Fix:** `startPreviouslyRunningApps` should remove apps from the user's `runningApps` list when they're not found in the database (clean up stale entries).

### App WebSocket upgrade failures

```
02:03:06  WebSocket connection to 'wss://uscentralapi.mentra.glass/app-ws' failed: Expected 101 status code
02:03:08  Same failure (retry 2/3)
02:03:11  Connection timeout → "Connection permanently lost"
```

The dashboard app's WebSocket connection to cloud failed the HTTP→WebSocket upgrade (server returned non-101 status). This happened during a period of instability and could be related to load balancer behavior, server resource pressure, or a Bun/Hono WebSocket upgrade race condition.

### Server returns 401 instead of a descriptive error

The `requireUserSession` middleware returns HTTP 401 when no `UserSession` exists. This is misleading — the user IS authenticated (valid JWT), they just don't have an active glasses session. The mobile client may interpret 401 as "not logged in" rather than "session unavailable."

## Proposed Fixes

### P0: Client — Gate app operations on connection state

**File:** `mobile/src/stores/applets.ts`

`startApplet()` and `stopApplet()` should check `useConnectionStore.getState().status === WebSocketStatus.CONNECTED` before attempting the HTTP call. If not connected, show a user-facing message like "Cloud connection lost, reconnecting…" instead of silently failing.

### P0: Client — Investigate reconnection reliability

**File:** `mobile/src/services/WebSocketManager.ts`

- Audit the `actuallyReconnect()` guard: if `status` is `ERROR` (not `DISCONNECTED`), the reconnect is silently skipped. This may be the reason reconnection takes so long — the status gets stuck on `ERROR` after a failed attempt.
- Add logging around reconnect attempts (count, timestamps, status at each tick) to diagnose in production.
- Consider falling back from `BackgroundTimer.setInterval` to a more reliable mechanism, or using exponential backoff with a maximum interval.

### P1: Cloud — Return 503 instead of 401 for missing session

**File:** `cloud/packages/cloud/src/api/hono/middleware/client.middleware.ts`

When the user is authenticated but has no active `UserSession`, return `503 Service Unavailable` (or a custom status) with a descriptive message like `{ error: "no_active_session", message: "No active glasses session. Please ensure your glasses are connected." }`. This lets the mobile client differentiate between "not logged in" and "session not available" and display the appropriate UI.

### P2: Cloud — Clean up stale running apps on reconnect

**File:** `cloud/packages/cloud/src/services/session/AppManager.ts`

In `startPreviouslyRunningApps`, when an app is not found in the database, remove it from the user's `runningApps` list in MongoDB so it doesn't keep failing on every subsequent reconnect.

### P3: Client — Show connection state in app start UI

**Files:** `mobile/src/components/home/` (Homepage, app list components)

When WebSocket status is not `CONNECTED`, visually indicate that online apps cannot be started (dim them, show a banner, etc.) rather than allowing the user to tap and get a silent failure.

## Log Queries (Better Stack)

### Find app start failures for a user

```sql
SELECT dt, JSONExtract(raw, 'level', 'Nullable(String)') AS level,
  JSONExtract(raw, 'message', 'Nullable(String)') AS message,
  JSONExtract(raw, 'service', 'Nullable(String)') AS service
FROM s3Cluster(primary, t373499_augmentos_s3)
WHERE _row_type = 1
  AND JSONExtract(raw, 'userId', 'Nullable(String)') = '<USER_EMAIL>'
  AND dt BETWEEN toDateTime64('<START>', 6, 'UTC') AND toDateTime64('<END>', 6, 'UTC')
  AND (
    JSONExtract(raw, 'message', 'Nullable(String)') LIKE '%start%'
    OR JSONExtract(raw, 'message', 'Nullable(String)') LIKE '%Stop%'
    OR JSONExtract(raw, 'message', 'Nullable(String)') LIKE '%not found%'
    OR JSONExtract(raw, 'message', 'Nullable(String)') LIKE '%401%'
    OR JSONExtract(raw, 'level', 'Nullable(String)') = 'error'
  )
ORDER BY dt ASC LIMIT 200
```

### Find session dispose / reconnect gaps

```sql
SELECT dt, JSONExtract(raw, 'level', 'Nullable(String)') AS level,
  JSONExtract(raw, 'message', 'Nullable(String)') AS message,
  JSONExtract(raw, 'service', 'Nullable(String)') AS service
FROM s3Cluster(primary, t373499_augmentos_s3)
WHERE _row_type = 1
  AND JSONExtract(raw, 'userId', 'Nullable(String)') = '<USER_EMAIL>'
  AND dt BETWEEN toDateTime64('<START>', 6, 'UTC') AND toDateTime64('<END>', 6, 'UTC')
  AND (
    JSONExtract(raw, 'message', 'Nullable(String)') LIKE '%dispose%'
    OR JSONExtract(raw, 'message', 'Nullable(String)') LIKE '%connection opened%'
    OR JSONExtract(raw, 'message', 'Nullable(String)') LIKE '%connection closed%'
    OR JSONExtract(raw, 'message', 'Nullable(String)') LIKE '%requireUserSession%'
  )
ORDER BY dt ASC LIMIT 100
```

## Related

- **033** — Duplicate APP_STATE_CHANGE on app stop (contributes to UI flickering)
- `mobile/src/services/WebSocketManager.ts` — WebSocket reconnection logic
- `mobile/src/stores/applets.ts` — App start/stop store
- `cloud/packages/cloud/src/services/session/UserSession.ts` — 60-second dispose grace period
- `cloud/packages/cloud/src/api/hono/middleware/client.middleware.ts` — `requireUserSession` middleware
