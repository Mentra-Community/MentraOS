# Work

All active, planned, and backlog items. Active work at the top, backlog at the bottom.

**Last updated:** April 8, 2026

---

[<- Overview](./overview.md) | [Shipped](./shipped.md) | **Work** | [OKRs](./okrs.md)

---

## How to read this

Every item includes links to all relevant context: issue folders, spikes, specs, runbooks, and prior art. If you're picking up work, everything you need should be linked here. If it's not, that's a bug in the doc - flag it.

---

## Active

### Isaiah

#### SDK v3 Testing (OS-1262)

**Goal:** Test every API exposed in `@mentra/sdk@3.0.0-alpha` against real hardware and the live cloud.

**Why:** The v3 runtime is built and published as alpha. Before it goes stable, every manager and lifecycle edge case needs to be validated. Issue 092 flagged specific regressions (PCM16 encoding broken, LED blink dropped, permission events dropped, 18 doc issues).

**Context:**

- SDK v3 implementation status: `cloud/issues/048-sdk-v3/implementation-status.md`
- Known regressions audit: `cloud/issues/092-sdk-v3-alpha1-regressions-and-doc-gaps/`
- v3 runtime architecture (transport abstraction, routing, subscriptions): `cloud/issues/048-sdk-v3/private-runtime-architecture.md`
- Session manager reference: `docs/app-devs/core-concepts/session.mdx`
- Streaming bugs to verify fixed: `cloud/issues/085-orphaned-stream-cleanup/`, `cloud/issues/087-managed-stream-status-not-delivered-on-reconnect/`, `cloud/issues/091-unified-onStreamStatus-missing-managed-events/`

**Done when:** Every manager on `MentraSession` has been exercised. Regressions from 092 are confirmed fixed. Streaming lifecycle (start, stop, reconnect, error) works end to end. Test results documented.

#### Setup Load Balancer for US-East and Verify New LB (OS-1264)

**Goal:** Get the new `api.mentraglass.com` load balancer fully working so US-East can receive real traffic.

**Why:** All US traffic is hitting US Central. US West and US East are deployed but idle because the client still points to the old load balancer. We had issues with missing properties in Porter. Need to verify the new LB is correct for the next mobile client release.

**Context:**

- Scaling plan: `cloud/issues/032-cloud-scaling/`
- Infrastructure reference: `cloud/.architecture/infra.md`
- Porter configs: `cloud/porter-us-east.yaml`, `cloud/porter-us-west.yaml`

**Done when:** New load balancer verified working. US-East receiving traffic when mobile client ships with updated endpoints.

#### Cloud & SDK Testing Plan Spike (OS-1267)

**Goal:** Write the testing plan for the cloud and SDK. Define what we test, how, and what infrastructure we need.

**Why:** Zero automated tests today. Every deploy is manual. Regressions are caught by users. We need a concrete plan before building anything.

**Context:**

- Current testing plan shell: `cloud/issues/999-cloud-plan/plans/cloud-testing.md`
- CLI (useful for test setup/teardown): `cloud/packages/cli/`
- SDK quickstart (the flow we need to automate): `docs/app-devs/getting-started/quickstart.mdx`
- Example apps (candidate test apps): `docs/app-devs/getting-started/example-apps.mdx`

**Done when:** Written spike covering: what we can test without mobile team coordination, test mini app design, cloud test modes, mocked vs real transcription tiers, CI integration approach.

#### Cloud Scaling Plan Spike (OS-1266)

**Goal:** Write the scaling plan. Define the path from current single-process-per-region to stateless cloud with horizontal scaling.

**Why:** Mentra Live units actively shipping, targeting significant growth. Each region is a single Bun process. One crash kills everyone. Need a concrete plan for stateless instances.

**Context:**

- Current scaling plan shell: `cloud/issues/999-cloud-plan/plans/cloud-scaling.md`
- Scaling investigation: `cloud/issues/032-cloud-scaling/`
- Graceful shutdown (already shipped): `cloud/issues/063-graceful-shutdown/`
- Infrastructure reference: `cloud/.architecture/infra.md`
- SDK v3 transport abstraction (enables future local runtime): `cloud/issues/048-sdk-v3/private-runtime-architecture.md`

**Done when:** Written spike covering: stability prerequisites, multi-region traffic distribution, stateless cloud architecture with Redis pub/sub, what moves to the Puddle (local runtime) vs what stays in the cloud (SFU).

---

### Aryan

#### WebSocket Liveness Error Codes (cloud + client)

**Currently working on this.**

**Goal:** When the phone's WebSocket to the cloud is broken, REST requests should get back a specific error code that tells the client exactly what's going on.

**Why:** Right now the phone doesn't realize the WebSocket is dead. It keeps sending REST requests, gets 401/503, and has no idea whether its session still exists. Users see "apps are broken" for minutes. The client needs two distinct signals:

1. Your session exists but your WebSocket is disconnected. Just reconnect.
2. Your session does not exist on this server. Re-establish from scratch.

**Context:**

- Client liveness gap investigation: `cloud/issues/079-client-liveness-reconnect-gap/spike.md`
- WS liveness system (already deployed): `cloud/issues/034-ws-liveness/`
- Reconnection architecture: `cloud/issues/048-sdk-v3/archive/reconnection-architecture-spike.md`

**Done when:** Cloud returns distinct error responses for "session alive, WS down" vs "session gone." Client detects these and takes the right action. Users stop seeing prolonged broken states after brief network blips.

#### Setup MongoDB Read-Only Replicas (OS-1263)

**Goal:** Deploy MongoDB Atlas read replicas in Europe and East Asia.

**Why:** Non-cached DB reads have 80ms round-trip in US, up to 370ms in East Asia. Local read replicas drop this to single-digit ms.

**Context:**

- MongoDB latency investigation: `cloud/issues/062-mongodb-latency/spike.md`
- In-memory app cache (already deployed, handles hot path): `cloud/issues/062-mongodb-latency/`
- Infrastructure reference: `cloud/.architecture/infra.md`

**Done when:** Each region reads from a local MongoDB replica. Non-cached DB query latency in single-digit ms across all regions.

---

### Yash

#### Investigate Cloud CPU Spikes / Crashes / BetterStack Alerts (OS-1261)

**Currently working on this.**

**Goal:** Own cloud monitoring and stability. Investigate and fix remaining crashes, CPU spikes, and memory issues.

**Why:** Cloud is much more stable but still crashes occasionally. Someone needs to own this full-time so Isaiah can focus on SDK v3.

**Context:**

- **Start here:** Pod crash runbook: `cloud/tools/bstack/runbooks/pod-crash.md`
- Weekly error audit SOP: `cloud/tools/bstack/runbooks/`
- Observability hygiene spike: `cloud/issues/071-observability-hygiene/spike.md`
- Heap diagnostics (heapStats logging): `cloud/issues/077-heap-diagnostics/`
- Memory ownership census: `cloud/issues/078-memory-ownership-census/`
- Hot-path allocation fix (already shipped): `cloud/issues/075-heap-fragmentation-hot-path/`
- Timer leak fix (already shipped, OOM root cause): shipped Mar 30
- BetterStack duplicate collector fix: `cloud/issues/081-betterstack-duplicate-collector/`
- Infrastructure reference: `cloud/.architecture/infra.md`
- System vitals logging: grep for `SystemVitalsLogger` in `cloud/packages/cloud/src/`
- `disposedSessionsPendingGC` is the metric to watch. If it creeps above 3-4, there are still timer/closure leaks pinning sessions in memory.

**Done when:** Crash frequency at zero for sustained period. Memory leaks identified and fixed. CPU spikes investigated and root-caused.

#### Soniox Multi Region (OS-1265)

**Goal:** Ensure Soniox transcription works with low latency across all active regions.

**Context:**

- Soniox SDK: `cloud/issues/041-soniox-sdk/`
- Soniox timeout crash fix (already shipped): `cloud/issues/070-soniox-timeout-crash/`

**Done when:** Soniox latency acceptable in US, Europe, and East Asia regions.

---

### Ph

#### Soniox Multi Region (OS-1265)

**Context:**

- Same as Yash's Soniox ticket above. Shared ownership.

---

## Planned

### Aryan

#### SDK v3 Feature Testing (OS-1262)

**After WebSocket liveness is done.**

**Goal:** Go through the SDK v3 docs and test every new feature.

**Why:** The v3 runtime is built but only tested with a smoke test app. Need someone who has built real MiniApps to validate the new API surface and confirm docs are accurate.

**Context:**

- SDK v3 implementation status: `cloud/issues/048-sdk-v3/implementation-status.md`
- Known regressions: `cloud/issues/092-sdk-v3-alpha1-regressions-and-doc-gaps/`
- SDK docs: `docs/app-devs/` (especially `core-concepts/` and `getting-started/`)

**Done when:** Every feature documented in SDK v3 docs has been tested. At least one real v2 MiniApp runs against v3 without breaking. Gaps or bugs documented.

#### Refactor Mini Apps to V3 SDK (OS-1268)

**After SDK v3 testing is done.**

**Goal:** Migrate all internal mini apps from v2 SDK to v3 SDK.

**Why:** Internal apps need to be on v3 before we ship v3 as stable. This also validates the migration path that external developers will follow.

**Context:**

- Migration guide: `docs/app-devs/migration/overview.mdx`
- v2 to v3 API map: `docs/app-devs/migration/api-map.mdx`
- Internal apps: `cloud/packages/apps/`
- V2 compat shims (temporary, removed in v3.1): `cloud/issues/048-sdk-v3/private-runtime-architecture.md` (Compatibility Boundary section)

**Done when:** All internal mini apps running on v3 SDK in production.

---

### Yash

#### Self-Hosting Cloud / External Developer Guide (OS-1269)

**Later priority.**

**Goal:** Write a guide for external developers and companies who want to run their own MentraOS cloud instance.

**Why:** Other companies want to use MentraOS with their own hardware. They need to be able to stand up their own cloud or connect to ours.

**Context:**

- Cloud README: `cloud/README.md`
- Docker dev setup: `cloud/docker-compose.dev.yml`
- Architecture overview: `cloud/.architecture/architecture.md`
- Infrastructure reference: `cloud/.architecture/infra.md`

**Done when:** An external developer can follow the guide and get a MentraOS cloud running from scratch.

---

## Backlog

### SDK

- **SDK CI/CD pipeline.** Automated npm publishing via changesets. Beta on dev merge, rc on staging, latest on main with approval. Detailed plan exists in `cloud/issues/048-sdk-v3/sdk-cicd-plan.md`.
- **SDK documentation.** Migration guide, rewritten getting-started, npm README, API reference. Spec in `cloud/issues/048-sdk-v3/docs-update-spec.md`.
- **SDK release SOP.** Versioning, deprecation policy, rollback procedures. Draft in `cloud/issues/048-sdk-v3/sdk-release-sop.md`.
- **SDK v3 announcement.** Coordinated with MentraOS 3.0 announcement.
- **SDK v3 alpha regressions.** PCM16 audio encoding broken (breaks Gemini Live / OpenAI Realtime), LED blink patterns dropped, permission error events dropped. Full audit in `cloud/issues/092-sdk-v3-alpha1-regressions-and-doc-gaps/`.

### Reliability

- **Fail-fast request architecture.** Every cloud-mediated request (photo, audio playback, stream start/stop) needs per-hop deadlines and structured error responses that identify which hop failed. No more 30-second silent timeouts. See [Cloud OKRs](./okrs.md), Objective 2.
- **Precondition checks.** Before forwarding any request to the phone/glasses, check: is the phone WS connected? Are glasses connected? Is the camera available? Reject immediately with a specific reason if any precondition fails.
- **Readiness probe observability.** No visibility into when K8s marks the pod not-ready. Transient `/health` failures cause REST 503s while WebSockets stay connected. Need to log when `/health` exceeds the 5s probe timeout and track ready/not-ready transitions.
- **Memory leak investigation (continued).** Heap grows ~300MB/hr with stable session count. Heap type diagnostics added (077). Memory ownership census partially implemented (078). On hold until signal quality is tightened. Details: `cloud/issues/077-heap-diagnostics/`, `cloud/issues/078-memory-ownership-census/`.

### Scaling

- **Cloud scaling: stateless instances.** Externalize session state into Redis with pub/sub so any cloud instance can handle any request. The big architectural refactor. Details: [plans/cloud-scaling.md](./plans/cloud-scaling.md).
- **Load testing.** Build a test driver, find the per-pod ceiling. Feeds into scaling decisions. Part of the testing plan.

### Testing

- **Cloud testing plan.** MentraClient extraction, test mini app, test harness, CI gates. Details: [plans/cloud-testing.md](./plans/cloud-testing.md).

### Developer Experience

- **`mentra init` command.** Scaffold a new mini app project locally and register the app in one step. Closes the gap where developers currently have to go to GitHub, click "Use this Template," clone, then separately register in the console. An agent can't do that flow today.
- **`mentra dev` command.** Wrap ngrok (or built-in tunnel) so the agent/developer can go from `mentra init` to running app with zero manual steps.
- **`mentra docs` command.** CLI access to SDK documentation for agents and terminal workflows. Spec in `cloud/issues/093-cli-docs-command/`. The MCP server handles IDE-integrated agents, but CLI covers everything else.
- **Agent-friendly SDK design.** The SDK's real user is increasingly an AI agent, not a human developer. Small API surface, convention over configuration, excellent error messages, one way to do things, rich JSDoc/types, working examples that copy-paste clean.

### Architecture (Forward-Looking)

- **Local runtime / Puddle architecture.** Move the SDK runtime onto the user's phone. Mini apps download from the app store and run locally in a JS virtual environment. The Puddle (native/React Native layer) replaces the cloud for session management, app lifecycle, and subscription routing for a single user. The cloud becomes an SFU handling audio streaming, transcription/translation, and the app store registry. SDK v3's transport abstraction (`MentraSession` depends on `Transport`, not `ws`) was designed specifically to enable this. Swap `WebSocketTransport` for a `PuddleTransport` (inter-process communication) and the entire session API works unchanged. See `cloud/issues/048-sdk-v3/private-runtime-architecture.md`, Transport Boundary section.
- **Third-party cloud support.** Other companies want to build on MentraOS with their own apps, their own cloud, their own users. Each user still needs a Mentra UUID for app store auth. Requires auth system redesign (core token rework). Target: June/July 2026, ahead of OEM partner launches.
- **App registry and distribution.** Mini apps get submitted to the store, hosted in a registry, and downloaded onto the phone like a real app store. The JS process runs locally. Not everything has to go through a remote server.

---
