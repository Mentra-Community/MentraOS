# Post-Mortem: WebSocket Liveness Detection (Issue 034/035)

**Date:** February 16, 2026
**Author:** Isaiah Ballah, Claude
**Status:** Server fix deployed to debug/dev/staging. Client fix on branch `cloud/ping-pong-fixes`. Prod rollout pending.

---

## Summary

WebSocket connections between the mobile client and cloud were dying silently, causing session disposal and killing all running apps. Users experienced "apps stopped and won't start" with no way to recover short of restarting. This post-mortem covers the root cause, the fix, and the measured impact.

---

## The Problem

The mobile client's WebSocket connection to cloud passes through three layers:

```
Mobile App ──→ Cloudflare ──→ nginx Ingress ──→ Cloud Pod (:80)
```

The Kubernetes nginx ingress controller defaults `proxy-read-timeout` and `proxy-send-timeout` to **60 seconds**. After audio was migrated off the WebSocket to LiveKit/UDP (Q2 2025), and client→cloud communication was progressively moved from WebSocket to REST requests, the WS became primarily a cloud→client channel. During idle periods between display events and transcriptions, neither side was sending data — and nginx would kill the connection after 60 seconds of silence.

When a connection died, the mobile client had no way to detect it quickly. It relied entirely on OS-level TCP keepalive, which takes **30–120+ seconds on Android** (worse on Samsung devices with battery optimization). The server's grace period for reconnection is **60 seconds**. The math doesn't work:

```
WS goes idle → nginx kills at 60s → Client doesn't notice (30-120s) → Grace period expires (60s) → Session disposed → All apps killed
```

---

## The Fix

### Server-side: App-level pings (deployed Feb 13 to debug, Feb 16 to dev/staging)

The server now sends `{"type": "ping"}` every 2 seconds on the glasses WebSocket. The client responds with `{"type": "pong"}` via `SocketComms.handle_ping`. This bidirectional traffic prevents both nginx timeouts and Cloudflare's 100-second idle timeout.

### Server-side: nginx annotation fix (deployed Feb 16 to dev/staging)

Porter `ingressAnnotations` in `porter.yaml` bump both timeouts to 3600 seconds as defense-in-depth. The separate `ws-ingress-*.yaml` Kubernetes manifests (which had default 60s timeouts) were deleted from all non-prod clusters via `porter kubectl`.

### Client-side: Liveness detection (branch `cloud/ping-pong-fixes`, not yet released)

`WebSocketManager.ts` now tracks `lastMessageTime` on every incoming message. A repeating timer checks every 2 seconds whether the last message is older than 4 seconds. If so, the connection is force-closed and reconnection starts immediately — detecting dead connections in **4–6 seconds** instead of 30–120+ seconds.

No client-side ping sender is needed. The server's 2-second pings already generate bidirectional traffic (server→ping, client→pong). Omitting the client ping sender saves battery on mobile.

---

## Proof: The 60-Second Pattern Is Gone

### Before fix: matt.cfosse on debug, Feb 13 (20:53–21:05 UTC)

11 consecutive connections, every single one killed at exactly 58–60 seconds. The nginx timeout signature:

| Opened   | 1006 Close | Connection Lifetime |
| -------- | ---------- | ------------------- |
| 20:53:20 | 20:54:18   | **58s**             |
| 20:54:24 | 20:55:22   | **58s**             |
| 20:55:28 | 20:56:26   | **58s**             |
| 20:56:31 | 20:57:30   | **59s**             |
| 20:57:35 | 20:58:35   | **60s**             |
| 20:58:41 | 20:59:39   | **58s**             |
| 20:59:45 | 21:00:45   | **60s**             |
| 21:00:50 | 21:01:49   | **59s**             |
| 21:01:54 | 21:02:54   | **60s**             |
| 21:02:59 | 21:03:58   | **59s**             |
| 21:04:04 | 21:05:03   | **59s**             |

Every connection: open → exactly ~60 seconds → 1006 → reconnect → repeat. Like clockwork.

### After fix: matt.cfosse on debug, Feb 16 (18:00–20:00 UTC)

| Opened   | 1006 Close | Connection Lifetime |
| -------- | ---------- | ------------------- |
| 18:11:45 | 18:21:59   | **10 min**          |
| 18:23:26 | 18:28:08   | **5 min**           |
| 18:43:49 | 18:55:46   | **12 min**          |
| 18:57:37 | 18:58:33   | **56s**             |
| 19:09:45 | 19:10:25   | **40s**             |
| 19:41:49 | 19:48:20   | **6.5 min**         |
| 19:48:30 | 19:48:36   | **6s**              |
| 19:48:47 | 19:48:56   | **9s**              |
| 19:49:38 | 19:49:43   | **5s**              |
| 19:52:34 | 19:53:05   | **31s**             |

No 60-second cadence. Connection lifetimes are completely sporadic: 5s, 6s, 9s, 31s, 40s, 56s, 5 min, 6.5 min, 10 min, 12 min. The short-lived ones (5–9s) correlate with known office WiFi instability on Feb 16. The longer ones (5–12 min) are organic network events.

### After fix: caydenpierce4 on debug, Feb 16

| Opened   | 1006 Close | Connection Lifetime |
| -------- | ---------- | ------------------- |
| 16:21:02 | 17:17:01   | **56 min**          |
| 17:17:07 | 17:24:00   | **7 min**           |
| 17:24:06 | 17:31:52   | **8 min**           |
| 17:31:58 | 17:52:09   | **20 min**          |
| 17:59:28 | 17:59:36   | **8s**              |
| 17:59:50 | 17:59:58   | **8s**              |
| 18:18:25 | 19:19:06   | **61 min**          |

Connections living **56 minutes** and **61 minutes** — well past the old 60-second nginx timeout. The server pings are keeping the connection alive. The two 8-second kills are the same office WiFi instability.

### After fix: isaiahballah on debug, Feb 16

| Opened   | 1006 Close | Connection Lifetime |
| -------- | ---------- | ------------------- |
| 17:53:32 | 18:21:57   | **28 min**          |
| 18:50:02 | 19:07:54   | **18 min**          |

No 60-second pattern. Both connections lived well past the old timeout.

---

## Incident: Cayden's Bug Report (Feb 16, 11:21 AM PST)

> "Isaiah my apps are stopped and won't start" — Severity 5/5

**Timeline (UTC):**

| Time              | Event                                                                  |
| ----------------- | ---------------------------------------------------------------------- |
| 19:18:25          | Glasses WS connected to debug                                          |
| 19:19:05          | Transcription actively flowing to glasses (last server→client message) |
| **19:19:06**      | **1006 — connection severed (organic network event, NOT a timeout)**   |
| 19:19:06–19:22:21 | **Client does nothing for 3+ minutes** (no liveness detection)         |
| **19:20:06**      | **Grace period expires — session disposed, all 6 apps killed**         |
| ~19:21:00         | Bug report filed                                                       |
| 19:22:21          | Client finally reconnects — fresh empty session, no apps               |

The connection was carrying data **1.3 seconds** before the 1006. This was an organic network event, not a timeout. The server-side ping fix can't prevent organic network events — but the **client-side liveness detection** (not yet released) would have detected the dead connection in 4–6 seconds and reconnected well within the 60-second grace period. Apps would have stayed alive.

---

## What's Deployed vs What's Pending

### Deployed ✅

| Fix                                                 | Where                                 | When   |
| --------------------------------------------------- | ------------------------------------- | ------ |
| Server app-level pings (2s interval)                | debug                                 | Feb 13 |
| Server app-level pings                              | dev, staging                          | Feb 16 |
| nginx `ingressAnnotations` (3600s timeouts)         | dev, staging                          | Feb 16 |
| WS ingress manifests deleted                        | debug, dev, staging, us-west, us-east | Feb 16 |
| Server-side pong consumption (BetterStack spam fix) | branch `cloud/ping-pong-fixes`        | Feb 16 |

### Pending ⏳

| Fix                                                        | Where                              | Blocker                                |
| ---------------------------------------------------------- | ---------------------------------- | -------------------------------------- |
| nginx `ingressAnnotations`                                 | prod-us-central, east-asia, france | Needs prod rollout                     |
| WS ingress deletion                                        | prod-us-central, east-asia, france | Needs `porter kubectl` on each cluster |
| Client liveness detection (4–6s dead connection detection) | Mobile app release                 | Needs app build + release              |

---

## Expected Impact Once Fully Deployed

**Server pings** eliminate the 60-second timeout pattern (proven above). Connections now live minutes to hours instead of dying every 60 seconds.

**Client liveness detection** will handle the remaining organic 1006s (network events that can't be prevented). Instead of the client taking 30–120+ seconds to notice a dead connection, it will detect within 4–6 seconds and reconnect within 5 seconds. Total recovery: ~10 seconds — well within the 60-second grace period. Sessions survive, apps stay alive.

Together, these fixes should eliminate the "apps stopped and won't start" bug class entirely.

---

## Lessons Learned

1. **Traffic pattern changes expose hidden timeouts.** The WS was never idle when it carried audio. Moving audio to LiveKit/UDP and client→cloud messages to REST was the right call, but it exposed the 60s nginx timeout that was previously masked by constant bidirectional traffic.

2. **Don't rely on OS-level TCP keepalive for mobile.** Android TCP keepalive is too slow and too variable (30–120s depending on device, carrier, battery settings). Application-level liveness detection is the only reliable approach.

3. **Defense in depth.** Server pings reduce 1006 frequency (prevent timeout kills). Client liveness detection reduces 1006 impact (fast reconnect). nginx annotation bumps provide a safety net. Any one layer alone is insufficient.

4. **Server pings alone are NOT backward-compatible.** The client's `handle_ping` (which responds with pong) was only added on Feb 13, 2026. Clients older than that won't respond to server pings, meaning no client→server traffic flows, and `proxy-send-timeout` still kills the connection at 60s. The nginx annotation fix (`proxy-send-timeout: 3600`) is critical for old clients. Client liveness detection works independently of server pings — any incoming message resets the clock.

5. **Measure connection lifetimes, not just 1006 counts.** Raw 1006 counts are noisy (WiFi issues, user activity patterns). Connection lifetime distribution is the clear signal: a cluster at 58–60s = nginx timeout; sporadic = organic network events.
