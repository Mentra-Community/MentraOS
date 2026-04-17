# Cloud Plan

**Last updated:** April 14, 2026

This is the living plan for the MentraOS cloud.
Updated weekly.

The cloud is the backend that connects smart glasses, phones, and third-party mini apps.
It handles WebSocket connections, UDP audio streaming, speech-to-text transcription (via Soniox), photo capture, app lifecycle, and the SDK that developers build against.
Every live captions user on G1, G2, or Mentra Live depends on the cloud being stable and fast.

---

# Cloud Department OKRs — Q2 2026

The cloud is infrastructure.
It doesn't directly grow WAU or sell units.
But it's the thing that breaks when growth hits, and the thing that blocks developers from building apps.
Every objective here exists because a company OKR fails without it.

**Company Objective 1 (Grow MentraOS):**
5K WAU, MentraOS 3.0, MiniApp Store, 3 third-party apps

**Company Objective 2 (Sell Mentra Live):**
3,500 units, B2B pilots, Device Bridge / Edge SDK

---

## Objective 1: Make the cloud and SDK ready for 5,000 users

Supports: Grow MentraOS, Sell Mentra Live

The cloud handles real production traffic across three active regions.
All US traffic hits a single pod.
The SDK v3 is in alpha.

To reach 5K WAU, the cloud needs to stop crashing, the SDK needs to be stable, and traffic needs to be distributed.

**Key Results:**

- SDK v3 tested and published as stable (`@mentra/sdk@latest`)
- All internal mini apps (captions, dashboard, livestreamer, etc.) migrated to v3 SDK
- Cloud: zero OOM kills for 7+ consecutive days
- US East live and receiving real user traffic via new load balancer
- MongoDB read replicas deployed in Europe and East Asia
- Soniox transcription available in all active regions

---

## Objective 2: Make failures fast, visible, and recoverable

Supports: Grow MentraOS (user retention), 3 third-party apps (developer experience)

Today when something fails (photo request, audio playback, stream start/stop), the system silently waits 30-45 seconds and then times out.
No indication of which hop failed.
Developers can't debug their apps.
Users think the glasses are broken.

This is the #1 quality-of-experience problem across the entire stack, and the cloud is the one place we can fix it end-to-end for our layer.

**Key Results:**

- Every cloud-mediated request (photo, audio, stream start/stop) has per-hop deadlines and returns structured errors identifying which hop failed.
  No more silent 30-second timeouts.

- Cloud pre-checks connection state before forwarding requests (phone WS connected? glasses connected? camera available?) and rejects immediately with specific reason if preconditions fail.

- Failure modes for every cloud request path are documented and each has a defined behavior (fail fast with reason, retry with backoff, or degrade gracefully).

- Scaling spike and testing spike completed with written plans for stateless cloud architecture and E2E test harness.

---

## What's not in Q2 OKRs but is coming

**OEM Plan**

Multiple OEMs have confirmed they want to build on MentraOS.
Isaiah is working on an OEM plan and will share with the team tomorrow.
It covers what OEMs need, what we need, and a design proposal for how to support them.

**Agent-friendly developer experience**

The mentra CLI already handles app creation, publishing, org management, and multi-cloud switching.
The MCP server already gives AI coding assistants access to docs inside IDEs.
Next steps are tightening the loop so an AI agent can go from prompt to running app without leaving the terminal.

---

# Cloud Health

- **Regions:** Both Cloudflare LBs now have 1-hour session affinity. Previously 23hr or none, causing mid-session region switches. New LB still needs final verification for next mobile release.
- **Stability:** Much more stable. Cloud still occasionally gets killed by Kubernetes (memory climbs until SIGKILL). Yash investigating ([OS-1261](https://linear.app/mentralabs/issue/OS-1261)). Increased memory limit to allow heap snapshots. Next approach: K8s sidecar for external heap snapshots.
- **Missing observability:** WS liveness spec (034) was merged without the REST health-check fallback. We can't track why pings fail or how often. Needs to be added back as a ticket.
- **SDK:** V3 alpha.3 published. Fixes from developer feedback. Docs being updated. Test checklist ready for team.

---

# Recently Shipped

**SDK v3 alpha.3 published** ([OS-1262](https://linear.app/mentralabs/issue/OS-1262))

- Fixed DeviceManager double-registration (every handler fired twice, every log doubled)
- Fixed onSession webhook timeout ([OS-1284](https://linear.app/mentralabs/issue/OS-1284), slow startup no longer causes "Can't connect")
- Fixed stop reason codes ([OS-1290](https://linear.app/mentralabs/issue/OS-1290), system stops now send `"system_stop"` not `"user_disabled"`)

**Developer Console** ([OS-1286](https://linear.app/mentralabs/issue/OS-1286))

- "Use custom URL" toggle now persists correctly

**Cloudflare LB fix** ([issue 095](cloud/issues/095-cloudflare-session-affinity/))

- Fixed mid-session region switching by adding 1-hour session affinity to both LBs
- Traced from a user bug report where apps failed to open in East Asia

**Transport observability scoped** ([issue 096](cloud/issues/096-transport-observability-and-error-model/))

- Audited all 17 sendMessage call sites across 6 SDK managers (14 fire-and-forget)
- Found two root cause bugs: cloud `sendError` kills the WS for operational errors ([OS-1246](https://linear.app/mentralabs/issue/OS-1246)), v3 SDK ignores close codes entirely

**Developer feedback** (Leo, camera/WHEP app — [OS-1281](https://linear.app/mentralabs/issue/OS-1281) through [OS-1291](https://linear.app/mentralabs/issue/OS-1291))

- 11 issues documented, several fixed in alpha.3
- Identified stream status API mismatch: implementation doesn't match the documented v3 API

**Porter mini app cleanup** ([OS-1251](https://linear.app/mentralabs/issue/OS-1251), [Google Doc](https://docs.google.com/document/d/1WztlCa9lCueo7KZytxGuXeV05zRMSKa3J3YhrG48wNM/edit?tab=t.0))

- Inventoried all 95 apps across 5 clusters. ~28 delete, ~15 review, ~50 keep.
- 8 pods stuck Pending (6 GB for games). `cloud-livekit` still running at 5 cores despite removal.

**Other**

- Fixed duplicate BetterStack collector, cleaned up excessive logs, streamer bug fixes
- Cloud v3 branch merged (PR #2326)

---

# Active Work

**SDK v3 Testing** ([OS-1262](https://linear.app/mentralabs/issue/OS-1262)) (Isaiah / Yash / Aryan)
Alpha.3 published. Testing every manager against real hardware. Docs being updated from developer feedback.

**Cloud Crash Investigation** ([OS-1261](https://linear.app/mentralabs/issue/OS-1261)) (Yash)
Kubernetes is killing the process. Memory climbs until SIGKILL. Increased memory limit to try heap snapshots. Next: K8s sidecar for external snapshots. Also looking at Cloudflare health check failures rerouting traffic.

**Transport Observability** ([096](cloud/issues/096-transport-observability-and-error-model/spike.md))
Spike complete. Found two root bugs: cloud `sendError` kills the WS for operational errors, SDK ignores close codes. 10 sub-issues scoped. This delivers OKR Objective 2.

**Testing Plan Spike** ([OS-1267](https://linear.app/mentralabs/issue/OS-1267)) (Isaiah)
Scoping E2E test harness. Same client libraries feed both the OEM SDK and the test infrastructure.

**OEM Plan** (Isaiah)
Working on design proposal. Will share with team tomorrow.

**Porter Cleanup** ([OS-1251](https://linear.app/mentralabs/issue/OS-1251), [inventory](cloud/issues/097-porter-mini-app-cleanup/inventory.md))
Inventory done. Needs team review on ~15 yellow items. Ready to delete the ~28 confirmed deprecated.

---

# Planned Work

[OS-1262](https://linear.app/mentralabs/issue/OS-1262): Test V3 SDK @mentra/sdk 3.0.0-alpha
Isaiah / Yash / Aryan

[OS-1263](https://linear.app/mentralabs/issue/OS-1263): Setup MongoDB read-only replicas in Europe and East Asia
Aryan / Yash

[OS-1264](https://linear.app/mentralabs/issue/OS-1264): Setup load balancer for US-East, verify new load balancer is fixed
Isaiah

[OS-1265](https://linear.app/mentralabs/issue/OS-1265): Soniox multi-region
Ph

[OS-1267](https://linear.app/mentralabs/issue/OS-1267): Spike - Cloud and SDK testing plan
Isaiah / Aryan

[OS-1266](https://linear.app/mentralabs/issue/OS-1266): Spike - Cloud scaling plan
Isaiah

[OS-1261](https://linear.app/mentralabs/issue/OS-1261): Investigate cloud crashes / BetterStack alerts
Yash

[OS-1268](https://linear.app/mentralabs/issue/OS-1268): Refactor mini apps to use V3 SDK
Aryan

[OS-1269](https://linear.app/mentralabs/issue/OS-1269): Self-hosting cloud, external developer guide
Yash (later)

[OS-1246](https://linear.app/mentralabs/issue/OS-1246): Streaming SDK "Need WiFi" should not kill the websocket
Isaiah

**New:** OEM cloud plan spike
Isaiah

**New:** Remaining developer feedback tickets
[OS-1281](https://linear.app/mentralabs/issue/OS-1281): Camera cleanup signal
[OS-1285](https://linear.app/mentralabs/issue/OS-1285): WHEP undocumented requirements
[OS-1288](https://linear.app/mentralabs/issue/OS-1288): False 1008 disconnect
[OS-1283](https://linear.app/mentralabs/issue/OS-1283): Duplicate stream events
[OS-1287](https://linear.app/mentralabs/issue/OS-1287): @roamhq/wrtc Node 22
[OS-1289](https://linear.app/mentralabs/issue/OS-1289): Cloudflare Stream DNS
[OS-1291](https://linear.app/mentralabs/issue/OS-1291): No local dev / sandbox mode

---

# Backlog

## Ship SDK V3 ([OS-1102](https://linear.app/mentralabs/issue/OS-1102))

SDK CI/CD pipeline with automated publishing via changesets.
Beta on dev merge, rc on staging, latest on main with approval.

SDK documentation: migration guide, rewritten getting-started, npm README, API reference.
Being updated based on developer feedback.

SDK release SOP: versioning, deprecation policy, rollback procedures.

SDK V3 announcement.

## Cloud Scaling

[Cloud Scaling Plan](https://docs.google.com/document/d/18Z9-hslxdPMNsBjabwybeHok9yiHnACAK7z43UgeHkA/edit?tab=t.0#heading=h.lfu6av9mh62d)

## E2E Testing

[Cloud & SDK Testing Plan](https://docs.google.com/document/d/1dV3h35PD8p8YbDkeDdDtSCJXln17UbYyTLKvjmyrRyY/edit?tab=t.0#heading=h.i9iupu19mgx1)

## OEM Architecture

Part of the OEM plan Isaiah is preparing.
Details will be shared with the team.

## Transport Observability Implementation (096)

After the spike, the actual implementation work:

- Split cloud `sendError` into operational vs fatal
- Add close code awareness to v3 SDK
- Add fail-fast precondition checks to CameraManager and other managers
- Normalize stream status events
- Add cloud-side fast rejection for photo/stream/audio requests
- Request ID propagation across hops

## Porter Cleanup Execution (097)

Delete the ~28 confirmed deprecated apps.
Fix resource requests on Pending pods (6 GB for games is wrong).
Review the ~15 yellow items with team.

---

# Risks

## Cloudflare load balancer + Kubernetes readiness cascade

Even with session affinity fixed, there's an interaction between Cloudflare health checks and Kubernetes readiness probes.

If the cloud pod's `/health` endpoint is slow (e.g. during a memory spike before Kubernetes kills the process):

1. Kubernetes marks the pod not-ready
2. nginx stops routing to it
3. Cloudflare may see the health check fail and route traffic to a different region entirely

This can cause mid-session region switches even with session affinity enabled.

The WS liveness REST fallback (from [issue 034](cloud/issues/034-ws-liveness/) spec) would give us a trackable data point in BetterStack to see how often this happens and why pings are failing.
Rather than only finding out after the fact that Kubernetes killed the process.

## Silent failures across the stack

When something fails, the system silently waits 30-45 seconds then times out.
No indication of which hop failed.

[Issue 096](cloud/issues/096-transport-observability-and-error-model/) has the full audit and fix plan.
The two root cause bugs (cloud `sendError` kills WS, SDK ignores close codes) affect both v2 and v3 apps.

## Developer attrition

A developer (Leo) put dozens of hours into a camera/streaming app and hit 11 issues serious enough that he paused development.

Several are fixed in alpha.3.
The remaining ones (camera cleanup signal, WHEP documentation, false disconnect codes) are scoped and prioritized.
We need to close these and reach back out.
