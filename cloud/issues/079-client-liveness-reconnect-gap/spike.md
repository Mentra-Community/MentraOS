# Spike: Client Liveness Reconnect Gap After WebSocket Breaks

## Overview

**What this doc covers:** This doc separates two related but different problems: cloud-side disconnect causes, and the client-side failure to detect a dead glasses WebSocket and reconnect before the cloud disposes the session. It uses production evidence from April 1, 2026 showing that the user-visible "apps are broken / won't stop / won't start" state still happens when the session is gone but the client keeps acting like it is alive.
**Why this doc exists:** Team discussions keep collapsing all user-facing breakage into "the cloud crashed." That is incomplete. Cloud crashes can cause a WebSocket break, but they are not the reason the user stays broken for minutes. The durable failure mode is: any WebSocket break + slow client dead-socket detection + 60s grace expiry = disposed session and a client that no longer has a control plane.
**Who should read this:** Cloud engineers, mobile engineers, anyone investigating session loss, app controls, or WebSocket reliability.

**Depends on:**

- [034-ws-liveness](../034-ws-liveness/) — original client liveness gap and grace-period failure mode
- [069-ws-disconnect-observability](../069-ws-disconnect-observability/) — structured `ws-close` / `ws-reconnect` / `ws-dispose` events
- [073-rapid-disconnect-subscription-loss](../073-rapid-disconnect-subscription-loss/) — one concrete cloud-side signature of this class
- [061-crash-investigation](../061-crash-investigation/) and [070-soniox-timeout-crash](../070-soniox-timeout-crash/) — cloud crash/restart work that should remain separate

---

## The Problem In One Sentence

The core user-facing bug is not "the cloud crashed." The core bug is that when the glasses WebSocket breaks for any reason, the client can fail to notice and reconnect quickly, the cloud disposes the session after 60 seconds, and from that point onward app control/state APIs have nowhere to route.

---

## Background

There are two different problem classes:

### 1. Cloud crash / restart / churn

Examples:

- process crash
- pod restart
- transient unavailability
- unhandled rejection

This is a **server availability** problem. It matters, and we should keep reducing it. But when the cloud comes back in ~1 second, the user should still recover fine **if the client reconnects immediately**.

### 2. Client liveness / reconnect gap

Examples:

- organic network drop
- Cloudflare/network/TCP break
- phone OS/network transitions
- cloud restart that briefly severs the socket

This is a **client resilience** problem. The break itself is often unavoidable. The user-visible failure happens only when the client does not detect the dead socket and reconnect before the session grace window expires.

---

## Why These Must Stay Separate

Cloud crashes can contribute to the symptom by severing sockets. But they are not the root cause of the prolonged "broken app" experience.

The actual chain is:

```text
WebSocket breaks
  -> client does not reconnect quickly
  -> cloud grace timer expires
  -> UserSession disposed
  -> session-backed controls/state updates fail
  -> user sees "apps are broken" / stop-start controls don't work
```

If the client reconnects within a few seconds, a brief cloud restart is mostly survivable.

If the client does not reconnect, then even a tiny one-second outage becomes a minute-plus user-visible failure.

This means:

- **Reducing cloud crashes lowers one source of socket breaks**
- **Fast client dead-socket detection determines whether a break becomes a real user-facing incident**

We need both, but they solve different layers of the problem.

---

## What The Cloud Can Prove

The cloud cannot always prove exactly what the user tapped in the UI after the socket died, because current `requireUserSession` logging does not include the endpoint. But it can prove the higher-level failure state:

1. the WebSocket disconnected
2. the session was eventually disposed
3. after disposal, the same user kept hitting session-backed APIs

That is strong evidence that the client still believed it had a usable session or at least continued background/session-dependent behavior after the control plane was gone.

---

## Production Evidence (April 1, 2026)

All evidence below came from production Better Stack logs on **April 1, 2026** using the structured `ws-*` events from issue 069 and the existing `requireUserSession: No active session found` warnings.

### 1. The failure mode is still happening

In the last measurable 2-hour window:

- `ws-dispose`: **13 events / 13 users**
- users with both `ws-dispose` and later `No active session found` warnings: **7 users**

Those 7 users are intentionally anonymized in this public doc. The exact identities were verified in production logs during the investigation, but should not be committed to the repo.

This is the clearest current cloud-side proof that the failure mode still exists.

### 2. Concrete user example: session disposed, then client keeps acting alive

`user-A`

- **2026-04-01 21:22:23 UTC** — `ws-dispose`
  - `lastClose=1006`
  - `reconnects=0`
  - `silent=407520ms`
- **2026-04-01 21:24:15 - 21:24:16 UTC** — repeated
  - `requireUserSession: No active session found for user: [redacted]`

Interpretation:

- the socket had been dead long enough for the cloud to dispose the session
- afterward, the client still made session-backed requests
- this is exactly the "client didn't realize the control plane was gone" failure mode

### 3. Concrete user example: rapid break + failed recovery + disposal

`user-B`

- **21:23:06 UTC** — `ws-close`, code `1006`, `silent=1231ms`, session `5s`
- **21:23:11 UTC** — `ws-reconnect`, downtime `5295ms`
- **21:23:16 UTC** — `ws-close`, code `1006`, `silent=812ms`, session `15s`
- **21:22:56 - 21:23:00 UTC** — repeated `No active session found`
- **21:23:02 - 21:23:03 UTC** — repeated `Ignoring empty subscription update within reconnect grace window`
- **21:24:16 UTC** — `ws-dispose`, `lastClose=1006`, `silent=60815ms`

Interpretation:

- this user had both the reconnect instability from issue 073 **and** the broader client/session-liveness problem
- the cloud side shows multiple break/reconnect attempts, then eventual session disposal after instability
- the `No active session found` warnings shown here precede the disposal timestamp, so explicit post-disposal evidence is not included for this user — but the pattern of instability followed by disposal strongly suggests the same broken end-state seen with user-A

### 4. The current strongest detector

The best current cloud-side detector for this user-visible failure class is:

```text
ws-dispose
  +
same user later logs "requireUserSession: No active session found"
```

This is stronger than raw `1006` counts and broader than issue 073.

It answers the real question:

"Did the session die, and did the client keep behaving as if it still had one?"

---

## What Issue 073 Is, And What It Is Not

Issue 073 is useful, but it is not the whole class.

Issue 073 captures one cloud-side failure signature:

```text
rapid reconnect churn
  + reconnect grace window drops empty subscriptions
  + stale server/app subscription state
  + translation/captions stop
```

That is real. But the more general user-visible bug is:

```text
WebSocket break from any cause
  + client does not reconnect fast enough
  + session disposed
  + client/session-backed actions keep happening against no session
```

So:

- issue 073 is a **specific subtype**
- client liveness/reconnect gap is the **broader failure mode**

---

## Why Cloud Crash Work Still Matters

This doc is **not** arguing that cloud crashes are fine or irrelevant.

Cloud crash work still matters because:

- crashes sever sockets
- crashes create churn
- crashes increase the number of times clients must recover

But even if crash frequency goes way down, WebSocket breaks will still happen because of:

- mobile network changes
- OS/network stack behavior
- client bugs
- carrier/WiFi conditions
- infrastructure edge/network conditions outside the app process

That means we cannot define success as "make cloud crashes rare enough." We also need:

- dead-socket detection on the client
- fast reconnect
- graceful session preservation when reconnect is quick

Otherwise the system remains fragile to any disconnect source.

### Important current status

Cloud crash frequency has already improved substantially. The system went from crashing roughly every 30 minutes to roughly once per day, and each crash continues to be investigated and fixed as a separate server-reliability problem.

That progress matters. But it still does **not** solve the broader user-facing breakage, because most WebSocket breaks currently visible in production are **not** explained by cloud crashes. The cloud-side evidence shows ongoing `1006` closes, reconnect churn, and session disposals even when the dominant symptom is not a contemporaneous server crash.

So the correct message is:

- cloud crash work is succeeding and should continue
- cloud crashes are no longer the main explanation for most socket breaks
- fast client detection/reconnect is still required because WebSocket breaks will continue to happen from other causes

---

## Conclusions

| Finding                                                                                                | Confidence    |
| ------------------------------------------------------------------------------------------------------ | ------------- |
| The team is currently conflating two different problems                                                | **High**      |
| Cloud crashes can trigger the symptom but are not the root cause of prolonged user-visible brokenness  | **High**      |
| The user-visible failure happens when the client does not reconnect before session grace expiry        | **Confirmed** |
| This failure mode is still happening in production on April 1, 2026                                    | **Confirmed** |
| Issue 073 is a useful subtype, not the whole class                                                     | **High**      |
| The strongest current detector is `ws-dispose` followed by `No active session found` for the same user | **Confirmed** |

---

## Recommended Language For Team Discussion

Use this framing:

> We have two separate problems. First, cloud crashes and restarts increase how often sockets break. Second, and more importantly for user experience, clients are still not reliably detecting dead sockets and reconnecting before the 60-second grace window expires. The first problem raises the number of disconnect events. The second problem is what turns a short disconnect into "apps are broken and controls don't work." We need to keep reducing cloud churn, but we also need to treat fast client reconnect as the primary defense against all disconnect sources, including the ones we can never eliminate.

Short version:

> A cloud crash is one possible cause of a broken socket. It is not the reason the user stays broken. The user stays broken because the client missed the reconnect window and lost its session.

Additional framing if needed:

> Cloud reliability has improved a lot. We used to crash around every 30 minutes; now it is closer to once per day, and we keep fixing each root cause. That work is valuable and should continue. But most of the WebSocket breaks we are seeing now are not explained by cloud crashes. So if we only focus on crashes, users will still get stuck whenever a socket breaks for any other reason. The system needs to recover quickly from _any_ disconnect, not just avoid one specific cause.

---

## Next Steps

1. Track this failure mode separately from cloud crash work.
2. Add endpoint context to `requireUserSession` warnings so we can prove whether the client was trying to stop apps, update location, sync calendar, etc.
3. Add a reusable Better Stack query / `bstack` command for:
   `ws-dispose` + later `No active session found`
4. Treat issue 073 as one subtype under the broader "client liveness reconnect gap" category.
5. Re-prioritize client dead-socket detection and reconnect latency as a first-class reliability feature, not just a nice-to-have mitigation.
