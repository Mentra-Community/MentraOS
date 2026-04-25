# Spec: Mobile WebSocket Reconnect Storm, Fix

## Overview

**What this doc covers:** The exact behavior changes that ship in PR #2592 to eliminate the WebSocket reconnect storm identified in [spike.md](./spike.md). The fix has two coordinated layers plus two defense-in-depth changes.

**Why this doc exists:** v2.10 is on the app stores. Every user who updates to v2.10 and then encounters any situation that updates `backend_url` is one retry-on-503 trigger away from a 90-opens-per-minute reconnect storm. This spec captures the agreed behavior so the PR review and any future regression check knows what to measure against.

**What you need to know first:** [spike.md](./spike.md) for evidence and root cause.

**Who should read this:** Mobile engineers reviewing the PR. Cloud engineers reviewing server-side impact.

---

## The Problem in 30 Seconds

`WebSocketManager.this.url` caches the WebSocket URL from the last `connect()` call. It is never updated when `useSettingsStore`'s `backend_url` setting changes. Any code path that updates `backend_url` without also triggering `ws.connect(newUrl)` leaves the WSM reconnecting forever against the stale URL, while axios immediately follows the new URL. REST returns 503 (session is on the old pod, not the new one), retry-on-503 fires `NO_ACTIVE_SESSION`, WSM reopens the WS against the stale URL, loop. The fix is to (1) stop caching the URL and always read it fresh from the settings store, and (2) subscribe to settings changes so a `backend_url` update triggers an immediate reconnect.

---

## Spec

### S1. WebSocketManager always reads the URL from the settings store

**File:** `mobile/src/services/WebSocketManager.ts`

**Before:** WSM has a private `url: string | null` field, written only inside `connect(url, coreToken)`. `reconnectNow()` reads `this.url` and passes it to `connect()`.

**After:**

- `this.url` as a cached field is gone.
- A new private helper `getCurrentWsUrl()` reads from `useSettingsStore.getState().getWsUrl()` on every call.
- `connect(url, coreToken)` keeps the `url` parameter for backward compatibility with the existing caller in `SocketComms.connectWebsocket()`. The parameter is ignored. The current URL is always resolved from the settings store inside `connect()`. If a caller passes a URL that disagrees with the current settings-store value, we log a warning and proceed with the settings-store value.
- `reconnectNow()`, `actuallyReconnect()`, `handleNoActiveSession`, and the liveness ping-pong timeout path all route through `connect(null, coreToken)` so the URL is always resolved at reconnect time.

Net effect: it is structurally impossible for the WSM to reconnect to a stale URL, because no field in WSM holds a stale URL.

### S2. WebSocketManager subscribes to backend_url changes

**File:** `mobile/src/services/WebSocketManager.ts`

**Before:** No subscription. Setting `backend_url` in Zustand had no effect on the WSM until a reconnect was triggered by something else (a ping timeout, a server-side close, or a REST 503 that fired `NO_ACTIVE_SESSION`). On a healthy connection that could be minutes.

**After:**

- WSM subscribes to `useSettingsStore` on construction via `subscribeWithSelector` with the selector `(state) => state.getSetting(SETTINGS.backend_url.key)`.
- On a selector change, a new private method `handleBackendUrlChanged()` runs.
- The handler skips if `manuallyDisconnected` is true (the caller is orchestrating a disconnect cycle and we should not interfere).
- The handler skips if `coreToken` is null (we are pre-auth and have nothing to reconnect with; the first `connect()` call from `mantle.init()` will use the new URL naturally).
- Otherwise the handler calls `reconnectNow("backend_url changed to <new URL>")`, which tears down the current socket and reconnects via the standard path.
- `cleanup()` unsubscribes.

Net effect: when the user hits "Save & Test URL" in dev settings, or any other code path that calls `setSetting(SETTINGS.backend_url.key, newUrl)`, the WSM tears down and reconnects to the new backend within about 500 ms. REST and WS always end up on the same backend.

### S3. detachAndCloseSocket awaits the close event

**File:** `mobile/src/services/WebSocketManager.ts`

**Before:** `detachAndCloseSocket()` nulls the handlers, calls `this.webSocket.close()`, and returns immediately. `connect()` then creates a new WebSocket in the same tick. For a brief window (50 to 500 ms) the cloud sees two active sockets for the same user, and logs the second one as "stale newer WebSocket already active, ignoring".

**After:**

- `detachAndCloseSocket()` is async.
- Before returning, it installs a one-shot `onclose` listener on the socket that resolves a promise, then calls `close()`, then races that promise against a 500 ms timeout.
- If the close event fires within the timeout, the wait resolves and `connect()` proceeds cleanly.
- If the timeout fires first, we proceed anyway; the native bridge will finish cleaning up the old socket on its own schedule.

Net effect: the typical 50 to 200 ms TCP close handshake runs to completion before a new socket is opened. The server-side "stale" log stops firing in the happy path.

### S4. WebsocketStatus only refreshes applets on sustained disconnect

**File:** `mobile/src/components/error/WebsocketStatus.tsx`

**Before:** On every CONNECTED transition, `useEffect` calls `refreshApplets()` unconditionally.

**After:**

- A new `wasSustainedDisconnectedRef` React ref tracks whether the WS was observed disconnected for at least `DISCONNECTION_DELAY` (3 seconds, already defined in this file).
- The ref flips to true inside the 3-second disconnection timer callback.
- On the next CONNECTED, `refreshApplets()` is called only if the ref is true. The ref is then cleared.

Net effect: a sub-second flap from CONNECTED to DISCONNECTED to CONNECTED no longer triggers an applet refresh. This is correctness, not rate limiting: a brief flap is not evidence that applet state changed on the server. A genuine "was offline for 3+ seconds, now back" event still triggers the refresh.

### S5. No exponential backoff, no retry rate limit, no debounce

Explicitly rejected in the spike. Each of those treats a symptom and leaves the root cause in place. With S1 and S2 in place, they are unnecessary.

PR #2565's retry-on-503 path in `RestComms.ts` stays. Its design assumption ("reconnect the WS and retry, the new WS might land on the pod that owns this session") becomes true once S1 removes the stale URL. The retry now converges on the first attempt instead of looping.

### S6. No server-side WS upgrade rate limit

Explicitly rejected. We proposed a server-side per-user WS upgrade rate limit as a backstop earlier in the investigation. With S1 and S2, upgrade volume should return to baseline. Adding a server-side limit before verifying the client fix is overengineering and would hide the bug if it ever regresses.

---

## Non-Goals

- **Redesigning cross-pod session replication.** The architecture relies on Cloudflare session affinity to keep a user on one pod. That's fine. This fix does not touch it.
- **Changing the way `backend_url` is set.** All existing code paths that call `setBackendUrl` or `setSetting(SETTINGS.backend_url.key, ...)` continue to work. The WSM now just notices.
- **Fixing the prod-build slow reconnect cycle.** One prod-build user's roughly 11-second clean-close cycle observed earlier is a different bug on an older build. Separate issue.
- **Audit of other cached fields in WSM.** `this.coreToken` has the same shape as `this.url` did, but the token does not rotate mid-session in practice. Flagged for a follow-up audit, not scoped here.
- **Changing PR #2565's retry-on-503 logic.** The retry is correct once the URL staleness is fixed.
- **Improving `mantle.cleanup()` or `mantle.init()` orchestration.** They are fine as they are. This fix makes them redundant (but still working) rather than required.
- **PII redaction in vitals logs.** Flagged by CodeRabbit on PR #2590. Out of scope for a WS reconnect fix.
- **RECONNECTED status reaching MicrophoneManager.** Also flagged on PR #2590. Separate cross-cutting change.

---

## Decision Log

| Decision                                                           | Alternatives considered                                                          | Why we chose this                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ship both "always-derive" AND a Zustand subscription               | Always-derive only                                                               | Always-derive alone fixes the root cause but leaves a UX gap: changing `backend_url` on a healthy connection has no visible effect until the next reconnect trigger. On-device testing showed users expect an immediate switch when they hit Save in dev settings. The subscription adds ~25 lines of code, one Zustand listener, and one cleanup call. The combined cost is strictly less than a second iteration PR later. |
| Keep `connect()`'s `url` parameter for backward compatibility      | Drop the parameter, force `SocketComms.connectWebsocket` to change its signature | Keeping the parameter (and ignoring it inside WSM, with a warning log on mismatch) is one line of code less and lets us ship with no caller changes. Future cleanup can drop the parameter in a separate PR.                                                                                                                                                                                                                 |
| Keep cached `this.coreToken`                                       | Audit and de-cache both fields together                                          | The token does not rotate mid-session; no observed bug pattern. Scope this PR to the one cached field that actually caused the storm.                                                                                                                                                                                                                                                                                        |
| Fix the `refreshApplets` flap amplifier in this PR                 | Leave it for a separate PR                                                       | Even with the root cause fixed, a brief WS flap firing a full REST refresh is wasteful. The fix is 10 lines. Landing it here closes the loop on all of the storm's amplifiers in one review.                                                                                                                                                                                                                                 |
| No exponential backoff                                             | Add 1-to-60s backoff                                                             | Rejected explicitly per user instruction and per the spike. Backoff is symptom management. With the URL fix, the retry path converges in one attempt.                                                                                                                                                                                                                                                                        |
| No retry attempt cap                                               | Cap at 1 retry per REST call                                                     | Rejected explicitly. With the URL fix, the retry's premise becomes true and the first retry succeeds.                                                                                                                                                                                                                                                                                                                        |
| No `refreshApplets` debounce                                       | 10s debounce                                                                     | Rejected explicitly. The S4 sustained-disconnect gate is correctness, not throttling.                                                                                                                                                                                                                                                                                                                                        |
| No server-side WS upgrade rate limit                               | Add as backstop                                                                  | Rejected explicitly. Client fix is sufficient. Server-side limit would hide a future regression.                                                                                                                                                                                                                                                                                                                             |
| Await close event via one-shot listener                            | Poll `readyState`; use the native bridge; don't wait                             | Listener is the correct abstraction. `readyState` polling is hacky. Native bridge is over-engineering. Not waiting leaves the overlap race in place.                                                                                                                                                                                                                                                                         |
| 500 ms close timeout                                               | 100 ms, 2 s, no timeout                                                          | 500 ms covers the typical TCP close handshake (50 to 200 ms) with margin. Short enough not to noticeably delay a legitimate reconnect. A longer timeout risks hanging on a dead socket; a shorter one risks racing the handshake.                                                                                                                                                                                            |
| `WebsocketStatus` uses a React ref to track sustained-disconnected | New Zustand state                                                                | Local concern to this one component. No other component cares. Ref is the simplest expression.                                                                                                                                                                                                                                                                                                                               |

---

## Testing

### Root cause acceptance

1. On a dev build, connect the app to `api.mentra.glass` and establish a session.
2. Open dev settings, BackendUrl screen.
3. Change `backend_url` programmatically via the Metro debug console: `useSettingsStore.getState().setSetting(SETTINGS.backend_url.key, "https://devapi.mentra.glass")`.
4. Observe the console log sequence:
   ```
   WSM: backend_url changed https://api.mentra.glass to https://devapi.mentra.glass
   WSM: Immediate reconnect requested: backend_url changed to https://devapi.mentra.glass
   WSM: connect: https://devapi.mentra.glass
   WSM: WebSocket connection established
   ```
5. Confirm REST calls after the switch go to `us-central-dev` and succeed. No 503 loop.

### Dev-settings acceptance (the reason S2 was added)

1. On a dev build, connect the app to a backend and establish a session.
2. Open dev settings, BackendUrl screen.
3. Enter a different backend URL and tap "Save and Test URL".
4. Confirm the WS reconnects to the new backend within about a second of the Save confirmation alert dismissing. Observable via the WSM log line pattern above.

### Reproduction of original bug

1. Same as the root cause acceptance but run against the pre-fix build first to confirm the reproducer hits.
2. Measure WS opens per minute over 2 minutes.
3. Expected on pre-fix: 80 to 100 opens per minute sustained.
4. Expected on post-fix: at most a single clean reconnect to the new URL.

### Amplifier test (S4)

1. On a dev build, simulate a brief WS drop by toggling Wi-Fi off for 500 ms and back on.
2. Expected: zero `refreshApplets()` calls, because the disconnect was shorter than `DISCONNECTION_DELAY`.
3. Now toggle Wi-Fi off for 5 seconds and back on.
4. Expected: one `refreshApplets()` call after the 3-second threshold and/or on the next CONNECTED.

### Overlap test (S3)

1. On a dev build, trigger a WS reconnect via the dev-settings "Clear Websocket" button (or equivalent).
2. Watch server logs for this user.
3. Expected: zero "stale newer WebSocket already active" log lines. The close for the old socket is observed server-side before the new one is upgraded.

### Regression checks

- Normal startup flow (login, connect, use the app): single WS open, no extra reconnects.
- Standard backend change via `BackendUrl.tsx handleSaveUrl`: still works, same UX, plus an immediate reconnect thanks to S2.
- Force-close recovery: kill the app, reopen, connect. Single WS open.
- Pod restart: one WS reconnect per client, not a storm.

---

## Rollout

1. Branch `mobile/ws-reconnect-storm-fix` off `origin/dev`. Done.
2. PR to `dev` with S1 through S4 in one commit. Done (PR #2592).
3. Soak on dev/staging builds for 24 hours. Reproduce the scenarios above and confirm the log pattern.
4. Cherry-pick to a `v2.10.1` hotfix tag. Release to TestFlight beta and Play Store internal.
5. Full production release as `v2.11` after a week of stable observation on TestFlight.
6. Backport to `main` for eventual merge. Lower urgency: main does not currently have the retry-on-503 code that amplifies the bug, but the stale-URL pattern exists and should not be left behind.

---

## Key Numbers

| Metric                                         | Before (v2.10)             | After (post-fix)                      |
| ---------------------------------------------- | -------------------------- | ------------------------------------- |
| WS opens per minute during reproducer          | ~90 peak, ~87 sustained    | 1 per backend-URL change, 0 otherwise |
| REST 503s per second during reproducer         | ~20                        | 0                                     |
| Server-side stale-close log rate               | occasional                 | ~0                                    |
| User-visible recovery after backend switch     | required force-close       | under 1 s                             |
| Cloud transient heap churn per reproducer-hour | ~100 MB/hr from one client | negligible                            |
