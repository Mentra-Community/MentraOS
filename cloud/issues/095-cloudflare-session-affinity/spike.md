# 095 — Cloudflare Session Affinity & Mid-Session Region Switching

## Summary

Users are being rerouted to a different cloud region mid-session by the Cloudflare load balancer. This tears down their active session (apps stop, subscriptions lost, 503 errors on REST endpoints) and forces a full session rebuild on the new region. The user experiences 30–60 seconds of "everything broken" before things recover.

Session affinity was previously enabled (`ip_cookie`, 23-hour TTL) but was deliberately disabled because it was pinning users to the wrong continent for extended periods. With no affinity at all, Cloudflare's geo-steering can reroute any request independently — including mid-session.

## Trigger Incident

Bug report from philippe@mentraglass.com (Apr 13, 2026):

> "The app failed several times to open on prod cloud before succeeding"

Investigation traced the issue to a mid-session region switch from East Asia to US Central.

## What Happened (Reconstructed from Logs)

Timeline (all times UTC, Apr 13 2026):

| Time        | Event                                                                                  | Region     |
| ----------- | -------------------------------------------------------------------------------------- | ---------- |
| 22:35:35    | App stopped normally (1757ms teardown — slow)                                          | east-asia  |
| 22:36:00    | Glasses connection closed — 0-second session, immediate disconnect                     | east-asia  |
| 22:36:01–03 | "WebSocket not open", "DisplayManager not ready", subscription permissions rejected ×3 | east-asia  |
| 22:36:21    | Glasses connection closed (76s session)                                                | east-asia  |
| 22:37:27    | `POST /apps/com.mentra.streamer/start` → **401 Unauthorized**                          | us-central |
| 22:37:30    | Same request retried → **401 Unauthorized**                                            | us-central |
| 22:38:04    | Glasses connection closed. `OWNERSHIP_RELEASE` reason: **switching_clouds**            | us-central |
| 22:38:05    | "Started 1/1 previously running apps" — .dev variant triggered                         | us-central |
| 22:38:33    | App started successfully (28ms)                                                        | us-central |
| 22:39+      | Stable — UDP audio flowing                                                             | us-central |

Key evidence:

- The SDK sent `OWNERSHIP_RELEASE` with reason `switching_clouds` — this fires when a new cloud region sends a start webhook for a session that already exists on another region
- REST requests hit US Central with no active session → 503 "No active session" (correct behavior — the session didn't exist on that region yet)
- The 0-second session at 22:36:00 was the phone trying to establish on the old region while being rerouted

## The 503 Errors

The 503s are **not** from Kubernetes readiness probe failures. The `/health` endpoint has zero MongoDB calls — it only reads in-memory session state and `process.memoryUsage()`. The `/livez` endpoint just returns `"ok"`.

The 503s come from the cloud's own client middleware: when the phone makes REST requests (`/api/client/location`, `/api/client/device/state`, `/api/client/audio/configure`) against a region that has no session for that user, the middleware correctly returns 503 "No active session."

During a region switch, there's a window where:

1. The old region's session is being torn down
2. The new region's session hasn't been created yet
3. The phone's background HTTP polling (location updates, device state) hits whichever region Cloudflare routes it to
4. Both regions return 503 — the old one because the session is disposing, the new one because no session exists yet

## Why Session Affinity Was Disabled

From the issue 065 investigation:

> Session affinity was `ip_cookie` with 23hr TTL — **disabled** (was pinning users to wrong continent)

The 23-hour TTL meant a user who first connected from one location would be pinned to that region's origin for nearly a full day, even if they moved or if Cloudflare's geo-steering would have picked a better origin. A user in Asia getting pinned to US Central for 23 hours is worse than occasional region switches.

## Load Balancer State

Two Cloudflare LBs exist. The mobile app currently uses `api.mentra.glass`; the next client release switches to `api.mentraglass.com`.

Pools (shared across both LBs):

- `uscentral` — Azure Central US (healthy)
- `france` — Azure France (healthy)
- `asiaeast` — Azure East Asia (healthy)
- `us-west` — Azure West US (healthy, only on mentraglass.com)
- `us-east` — Azure East US (no health monitor configured)

### Before (at time of incident)

|                       | api.mentra.glass                | api.mentraglass.com |
| --------------------- | ------------------------------- | ------------------- |
| Affinity              | `ip_cookie` — 23 hour TTL       | `none`              |
| Steering              | `geo`                           | `proximity`         |
| Failover across pools | `false`                         | `true`              |
| Pools                 | 3 (uscentral, france, asiaeast) | 4 (+ us-west)       |

The old LB had a 23-hour TTL that could pin users to the wrong continent for a full day. The new LB had zero affinity — every request routed independently, causing mid-session region switches.

### After (applied Apr 13, 2026)

|                       | api.mentra.glass                | api.mentraglass.com             |
| --------------------- | ------------------------------- | ------------------------------- |
| Affinity              | `ip_cookie` — **1 hour TTL** ✅ | `ip_cookie` — **1 hour TTL** ✅ |
| Steering              | `geo`                           | `proximity`                     |
| Failover across pools | **`true`** ✅                   | `true` ✅                       |
| Pools                 | 3 (uscentral, france, asiaeast) | 4 (+ us-west)                   |

Changes made:

- `mentra.glass`: TTL reduced from 23 hours → 1 hour, failover enabled (was `false`)
- `mentraglass.com`: Session affinity added (was `none`), TTL set to 1 hour

The 1-hour TTL keeps users pinned during any realistic session without locking them to the wrong continent overnight. Failover ensures traffic routes to the next best pool if a region goes unhealthy.

## Separate Bug: 401 on Production App

During this incident, `POST /apps/com.mentra.streamer/start` returned 401 Unauthorized twice, while the `.dev` variant of the same app started fine. This is a separate auth/registration issue — the production app's API key may be misconfigured or different from the dev variant. Should be investigated independently.

## Separate Issue: Webhook 404 for Third-Party App

The webhook for `fr.fdesousa.captions` returned 404 after 2 retries during session reconnect. That app's server is either down or its webhook URL is stale.

## Proposed Fix

### Option A: Re-enable session affinity with a shorter TTL

Enable `ip_cookie` affinity with a 1–2 hour TTL instead of 23 hours. This keeps a user on the same origin during an active session without pinning them for a full day.

Trade-off: a user who genuinely moves continents (rare during an active glasses session) would be stuck on the old region for up to 2 hours. Acceptable for the use case — nobody flies across an ocean while wearing smart glasses.

### Option B: Header-based routing

The phone sends a header (e.g. `X-Mentra-Region: east-asia`) with its current session's region. Cloudflare routes based on that header. First connection uses geo-steering; subsequent requests stick to the assigned region.

Trade-off: requires mobile client changes and Cloudflare Workers or Transform Rules to implement.

### Option C: Graceful region handoff

Instead of preventing region switches, make them seamless:

1. New region detects user had a session elsewhere (check database)
2. New region pre-warms session state before tearing down the old one
3. Apps are restarted proactively instead of waiting for the user to notice

Trade-off: significant cloud-side work. Requires session state to be readable across regions (it already is — shared MongoDB). But this is the most resilient option and aligns with the stateless cloud scaling direction.

### Recommendation

**Start with Option A** — re-enable `ip_cookie` with a 1-hour TTL on both `api.mentra.glass` and `api.mentraglass.com`. This is a single Cloudflare API call per LB and immediately stops mid-session region switches for the vast majority of users. It can be done today without any code changes.

Then pursue Option C as part of the cloud scaling work (stateless instances with Redis pub/sub), which would make region switches seamless regardless of LB behavior.

## Action Items

- [x] Audit both Cloudflare LB configs — compare steering policy, pools, affinity, health monitors
- [x] Re-enable session affinity with 1-hour TTL on both LBs
- [x] Enable failover across pools on `api.mentra.glass` (was `false`)
- [ ] Add health monitor to US East pool
- [ ] Investigate the 401 on `com.mentra.streamer` production app (separate issue)
- [ ] Verify the webhook URL for `fr.fdesousa.captions` (separate issue)
- [ ] Consider aligning steering policy (`geo` vs `proximity`) across both LBs before client migration

## References

- [034 — WS Liveness Spike](../034-ws-liveness/spike.md) — documents Cloudflare edge rebalancing as uncontrollable cause of disconnects
- [065 — Open Investigations](../065-open-investigations/spike.md) — documents the LB domain mismatch and session affinity removal
- [072 — Cloudflare 521 Incident](../072-cloudflare-521-incident/) — prior Cloudflare-caused incident where server was healthy
- [032 — Cloud Scaling](../032-cloud-scaling/) — long-term multi-region architecture
- [062 — MongoDB Latency](../062-mongodb-latency/) — cross-region DB latency contributing to slow app starts during handoff
