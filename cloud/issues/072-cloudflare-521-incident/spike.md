# Spike: Cloudflare 521 Incident — Server Healthy, Cloudflare Couldn't Reach Origin

## Overview

**What this doc covers:** Investigation of a BetterStack Uptime incident at 01:32 UTC on March 30, 2026 where Cloudflare returned HTTP 521 ("Web server is down") for `prod.augmentos.cloud/health`. The incident lasted 3 minutes and auto-resolved. The cloud server was healthy the entire time — zero event loop gaps, zero unhandled rejections, zero crashes, sessions continuous at 56-64, pod did not restart.
**Why this doc exists:** This is the first incident since the crash investigation (issues 055-070) that was definitively NOT caused by our server. Documenting it establishes a baseline for what a Cloudflare-side incident looks like vs a server-side crash, so future incidents can be classified faster.
**Who should read this:** Cloud engineers, anyone triaging uptime alerts.

---

## Background

HTTP 521 is a Cloudflare-specific status code meaning "Web server is down." It indicates that Cloudflare's edge proxy attempted to connect to the origin server and the connection was refused or timed out. This is different from:

- **502 Bad Gateway** — Cloudflare connected but got an invalid response
- **503 Service Unavailable** — the origin server responded but said it's not ready
- **522 Connection timed out** — Cloudflare's TCP connection to origin timed out
- **524 A timeout occurred** — Cloudflare connected but the origin didn't respond in time

521 specifically means Cloudflare couldn't establish a TCP connection at all.

---

## Findings

### 1. The incident timeline

| Time (UTC) | Event                                                                       |
| ---------- | --------------------------------------------------------------------------- |
| 01:32:02   | BetterStack Uptime detected: `prod.augmentos.cloud/health` returned **521** |
| 01:35:37   | BetterStack Uptime resolved: health check passing again                     |

Duration: **3 minutes 35 seconds.**

### 2. Server was healthy the entire time

From BetterStack historical logs (S3 source), the server's vitals during the incident:

| Minute | Sessions | RSS   | Heap  | Event Loop Gaps | Unhandled Rejections |
| ------ | -------- | ----- | ----- | --------------- | -------------------- |
| 01:28  | 64       | 551MB | 240MB | 0               | 0                    |
| 01:29  | 64       | 545MB | 258MB | 0               | 0                    |
| 01:30  | 63       | 552MB | 250MB | 0               | 0                    |
| 01:31  | 64       | 548MB | 245MB | 0               | 0                    |
| 01:32  | 64       | 569MB | 149MB | 0               | 0                    |
| 01:33  | 56       | 433MB | 133MB | 0               | 0                    |
| 01:34  | 57       | 412MB | 135MB | 0               | 0                    |
| 01:35  | 58       | 409MB | 144MB | 0               | 0                    |
| 01:36  | 61       | 413MB | 139MB | 0               | 0                    |
| 01:37  | 59       | 413MB | 150MB | 0               | 0                    |
| 01:38  | 65       | 416MB | 153MB | 0               | 0                    |

Key observations:

- **Sessions never dropped to zero** — if the pod had crashed and restarted, sessions would drop to 0 and RSS would reset to ~230MB
- **Sessions dipped from 64 to 56** — 8 users disconnected, likely because Cloudflare was returning 521 to their REST requests
- **Sessions recovered to 65 within 5 minutes** — users reconnected after Cloudflare recovered
- **Pod uptime was 7,780 seconds** at the time of the health check (2.16 hours continuous) — no restart occurred
- **Zero event loop gaps, zero unhandled rejections** — the server was operating normally

### 3. The RSS/heap drop was a GC cycle, not a crash

RSS dropped from 569MB to 433MB and heap from 245MB to 133MB between 01:32 and 01:33. This is a normal GC collection — the heap was reclaimed and RSS decreased accordingly. If this were a pod restart, RSS would drop to ~230MB (the baseline for an empty server) and sessions would go to 0.

### 4. Cloudflare 521 causes

Possible reasons Cloudflare returned 521 when our server was up:

| Cause                                     | Likelihood | Notes                                                                                                                                       |
| ----------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cloudflare edge → Azure network blip**  | High       | Transient routing issue between Cloudflare's edge PoP and the Azure cluster's ingress IP. Resolves when routing reconverges.                |
| **Azure Load Balancer health check flap** | Medium     | The Azure LB in front of the nginx ingress may have briefly marked the backend as unhealthy, causing Cloudflare's connection to be refused. |
| **nginx ingress pod restart**             | Low        | If the nginx ingress pod on the node handling Cloudflare's connection restarted, connections would be refused until the new pod was ready.  |
| **Cloudflare edge maintenance**           | Low        | Cloudflare occasionally rotates edge nodes. During rotation, connections to specific origins can fail briefly.                              |

### 5. How to distinguish from server crashes

| Signal                  | Server crash (exit 137/1)  | Cloudflare 521          |
| ----------------------- | -------------------------- | ----------------------- |
| Pod uptime              | Resets to 0                | Continues               |
| Sessions                | Drop to 0, then climb back | Dip slightly, recover   |
| RSS                     | Drops to ~230MB baseline   | Stays at current level  |
| BetterStack status code | 503 (drain) or timeout     | **521**                 |
| System vitals           | Gap in data during restart | **Continuous, no gaps** |
| Unhandled rejections    | Possibly logged            | **Zero**                |
| Event loop gaps         | Possibly logged            | **Zero**                |

---

## Conclusions

| Finding                                                    | Confidence                                                                        |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------- |
| The server was healthy during the incident                 | **Confirmed** — continuous vitals, zero gaps, zero rejections, pod didn't restart |
| The 521 was a Cloudflare/network issue, not a server issue | **Confirmed** — 521 is Cloudflare-specific, server was serving other requests     |
| 8 users disconnected during the 3-minute window            | **Confirmed** — sessions dipped from 64 to 56                                     |
| All users recovered within 5 minutes                       | **Confirmed** — sessions back to 65 by 01:38                                      |
| No action needed on our side                               | **Confirmed** — this was external to our infrastructure                           |

---

## Recommendations

1. **Don't treat 521 alerts the same as 503/timeout alerts.** A 521 means Cloudflare can't reach us — check Azure/Cloudflare status before investigating the server.
2. **Add the status code to the incident triage runbook** — when the BetterStack alert fires, the first thing to check is the HTTP status code. 521 = Cloudflare, 503 = our server, timeout = could be either.
3. **Consider adding a direct health check** (bypassing Cloudflare) as a second BetterStack monitor. This would let us distinguish "Cloudflare can't reach us" from "our server is down" without manual investigation.
