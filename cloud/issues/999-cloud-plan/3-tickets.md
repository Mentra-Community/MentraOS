# Tickets

Who's working on what right now. Goals and context for each task.

**Last updated:** April 2, 2026

---

[← Overview](./1-overview.md) | [Shipped](./2-shipped.md) | **Tickets** | [Backlog](./4-backlog.md)

---

## Isaiah

### 1. Cloud v3 Deploy (048)

**Goal:** Deploy the cloud-side changes from the v3 branch to production. The cloud v3 must ship before SDK v3 because it includes fixes (subscription loss, reconnection handling) that benefit existing v2 MiniApps.

**Why:** The `cloud/issues-048` branch has cloud fixes that improve stability for all current users. It's designed to be backward compatible with v2 SDK apps. But there could be breaking changes, so every existing MiniApp on the cloud needs to be tested before deploying.

**Context:**

- Branch: `cloud/issues-048` / PR #2326
- Cloud v3 is meant to work with v2 SDK. Not a breaking SDK change.
- Codex review flagged sessionId format change that could break v2 apps. Needs to preserve legacy `userId-packageName` format.
- This is not the full "v3 cloud" (scaling, Redis, etc. still to come). It's the v3 branch deployed to production.

**Done when:** Branch merged to dev. Deployed to debug, then staging, then prod. All existing v2 MiniApps tested and working. Subscription loss bug confirmed fixed.

### 2. SDK v3 Ship (048)

**Goal:** Finish SDK v3, write the docs, publish to npm.

**Why:** SDK v3 fixes critical transcription bugs, adds 14 session managers, and is the foundation for killer MiniApps (video calls, live AI, Mentra Notes). Needs to ship for the MentraOS 3.0 announcement.

**Context:**

- Same branch as Cloud v3: `cloud/issues-048` / PR #2326
- Implementation status: `cloud/issues/048-sdk-v3/implementation-status.md` (on branch)
- All 14 managers built, v2 compat shims built, build passes
- Isaiah writes the docs first, then Aryan tests every feature against the docs

**Done when:** SDK published to npm. Migration guide and getting-started docs written. Aryan has validated every new feature.

### 3. Fix Log Volume + Log Cleanup (080)

**Currently working on this.**

**Goal:** Fix the BetterStack log ingestion spike (449 GB/day) and audit all Porter services for sensitive and verbose logs.

**Why:** The BetterStack default collector on US Central is running alongside our custom Vector Helm chart, collecting ALL container stdout with no filter. MiniApp containers (dashboard, captions) are flooding it. Cloud logs are also being double-ingested. This is costing ~$500/day.

**Context:**

- Two collectors running on US Central: our custom Vector (sends cloud-only logs to MentraCloud-Prod source) and BetterStack's default collector (sends everything to mentra-us-central source)
- France, East Asia, US West, US East collector sources exist in BetterStack but have zero logs (collectors were never installed on those clusters)
- MiniApp containers on US Central are extremely verbose at info level

**Done when:** Only one collector running per cluster. No double ingestion. All Porter services audited for sensitive and verbose logs. BetterStack daily ingestion back to a reasonable level.

## Aryan

### 1. WebSocket Liveness Error Codes (cloud + client)

**Currently working on this.**

**Goal:** When the phone's WebSocket to the cloud is broken, REST requests should get back a specific error code that tells the client exactly what's going on, not a generic 401 or 503.

**Why:** Right now the phone doesn't realize the WebSocket is dead. It keeps sending REST requests, gets back 401/503, and has no idea whether its session still exists or not. Users see "apps are broken" for minutes. The client needs the cloud to tell it two distinct things:

1. **Your session exists but your WebSocket is disconnected.** Everything is fine, just reconnect.
2. **Your session does not exist on this server.** The pod restarted, you're hitting the wrong region, or your grace window expired. Re-establish from scratch.

**Context:**

- The client liveness gap investigation is in `cloud/issues/079-client-liveness-reconnect-gap/spike.md`
- The WS liveness system (034/035) is already deployed, this builds on top of it
- The reconnection architecture spike on the `cloud/issues-048` branch covers the cloud-side session states in detail

**Done when:** Cloud returns distinct error responses for "session alive, WS down" vs "session gone." Client detects these and takes the right action (reconnect vs re-establish). Users stop seeing prolonged "broken" states after brief network blips.

### 2. SDK v3 Feature Testing

**After WebSocket liveness is done.**

**Goal:** Go through the SDK v3 docs that Isaiah writes and test every new feature of the v3 SDK.

**Why:** The v3 runtime is built but only tested with a smoke test app. We need someone who has built real MiniApps to validate the new API surface, find gaps in the compat layer, and confirm the docs are accurate.

**Context:**

- The v3 branch is `cloud/issues-048` (PR #2326)
- Implementation status and known bugs are in `cloud/issues/048-sdk-v3/implementation-status.md` on that branch
- The compat shims (`_V2*Shim` classes) should let existing v2 apps work without changes
- Isaiah will have the docs ready before this starts

**Done when:** Every feature documented in the SDK v3 docs has been tested. At least one real v2 MiniApp runs against v3 without breaking. Any gaps or bugs are documented.

## Yash

### 1. Cloud Observability and Stability

**Goal:** Take over cloud monitoring. Improve observability, investigate incidents, find and fix memory leaks, CPU spikes, and crashes.

**Why:** We're still crashing ~3 times a day on US Central. Someone needs to own monitoring and stability full-time so Isaiah can focus on SDK v3.

**Context:**

- Observability hygiene spike is in `cloud/issues/071-observability-hygiene/spike.md`
- Pod crash runbook is in `cloud/tools/bstack/runbooks/pod-crash.md`
- The cloud's own logs need noisy patterns downgraded from info/warn to debug
- `disposedSessionsPendingGC` is creeping back to 7-10, indicating more timer/closure leaks
- Weekly error audit SOP and runbooks are in `cloud/tools/bstack/runbooks/`

**Done when:** Vector only collects logs from containers we care about. BetterStack daily ingestion back under 25 GB. Crash frequency reduced. Memory leaks identified and fixed. Noisy log patterns no longer shipped at info level.

### 2. Scaling Phase 1: Enable US West and US East

**Goal:** Get real user traffic flowing to the US West and US East instances that are already deployed.

**Why:** The instances are running on `api.mentraglass.com` but nobody's connected to them because the mobile client still points to the old `api.mentra.glass` load balancer. We shipped 1,000 Mentra Live units and all the US traffic is hitting one region.

**Context:**

- Scaling investigation is in `cloud/issues/032-cloud-scaling/`
- Yash already has context on multi-region deployment from the China cloud migration
- This is primarily a client + infrastructure coordination task, making the client use the right global API endpoints

**Done when:** Mobile client points to the new load balancer. US users are distributed across US Central, US West, and US East. We can see traffic in all three regions.

### 3. MongoDB Read Replicas

**Goal:** Set up MongoDB Atlas read replicas in each cloud region so non-cached database reads hit a local replica instead of crossing the network.

**Why:** The in-memory app cache handles the hot path (already built and deployed), but remaining DB calls (user lookups, settings, etc.) still have 80ms (US) to 370ms (East Asia) round-trip times. Local read replicas would drop these to single-digit milliseconds.

**Context:**

- The latency investigation is in `cloud/issues/062-mongodb-latency/spike.md`
- Yash has context on multi-region infrastructure from the China cloud migration
- This is Atlas configuration plus updating the cloud's MongoDB connection strings to use read preference routing

**Done when:** Each region reads from a local MongoDB replica. Non-cached DB query latency drops to single-digit ms in all regions.

---

[← Shipped](./2-shipped.md) | [Backlog →](./4-backlog.md)
