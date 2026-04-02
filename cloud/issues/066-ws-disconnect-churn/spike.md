# Spike: WebSocket Disconnect Churn — Why Are Clients Reconnecting Every 5–180 Seconds?

## Overview

**What this doc covers:** Investigation into why mobile clients rapidly disconnect and reconnect their glasses WebSocket connection, with session lifetimes as short as 5–24 seconds observed before the March 28 crash, and 70–180 seconds observed in current production data. Includes a full audit of every ping/pong/liveness mechanism, the mobile client reconnection code, cloud-side observability gaps, and live BetterStack evidence.
**Why this doc exists:** This disconnect churn is Root Cause #2 from the crash investigation (issue 065). Each reconnect cycle allocates managers, buffers, and Soniox connections, driving memory pressure and GC frequency. The team has been told this is a client-side issue but there's no instrumented proof yet — the cloud literally cannot distinguish "client went dark" from "server killed the connection" because the observability doesn't exist. This spike documents exactly what we know, what we don't, and what instrumentation is needed to prove it.
**Who should read this:** Cloud engineers, mobile engineers, anyone working on connection stability.

**Depends on:**

- [034-ws-liveness](../034-ws-liveness/) — server app-level pings, client liveness detection design
- [035-nginx-ws-timeout](../035-nginx-ws-timeout/) — nginx/Cloudflare timeout fixes, dedicated WS ingress
- [042-glasses-ws-disconnect-cycle](../042-glasses-ws-disconnect-cycle/) — identical symptoms on a branch missing 034/035 fixes
- [046-sdk-app-ws-liveness](../046-sdk-app-ws-liveness/) — SDK-initiated pings for app-ws connections
- [065-open-investigations](../065-open-investigations/) — master tracking, two root causes identified

---

## Background

### The connection architecture

```
Phone → Cloudflare (TLS termination, WebSocket proxy) → nginx Ingress → Bun server
                                                                          ↓
                                                                   UserSession (in-memory)
```

The phone opens a persistent WebSocket to `wss://{region}api.mentra.glass/glasses-ws`. All control messages, display events, and state flow over this connection. Audio goes over UDP separately.

### The four liveness layers

There are four mechanisms keeping this connection alive:

| #   | Mechanism                               | Direction                        | Interval    | Purpose                                                              |
| --- | --------------------------------------- | -------------------------------- | ----------- | -------------------------------------------------------------------- |
| 1   | Bun `sendPings: true`                   | Server → Client (protocol-level) | Automatic   | Keeps socket alive through Bun's idle detection                      |
| 2   | Server protocol ping `ws.ping()`        | Server → Client                  | 10 seconds  | Intended for pong-based liveness detection                           |
| 3   | Server app-level ping `{"type":"ping"}` | Server → Client                  | 2 seconds   | Visible to React Native `onmessage` — gives client a periodic signal |
| 4   | Bun `idleTimeout: 120`                  | —                                | 120 seconds | Kills connection if zero data exchanged for 2 minutes                |

### The Cloudflare problem

Cloudflare terminates WebSocket protocol-level ping/pong at its edge. The mobile client's pong frames never reach the Bun server. This means:

- **Layer 2 is observability-only** — pongs don't arrive, so `PONG_TIMEOUT_ENABLED = false` (disabled in issue 035 because it was killing healthy connections)
- **Layer 3 is the only reliable bidirectional signal** — app-level `{"type":"ping"}` travels as a normal data frame through Cloudflare

### What happened previously (issues 034/035/042)

Before issue 034, connections died every ~60 seconds like clockwork. The root cause was nginx `proxy-send-timeout` killing idle connections. The fix was:

1. Server sends app-level pings every 2 seconds (keeps nginx/Cloudflare alive)
2. Dedicated WS ingress with 3600s timeouts (prevents nginx from killing WS connections)
3. Client-side liveness monitor (detects dead connections in 4–6 seconds instead of 30–120s)

After deploying fixes 1 and 2, connection lifetimes went from ~60 seconds to 56+ minutes. Fix 3 was designed but required a mobile app release.

Issue 042 showed that a branch missing these fixes exhibited the exact same 5–60 second disconnect pattern we're seeing now.

---

## Findings

### 1. The client-side liveness monitor is commented out

**File:** `mobile/src/services/WebSocketManager.ts`
**Confidence:** Confirmed — code audit

The liveness monitor from issue 034 — which checks every 2 seconds and force-closes dead connections after 4 seconds of silence — is fully written but **the entire body is commented out**:

```
// mobile/src/services/WebSocketManager.ts — startLivenessMonitor()
// The following is COMMENTED OUT in the actual file:
//
// this.livenessCheckInterval = BackgroundTimer.setInterval(() => {
//   const elapsed = Date.now() - this.lastMessageTime
//   if (elapsed > LIVENESS_TIMEOUT_MS) {
//     console.log(`WSM: Liveness timeout — no message for ${elapsed}ms, force-closing`)
//     this.stopLivenessMonitor()
//     this.detachAndCloseSocket()
//     this.updateStatus(WebSocketStatus.DISCONNECTED)
//     this.startReconnectInterval()
//   }
// }, LIVENESS_CHECK_INTERVAL_MS)
```

Constants are defined (`LIVENESS_TIMEOUT_MS = 4000`, `LIVENESS_CHECK_INTERVAL_MS = 2000`), `lastMessageTime` is correctly updated on every `onmessage`, but the checking interval never runs. This means:

- If the TCP connection enters a half-open/black-hole state, the client waits 30–120+ seconds for OS TCP keepalive to detect it
- During that time, the server sends pings into the void, apps think the user is connected, but nothing works
- When the OS finally detects the dead socket → `onclose` fires → reconnect interval starts → 5 second delay → reconnect

### 2. The mobile client has no exponential backoff

**File:** `mobile/src/services/WebSocketManager.ts`
**Confidence:** Confirmed — code audit

The primary cloud WebSocket reconnection uses a **fixed 5-second interval** forever:

```
RECONNECT_INTERVAL_MS = 5_000  // Fixed, no backoff
```

- No exponential backoff, no jitter
- No maximum retry count — reconnects indefinitely
- The `reconnectAttempts` counter exists in the Zustand store but is **never incremented or read** — dead code
- Both `onerror` and `onclose` trigger `startReconnectInterval()` — no close-code differentiation
- Close codes 1000 (normal), 1001 (going away), and 1006 (abnormal) all produce identical behavior

By contrast, the webview SDK's `SocketBridge` (which connects to the local `MiniSockets` server) has proper linear backoff (2s → 10s), max retries (10), and intentional-close suppression.

### 3. The client correctly handles app-level pings

**File:** `mobile/src/services/SocketComms.ts`
**Confidence:** Confirmed — code audit

The app-level ping/pong flow works correctly:

- Server sends `{"type":"ping"}` every 2 seconds
- Client receives it in `onmessage` → updates `lastMessageTime` → dispatches to `SocketComms.handle_ping()`
- `handle_ping()` immediately responds with `{"type":"pong"}`
- Server receives client's `{"type":"pong"}` and silently consumes it (early return in `handleGlassesMessage`)

The client **does** respond to pings — but nobody on the server side is tracking whether those responses arrive or measuring their latency.

### 4. Live production data shows 40% abnormal closures

**Source:** BetterStack ClickHouse, last 6 hours as of March 28 ~23:48 UTC
**Confidence:** Confirmed — direct query

Close code distribution across all regions:

| Code | Meaning                                | Count | %   | Implication                                                            |
| ---- | -------------------------------------- | ----- | --- | ---------------------------------------------------------------------- |
| 1006 | Abnormal closure (no close handshake)  | 84    | 40% | Client went dark — network loss, app backgrounded, or OS killed socket |
| 1008 | Policy violation ("Session not found") | 64    | 30% | App-ws connections to East Asia with empty userId — ghost connections  |
| 1000 | Normal closure                         | 62    | 29% | Clean disconnect — either side initiated properly                      |
| null | No code                                | 2     | 1%  | Translation provider closed                                            |

The **1006 dominance** is the strongest evidence that disconnects are client-initiated. Code 1006 means the TCP connection was terminated without a WebSocket close frame — the client simply stopped communicating. The server does not produce 1006; it always sends a close frame (1000 or 1001).

5 of the 1006 events explicitly logged **"WebSocket timed out from inactivity"** — Bun's 120-second `idleTimeout` fired, meaning zero data was exchanged for 2 full minutes despite the server sending pings every 2 seconds. The client was not responding to anything.

### 5. Short-lived sessions cluster at 70–180 seconds

**Source:** BetterStack `gc-after-disconnect` logs, last 6 hours
**Confidence:** Confirmed

Session durations at disposal time (after the 1-minute grace period expired without reconnect):

| User (anonymized) | Duration    | Region     | Pattern                      |
| ----------------- | ----------- | ---------- | ---------------------------- |
| user-A            | 70s         | us-central | Repeated 70s sessions        |
| user-B            | 106s, 107s  | us-central | 9 disconnects in 2 hours     |
| user-C            | 74s, 80s    | us-central | 4 disconnects in 2 hours     |
| user-D            | 70s         | us-central | 4 disconnects in 2 hours     |
| user-E            | 77s         | us-central | 2 disconnects in 2 hours     |
| user-F            | 37 minutes  | us-central | Stable — proves system works |
| user-G            | 110 minutes | east-asia  | Stable — proves system works |
| user-H            | 98 minutes  | france     | Stable — proves system works |

The 70–180 second cluster doesn't match any server-side timeout:

- nginx is 3600s (issue 035 fix)
- Cloudflare is 100s
- Bun `idleTimeout` is 120s
- Server pong timeout is disabled

But it's consistent with **mobile network conditions** — cell tower handoffs, WiFi flickers, and app backgrounding on iOS (which suspends WebSocket connections after ~30–180 seconds depending on battery state and iOS version).

### 6. East Asia has 64 ghost connections with empty userId

**Source:** BetterStack, last 2 hours
**Confidence:** Confirmed

64 disconnects from East Asia, all with empty `userId` and close code 1008 ("Session not found"). Something is repeatedly connecting app WebSockets without valid credentials. This could be:

- A health check or bot hitting the `/app-ws` endpoint
- A stuck client in a retry loop without auth
- A misconfigured load balancer probe

This is separate from the client churn issue but worth investigating.

### 7. The cloud has critical observability blind spots

The following data is **not captured** by current instrumentation:

| Missing metric                                  | Why it matters                                                                                                                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Downtime duration on reconnect**              | `disconnectedAt` is cleared in `createOrReconnect()` BEFORE computing the gap. The key metric — how long was the client gone? — is destroyed on every reconnect. |
| **Reconnect counter per session**               | No way to distinguish "reconnected 50 times in 10 minutes" from "reconnected once."                                                                              |
| **Close code at reconnect time**                | On reconnect, we don't log what the previous close code was. The correlation between close cause and reconnect timing is lost.                                   |
| **Last-client-message timestamp at close time** | Was the client actively sending data right before the close, or had it gone silent for 30 seconds? This is the definitive proof of client-side vs server-side.   |
| **App-level pong round-trip time**              | The server sends `{"type":"ping"}` every 2s and the client responds with `{"type":"pong"}`, but nobody measures the RTT or tracks whether pongs arrive.          |
| **Disconnect/reconnect rate in vitals**         | SystemVitalsLogger shows current session count but not churn. A client disconnecting every 5s looks identical to a stable connection in the vitals.              |
| **Close code distribution per 30s window**      | No breakdown of 1000/1001/1006 over time. Can't see if 1006s correlate with GC pauses.                                                                           |

The core problem is in `UserSession.createOrReconnect()`:

```
// UserSession.ts L481
existingSession.disconnectedAt = null;  // Clears the timestamp BEFORE anyone reads it
```

The downtime gap is literally destroyed before it can be measured or logged.

---

## Conclusions

| Finding                                             | Confidence                  | Implication                                                                      |
| --------------------------------------------------- | --------------------------- | -------------------------------------------------------------------------------- |
| Client liveness monitor is commented out            | **Confirmed** (code audit)  | Client takes 30–120s to detect dead connections instead of 4s                    |
| Client has no exponential backoff                   | **Confirmed** (code audit)  | Hammers server every 5s forever after any disconnect                             |
| Client handles app-level pings correctly            | **Confirmed** (code audit)  | The ping/pong mechanism works — the issue is detection of failure                |
| 40% of closes are code 1006 (abnormal)              | **Confirmed** (BetterStack) | Client-side — the server always sends close frames                               |
| 5 events show Bun idle timeout firing               | **Confirmed** (BetterStack) | Client was completely unresponsive for 120+ seconds despite 2s pings             |
| Session lifetimes cluster at 70–180s                | **Confirmed** (BetterStack) | Consistent with mobile network conditions, not any server timeout                |
| Cloud can't distinguish client vs server disconnect | **Confirmed** (code audit)  | `lastClientMessageTime`, reconnect count, and close code context are not tracked |
| Long-lived sessions exist (37–110 min)              | **Confirmed** (BetterStack) | System is capable of stable connections — the churn is client/network-specific   |
| 64 ghost connections in East Asia                   | **Confirmed** (BetterStack) | Separate issue — something connecting without auth                               |

### The hypothesis

The disconnects are **client-initiated** (network loss, app backgrounding, cell handoffs) and the cloud has no observability to prove it. The disabled liveness monitor makes recovery slow, and the lack of backoff makes reconnection storms harmful. The server is functioning correctly — it sends pings every 2 seconds and never initiates disconnects (pong timeout is disabled).

### What we can NOT prove yet

Without the observability additions, we cannot definitively show:

1. That `lastClientMessageTime` was stale (client went silent) before each 1006 close
2. Whether app-level pongs were arriving consistently before each disconnect
3. The exact downtime gap between disconnect and reconnect (destroyed by `createOrReconnect()`)
4. Whether 1006 closes correlate with GC pauses (event loop blocked → pings can't send → Bun idle timeout fires)
5. Whether the nginx WS ingress manifests are still deployed or were overwritten by a Porter deploy

---

## Next Steps

### Step 1: Write spec for cloud-side observability (spec.md)

Add instrumentation to prove the hypothesis. Zero behavioral changes — diagnostic only:

- Track `lastClientMessageTime` on every message from the glasses
- Track `lastAppLevelPongTime` when the client responds to our pings
- Compute and log downtime duration in `createOrReconnect()` before clearing `disconnectedAt`
- Add `reconnectCount` to UserSession
- Stash `lastCloseCode` and `lastCloseReason` on the session in `handleGlassesClose()`
- Log a structured `ws-close` event with session duration, silence duration, close code, and reconnect count
- Log a structured `ws-reconnect` event with downtime, previous close code, and pong staleness
- Add disconnect/reconnect rate counters and close code distribution to SystemVitalsLogger
- Remove `gc-after-disconnect` (confirmed wasteful: 31 calls/hour, 2,242ms blocking, frees 0 bytes)

### Step 2: Deploy, wait 24–48 hours, collect data

With the new instrumentation deployed, BetterStack will show:

- `feature: "ws-close"` with `timeSinceLastClientMessage` — if this is large (>10s), the client went dark
- `feature: "ws-reconnect"` with `downtimeMs` and `lastCloseCode` — the reconnect pattern
- `wsDisconnects`, `wsReconnects`, `wsCloseCodeDist` in system-vitals — the churn rate over time
- Absence of `gc-after-disconnect` blocking — 2.2s/hour of event loop time recovered

### Step 3: Present evidence to the team

With the data in hand, build a clear case:

- "Here are 500 `ws-close` events where `timeSinceLastClientMessage` was >30 seconds — the CLIENT stopped talking"
- "Here's the close code distribution: 85% are 1006, which means no close frame — the client dropped off the network"
- "Here are the long-lived sessions for comparison — same server, same code, different network conditions"
- "The server was sending pings every 2 seconds right up until the close — the last successful pong was X seconds before death"

### Step 4: File a mobile issue for the client fixes

Based on the evidence:

- Enable the liveness monitor (uncomment `startLivenessMonitor()` body)
- Add exponential backoff to the reconnect interval
- Add a max retry cap with longer delays
- Differentiate close codes — don't reconnect on clean 1000 from server shutdown
- Wire up the dead `reconnectAttempts` counter
