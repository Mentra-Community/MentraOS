# Cloud Shrinkage Plan

## Context

We considered a full cloud rewrite (cloud2) alongside the existing cloud. After discussion, we chose **incremental shrinkage instead**. The reasoning:

- A rewrite means two clouds running in parallel, ongoing bugfix divergence, and doing the Redis/serverless refactor in a new codebase _while_ keeping the old one on life support. That's worse, not better.
- Most of what we'd remove from cloud1 is dead code elimination — strictly easier to delete in place than to port-then-delete.
- The mobile miniapp SDK work (this branch) is happening regardless; it doesn't depend on cloud2 existing.
- The forcing function for the rewrite idea was "REST and WebSocket hit different pods, we need Redis." That refactor is easier on a slimmed-down cloud than on the current one.

**Strategy:** shrink cloud1 as the phone takes features over. Once cloud1 is scoped down to just the services listed below, do the Redis retrofit on the leftover.

## Deployment model decision: pods + Redis, not true serverless

**Decision:** coordinated pods with Redis for shared state. Not Lambda/Workers-style per-request serverless.

**Rationale (informed by Redis retrofit investigation, summarized below):**

- True serverless would add 3-4 months of work for scale-to-zero, which we don't need — this is a real-time product with consistently connected users.
- WebSocket-heavy workloads don't fit well on API Gateway WebSockets / Durable Objects without a major programming-model change.
- The UDP audio ingest path (LC3 frames arriving on UDP, stateful LC3 decoder, long-lived STT provider connections) cannot be per-request serverless regardless of anything else. It has to be a stateful tier — either dedicated audio pods or handed off to a managed STT provider.
- "Pods + Redis" is the industry-standard multi-tenant real-time model (Discord, Twilio, etc. use variants of this). It's what the team already knows how to operate.
- Redis retrofit investigation found the scope is bounded (~8-12 weeks), touching ~23 files and ~32 WebSocket send sites — mechanical, not architectural.

**What this means for the rewrite decision:**

Rewrite is off the table. Retrofit + shrinkage gets us the pod-mismatch fix, horizontal scalability, and a simpler codebase — without the 4-6 months of true-serverless redesign overhead.

## Audio tier note

LC3-over-UDP audio ingest must stay stateful (LC3 decoder state, STT provider streaming connections, UDP socket can't be serverless). Post-retrofit, this can optionally be pulled into its own small dedicated pod group, keeping the rest of the cloud fully coordinated-stateless. Not a blocker — audio currently runs on the same pods as everything else and can stay that way until we need to scale them independently.

## Redis retrofit scope (from investigation)

Concrete findings from auditing `services/session/` and cross-repo call sites:

| Signal                                              | Count                                 |
| --------------------------------------------------- | ------------------------------------- |
| Files calling `UserSession.getById()`               | 23                                    |
| Direct `websocket.send()` call sites                | 32                                    |
| Per-user managers holding in-process state          | 16 pre-shrinkage → ~14 post-shrinkage |
| Pod-local `Map`/`Set` collections keyed by user/app | ~15                                   |
| In-process timers across managers                   | ~64                                   |
| Direct state mutations (`userSession.foo = x`)      | ~22                                   |
| Redis usage today                                   | zero                                  |

**Encouraging signals:**

- `PhoneSession` is already DTO-shaped (115 lines, all serializable) — ~1 week to back with Redis.
- No circular dependencies between managers; reference graph is a clean DAG.
- Session data is plain fields, not deeply nested objects with methods.

**Hard parts:**

- WebSocket push: all 32 `websocket.send()` sites need to become Redis pubsub publishes with reconnect-replay for missed messages. ~3 weeks.
- UDP audio routing: `UdpAudioServer.sessionMap` is pod-local. Needs hash-based routing via load balancer, or dedicated audio pod fleet. This is an audio-tier decision (see above), not a Redis retrofit one.
- Timers: ~64 `setTimeout`/`setInterval` calls across managers. Either accept pod-local timers (simplest) or move to a distributed scheduler (Bull queue). Accept pod-local unless it causes pain.

## Phased Redis retrofit sketch

Runs after shrinkage Phases 0-4. All phases live in cloud1, no cloud2.

**Phase R1 — SessionStore abstraction (1-2 weeks).** Introduce `SessionStore` interface. Replace `UserSession.getById()` and the static `UserSession.sessions` map with store lookups. Sessions still live in memory per-pod — the _lookup_ goes through a layer. Backward compatible with single-pod deploy. Unblocks the rest.

**Phase R2 — Redis-backed SessionStore + cross-pod WebSocket push (3 weeks).** Wire `SessionStore` to Redis. Add pubsub channel per userId for cross-pod WS messages. Convert all 32 `websocket.send()` sites to publish through `CloudEventPublisher`. Add reconnect-replay for messages published while a user was reconnecting. **This is when pod-mismatch bug is actually fixed.**

**Phase R3 — Per-manager state to Redis (3-4 weeks).** Convert `PhoneSession`, `SubscriptionManager`, `PhonePhotoManager`, relevant parts of `AudioManager` (pending requests, not decoder state) to read/write Redis. Managers remain as classes but become thin over Redis.

**Phase R4 — Audio tier separation (optional, 1-2 weeks).** If audio pod load diverges from rest-of-cloud load, pull `UdpAudioServer` + `AudioManager` + `TranscriptionManager`/`TranslationManager` into their own deploy unit. Communicates with rest-of-cloud via Redis pubsub. Skip if not needed.

**Phase R5 — Distributed scheduler (optional, 1-2 weeks).** If pod-local timers cause missed work on pod churn, move to Bull queue. Skip if not needed.

**Realistic timeline: 8-12 weeks for R1-R3 (pod-mismatch fully fixed). R4/R5 as needed.**

## Final cloud scope (what stays)

After shrinkage, cloud1's job is:

1. **Auth** — user identity, sessions, tokens
2. **Account page backend**
3. **Developer console backend** — orgs, invites, CLI keys, app catalog management
4. **Miniapp store** — catalog, ZIP distribution, ratings/moderation, age gate (Apple 4.7.5), universal link index (Apple 4.7.4)
5. **STT/translation** — UDP LC3 ingest from phone → SonioX → text back over phone↔cloud WebSocket
6. **TTS** — REST endpoint returning MP3 stream URL
7. **Photo relay** — R2 signed upload URLs, short TTL (24h)
8. **Managed streaming** — Cloudflare initiation step + status relay only. Keep-alive lives on phone. Unmanaged streaming does NOT touch cloud at all.
9. **Min client version endpoint**
10. **Incident reporting** — cloud log ingest to Better Stack, admin incident pages, phone/glasses/telemetry log aggregation

## Explicitly NOT cloud1's problem

- **OTA firmware updates** — static Cloudflare Pages. `asg_client/ota_website/` doesn't touch cloud.
- **Store frontend / universal link landing pages** — hosted on Cloudflare Pages; only hits cloud endpoints for data.
- **Unmanaged streaming** — 100% phone. Phone talks directly to RTMP endpoint, manages keep-alive, reports status in-app.
- **Managed streaming keep-alive** — cloud only initiates with Cloudflare; phone owns lifecycle.
- **Per-app WebSocket session orchestration** — no cloud-hosted miniapps after V4 deprecation.
- **Layout compositing / DashboardManager** — phone composes display.
- **Per-app event permission checks** — phone enforces at subscribe time via miniapp manifest.
- **First-party miniapp implementations** (`cloud/packages/apps/*`) — port to local miniapp SDK, delete cloud versions.

## Migration mechanics

- No cloud2 branch. Changes land in cloud1 directly.
- Mobile app speaks cloud1 throughout. For a window it must remain compatible with both "old cloud1 behavior" and "new cloud1 behavior" (flagged by server or version) — mostly an ease-of-development concern, not a runtime strategy.
- Per-miniapp cutover: as each first-party miniapp (Captions, Translation, Livestreamer, Call, etc.) ports to the local miniapp SDK, the cloud-side code that only existed for it becomes deletable.
- Redis/serverless refactor happens AFTER shrinkage, on the slimmed cloud.

---

## Types package extraction

**Decision:** extract types to `packages/types/` at the monorepo root (outside `cloud/`).

- Current: `cloud/packages/types/` is owned by cloud; phone, SDK, cloud, cloud-client all depend on it transitively
- New: `packages/types/` at repo root. Cloud, mobile, `@mentra/miniapp`, `@mentra/sdk` (during deprecation) all equal consumers
- Rationale: phone is the hub now. Types are a contract between phone and cloud, not a cloud implementation detail

This is an independent task — can happen anytime, blocks nothing.

---

## File-by-file shrinkage audit

Legend:

- ⚠️ **KEEP** — stays, possibly slimmed
- ❌ **DELETE** — outright removal
- 📱 **MOVE TO PHONE** — functionality migrates to mobile app
- ❓ **VERIFY** — need to look at usage before deciding
- 🚚 **EXTRACT** — moves to a different package location

---

### `services/session/` — per-app orchestration (heart of the rot)

This folder exists because "apps are cloud-hosted Node servers and cloud orchestrates them." Almost everything here dies.

| File                              | Verdict          | Reason                                                                             |
| --------------------------------- | ---------------- | ---------------------------------------------------------------------------------- |
| `AppSession.ts`                   | ❌ DELETE        | Per-app WebSocket session — gone with cloud-SDK apps                               |
| `AppManager.ts`                   | ❌ DELETE        | App lifecycle/routing — phone handles local miniapps                               |
| `AppLikeSession.ts`               | ❌ DELETE        | Interface for AppSession + PhoneSession — phone-only now                           |
| `PhoneSession.ts`                 | ⚠️ KEEP (slim)   | Becomes the _only_ session type — a thin phone↔cloud connection holder            |
| `SubscriptionManager.ts`          | ⚠️ KEEP (slim)   | Needed for phone-subscription-style STT/translation fanout; but drop per-app logic |
| `UserSession.ts`                  | ⚠️ KEEP (slim)   | Still need "who is this phone's user" — but strip app orchestration                |
| `AudioManager.ts`                 | ⚠️ KEEP          | STT audio ingest pipeline                                                          |
| `UdpAudioManager.ts`              | ⚠️ KEEP          | UDP LC3 in from phone — core STT path                                              |
| `AppAudioStreamManager.ts`        | ❌ DELETE        | Streaming audio _to_ apps — no apps                                                |
| `MicrophoneManager.ts`            | 📱 MOVE TO PHONE | Phone decides mic state (MicStateCoordinator in this PR)                           |
| `DeviceManager.ts`                | 📱 MOVE TO PHONE | Phone knows its own devices                                                        |
| `HardwareCompatibilityService.ts` | 📱 MOVE TO PHONE | Phone checks capabilities against miniapp manifest                                 |
| `UserSettingsManager.ts`          | ⚠️ KEEP (slim)   | User-level settings still cloud-backed for sync                                    |
| `LocationManager.ts`              | 📱 MOVE TO PHONE | `expo-location` on phone — no cloud role                                           |
| `CalendarManager.ts`              | 📱 MOVE TO PHONE | `expo-calendar` on phone                                                           |
| `PhotoManager.ts`                 | ❌ DELETE        | Old cloud-app photo flow                                                           |
| `PhonePhotoManager.ts`            | ⚠️ KEEP          | Cloud photo relay (R2 signed URLs) — the photo relay feature                       |
| `UnmanagedStreamingExtension.ts`  | ❌ DELETE        | Unmanaged streaming is 100% phone-side                                             |

---

### `services/layout/` — dies entirely

| File                   | Verdict   | Reason                                                    |
| ---------------------- | --------- | --------------------------------------------------------- |
| `DisplayManager6.1.ts` | ❌ DELETE | Phone composes display. No cross-app compositing on cloud |

---

### `services/websocket/` — downsize

| File                           | Verdict        | Reason                                                                                                                                 |
| ------------------------------ | -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `websocket-glasses.service.ts` | ⚠️ KEEP (slim) | Phone↔cloud WebSocket (misnamed "glasses") — still needed for cloud→phone push. **Consider renaming to `websocket-phone.service.ts`** |
| `websocket-app.service.ts`     | ❌ DELETE      | App↔cloud WebSocket — no more cloud apps                                                                                              |
| `websocket.service.ts`         | ⚠️ KEEP        | Core WS plumbing                                                                                                                       |
| `bun-websocket.ts`             | ⚠️ KEEP        | Bun WS adapter                                                                                                                         |
| `types.ts`                     | ⚠️ KEEP        | Types                                                                                                                                  |

---

### `services/streaming/` — shrink to managed-only

| File                           | Verdict        | Reason                                                                 |
| ------------------------------ | -------------- | ---------------------------------------------------------------------- |
| `CloudflareStreamService.ts`   | ⚠️ KEEP        | Cloudflare initiation — the one thing that needs cloud                 |
| `ManagedStreamingExtension.ts` | ⚠️ KEEP (slim) | Keep initiation + status relay only; strip keep-alive (moves to phone) |
| `StreamLifecycleController.ts` | ⚠️ KEEP (slim) | Phone owns keep-alive — trim significantly                             |
| `StreamRegistry.ts`            | ❓ VERIFY      | Still needed if phone owns state? Likely delete                        |
| `index.ts`                     | ⚠️ KEEP        | Exports                                                                |

---

### `services/udp/` — core STT infra, keep all

| File                  | Verdict |
| --------------------- | ------- |
| `UdpAudioServer.ts`   | ⚠️ KEEP |
| `UdpCrypto.ts`        | ⚠️ KEEP |
| `UdpReorderBuffer.ts` | ⚠️ KEEP |

This is the "accept UDP bytes in LC3" pipeline.

---

### `services/lc3/` — core STT infra, keep all

| File             | Verdict |
| ---------------- | ------- |
| `lc3.service.ts` | ⚠️ KEEP |
| `LC3Service3.ts` | ⚠️ KEEP |

Follow-up: collapse the two coexisting LC3 service files into one during shrinkage.

---

### `services/incidents/` + `services/logging/` — keep all

| File                                      | Verdict |
| ----------------------------------------- | ------- |
| `incidents/incident-processor.service.ts` | ⚠️ KEEP |
| `logging/betterstack-query.service.ts`    | ⚠️ KEEP |
| `logging/index.ts`                        | ⚠️ KEEP |
| `logging/pino-logger.ts`                  | ⚠️ KEEP |
| `logging/posthog.service.ts`              | ⚠️ KEEP |

---

### `services/storage/` — keep for R2, incidents, miniapp ZIPs

| File                            | Verdict                                                     |
| ------------------------------- | ----------------------------------------------------------- |
| `r2-storage.service.ts`         | ⚠️ KEEP — photo relay + miniapp ZIP distribution            |
| `cloudflare-storage.service.ts` | ❓ VERIFY — distinct from r2?                               |
| `incident-storage.service.ts`   | ⚠️ KEEP                                                     |
| `storage.service.ts`            | ⚠️ KEEP                                                     |
| `alibaba-storage.service.ts`    | ❓ VERIFY — China-region storage? Keep if used, else delete |

---

### `services/sdk/` — delete both

| File                        | Verdict   | Reason                                                 |
| --------------------------- | --------- | ------------------------------------------------------ |
| `sdk.auth.service.ts`       | ❌ DELETE | Auth for cloud-SDK app servers                         |
| `simple-storage.service.ts` | ❌ DELETE | Simple storage moves phone-local (execution plan §1.9) |

---

### `services/permissions/` — delete

| File                           | Verdict   | Reason                                                             |
| ------------------------------ | --------- | ------------------------------------------------------------------ |
| `simple-permission-checker.ts` | ❌ DELETE | Per-app event permission checks — phone enforces at subscribe time |
| `index.ts`                     | ❌ DELETE | Same                                                               |

---

### `services/core/` — mixed

| File                        | Verdict          | Reason                                                       |
| --------------------------- | ---------------- | ------------------------------------------------------------ |
| `app.service.ts`            | ⚠️ KEEP (slim)   | Miniapp catalog record. Drop runtime lifecycle, keep catalog |
| `app-cache.service.ts`      | ⚠️ KEEP          | Cache of app records                                         |
| `app-enrichment.service.ts` | ⚠️ KEEP          | Store listing enrichment                                     |
| `app-uptime.service.ts`     | ❌ DELETE        | Uptime tracking for cloud-hosted app servers                 |
| `store.service.ts`          | ⚠️ KEEP          | Store catalog                                                |
| `developer.service.ts`      | ⚠️ KEEP          | Developer console backend                                    |
| `organization.service.ts`   | ⚠️ KEEP          | Orgs                                                         |
| `invite.service.ts`         | ⚠️ KEEP          | Invites                                                      |
| `temp-token.service.ts`     | ⚠️ KEEP          | Temp tokens for auth                                         |
| `admin.utils.ts`            | ⚠️ KEEP          | Admin surface                                                |
| `location.service.ts`       | 📱 MOVE TO PHONE | Location is phone-owned                                      |
| `photo-request.service.ts`  | ⚠️ KEEP          | Photo relay request tracking                                 |
| `photo-taken.service.ts`    | ⚠️ KEEP          | Photo relay completion                                       |
| `WeatherService.ts`         | 📱 MOVE TO PHONE | Used by DashboardManager, moving to phone                    |

---

### `services/client/` — phone-facing, keep all

| File                       | Verdict |
| -------------------------- | ------- |
| `apps.service.ts`          | ⚠️ KEEP |
| `feedback.service.ts`      | ⚠️ KEEP |
| `user-settings.service.ts` | ⚠️ KEEP |

---

### `services/console/` — developer console, keep all

| File                         | Verdict |
| ---------------------------- | ------- |
| `cli-keys.service.ts`        | ⚠️ KEEP |
| `console.account.service.ts` | ⚠️ KEEP |
| `console.apps.service.ts`    | ⚠️ KEEP |
| `orgs.service.ts`            | ⚠️ KEEP |

---

### `services/email/`, `notifications/`, `integrations/`, `metrics/`, `debug/` — keep all

| File                              | Verdict |
| --------------------------------- | ------- |
| `email/resend.service.ts`         | ⚠️ KEEP |
| `notifications/slack.service.ts`  | ⚠️ KEEP |
| `integrations/linear.service.ts`  | ⚠️ KEEP |
| `metrics/MetricsService.ts`       | ⚠️ KEEP |
| `metrics/SystemVitalsLogger.ts`   | ⚠️ KEEP |
| `metrics/index.ts`                | ⚠️ KEEP |
| `debug/audio-writer.ts`           | ⚠️ KEEP |
| `debug/debug-service.ts`          | ⚠️ KEEP |
| `debug/MemoryLeakDetector.ts`     | ⚠️ KEEP |
| `debug/MemoryTelemetryService.ts` | ⚠️ KEEP |
| `debug/server-stats.ts`           | ⚠️ KEEP |
| `debug/types.ts`                  | ⚠️ KEEP |

---

### `services/validators/`

| File                     | Verdict                                                                |
| ------------------------ | ---------------------------------------------------------------------- |
| `ConnectionValidator.ts` | ❓ VERIFY — if validates app WS → DELETE. If validates phone WS → KEEP |

---

### `api/hono/client/` — phone-facing API, keep all

| File                   | Verdict                                                              |
| ---------------------- | -------------------------------------------------------------------- |
| `audio-config.api.ts`  | ⚠️ KEEP                                                              |
| `calendar.api.ts`      | ❓ VERIFY — calendar moving to phone, does this still need to exist? |
| `client.apps.api.ts`   | ⚠️ KEEP                                                              |
| `device-state.api.ts`  | ⚠️ KEEP                                                              |
| `feedback.api.ts`      | ⚠️ KEEP                                                              |
| `incident-logs.api.ts` | ⚠️ KEEP                                                              |
| `index.ts`             | ⚠️ KEEP                                                              |
| `location.api.ts`      | ❓ VERIFY — location moving to phone, does this still need to exist? |
| `min-version.api.ts`   | ⚠️ KEEP ← the min client version endpoint                            |
| `miniapp-photo.api.ts` | ⚠️ KEEP ← photo relay (added in this PR)                             |
| `notifications.api.ts` | ⚠️ KEEP                                                              |
| `photo.api.ts`         | ⚠️ KEEP                                                              |
| `user-settings.api.ts` | ⚠️ KEEP                                                              |

---

### `api/hono/console/` — developer console, keep all

| File                     | Verdict |
| ------------------------ | ------- |
| `cli-keys.api.ts`        | ⚠️ KEEP |
| `console.account.api.ts` | ⚠️ KEEP |
| `console.apps.api.ts`    | ⚠️ KEEP |
| `incidents.api.ts`       | ⚠️ KEEP |
| `index.ts`               | ⚠️ KEEP |
| `orgs.api.ts`            | ⚠️ KEEP |

---

### `api/hono/store/` — miniapp store, keep all

| File                | Verdict |
| ------------------- | ------- |
| `index.ts`          | ⚠️ KEEP |
| `store.apps.api.ts` | ⚠️ KEEP |
| `store.auth.api.ts` | ⚠️ KEEP |
| `store.user.api.ts` | ⚠️ KEEP |

---

### `api/hono/agent/` — incident agent integration, keep all

| File               | Verdict |
| ------------------ | ------- |
| `incidents.api.ts` | ⚠️ KEEP |
| `index.ts`         | ⚠️ KEEP |

---

### `api/hono/public/` — keep all

| File                 | Verdict |
| -------------------- | ------- |
| `index.ts`           | ⚠️ KEEP |
| `permissions.api.ts` | ⚠️ KEEP |

---

### `api/hono/sdk/` — delete all (cloud-SDK app API surface)

| File                           | Verdict   |
| ------------------------------ | --------- |
| `index.ts`                     | ❌ DELETE |
| `sdk-version.api.ts`           | ❌ DELETE |
| `simple-storage.api.ts`        | ❌ DELETE |
| `system-app/index.ts`          | ❌ DELETE |
| `system-app/system-app.api.ts` | ❌ DELETE |

---

### `api/hono/middleware/`

| File                    | Verdict          | Reason                |
| ----------------------- | ---------------- | --------------------- |
| `cli.middleware.ts`     | ⚠️ KEEP          | CLI auth still needed |
| `client.middleware.ts`  | ⚠️ KEEP          | Phone auth            |
| `console.middleware.ts` | ⚠️ KEEP          | Console auth          |
| `sdk.middleware.ts`     | ❌ DELETE        | Cloud SDK auth        |
| `index.ts`              | ⚠️ KEEP (update) |

---

### `api/hono/routes/` — mixed

| File                     | Verdict        | Reason                                                                        |
| ------------------------ | -------------- | ----------------------------------------------------------------------------- |
| `account.routes.ts`      | ⚠️ KEEP        | Account page                                                                  |
| `admin.routes.ts`        | ⚠️ KEEP        | Admin                                                                         |
| `app-settings.routes.ts` | ❓ VERIFY      | If for cloud-SDK app settings → DELETE; if user-level miniapp settings → KEEP |
| `app-uptime.routes.ts`   | ❌ DELETE      | Paired with deleted app-uptime service                                        |
| `apps.routes.ts`         | ⚠️ KEEP (slim) | Miniapp catalog only                                                          |
| `audio.routes.ts`        | ⚠️ KEEP        | TTS endpoint                                                                  |
| `auth.routes.ts`         | ⚠️ KEEP        | Auth                                                                          |
| `developer.routes.ts`    | ⚠️ KEEP        | Developer console                                                             |
| `error-report.routes.ts` | ⚠️ KEEP        | Incidents                                                                     |
| `gallery.routes.ts`      | ⚠️ KEEP        | Photo gallery                                                                 |
| `hardware.routes.ts`     | ❓ VERIFY      | Hardware compat moving to phone — does this endpoint still serve anything?    |
| `onboarding.routes.ts`   | ⚠️ KEEP        | Onboarding                                                                    |
| `organization.routes.ts` | ⚠️ KEEP        | Orgs                                                                          |
| `permissions.routes.ts`  | ❓ VERIFY      | If per-app runtime perms → DELETE; if user-level → KEEP                       |
| `photos.routes.ts`       | ⚠️ KEEP        | Photo relay                                                                   |
| `streams.routes.ts`      | ⚠️ KEEP (slim) | Managed-only                                                                  |
| `tools.routes.ts`        | ❓ VERIFY      | What is this?                                                                 |
| `transcripts.routes.ts`  | ⚠️ KEEP        | Transcription                                                                 |

---

### `models/` — mostly keep

| File                      | Verdict                          |
| ------------------------- | -------------------------------- |
| `app.model.ts`            | ⚠️ KEEP — miniapp catalog record |
| `app-uptime.model.ts`     | ❌ DELETE                        |
| `cli-key.model.ts`        | ⚠️ KEEP                          |
| `feedback.model.ts`       | ⚠️ KEEP                          |
| `gallery-photo.model.ts`  | ⚠️ KEEP                          |
| `incident.model.ts`       | ⚠️ KEEP                          |
| `organization.model.ts`   | ⚠️ KEEP                          |
| `simple-storage.model.ts` | ❌ DELETE                        |
| `temp-token.model.ts`     | ⚠️ KEEP                          |
| `user-settings.model.ts`  | ⚠️ KEEP                          |
| `user.model.ts`           | ⚠️ KEEP                          |

---

### Top-level `cloud/packages/` siblings

| Package                        | Verdict        | Reason                                                                       |
| ------------------------------ | -------------- | ---------------------------------------------------------------------------- |
| `cloud/packages/cloud`         | ⚠️ SHRINK      | Subject of this plan                                                         |
| `cloud/packages/sdk`           | ❌ DEPRECATE   | Archive after V4 (execution plan OS-1311/OS-1312)                            |
| `cloud/packages/react-sdk`     | ❌ DEPRECATE   | Export surface stays during transition                                       |
| `cloud/packages/types`         | 🚚 EXTRACT     | → `packages/types/` at repo root                                             |
| `cloud/packages/utils`         | ⚠️ KEEP (slim) | Audit file-by-file before shrinkage                                          |
| `cloud/packages/agents`        | ⚠️ KEEP        | Incident agent                                                               |
| `cloud/packages/apps`          | ❌ DELETE      | First-party cloud-SDK miniapps — evaluate each; should all port to local SDK |
| `cloud/packages/cli`           | ⚠️ KEEP        | Developer CLI                                                                |
| `cloud/packages/cloud-client`  | ❓ VERIFY      | What uses this?                                                              |
| `cloud/packages/discord-bot`   | ⚠️ KEEP        | If still used                                                                |
| `cloud/packages/display-utils` | ❌ DELETE      | Phone does display now — verify no cloud dep                                 |
| `cloud/packages/incidents`     | ⚠️ KEEP        | Incident reporting                                                           |

---

## Summary estimates

Of **~90 service/API files surveyed:**

- **~30 files/modules die outright** (per-app routing, layout, SDK auth, unmanaged streaming, app uptime, display compositing, per-app permissions, cloud-SDK simple-storage, sdk hono routes, app-audio streaming)
- **~15 files migrate to phone** (location, calendar, device manager, hardware compat, mic, weather, first-party cloud apps)
- **~45 files stay, many slimmed**

Rough estimate: **cloud shrinks by ~40-50% of LOC** once shrinkage executes.

---

## Dependency order

Deletions and moves have a natural ordering because some depend on phone-side work landing first.

### Phase 0 — independent cleanups (can happen anytime, block nothing)

- Extract `cloud/packages/types/` → `packages/types/` at repo root
- Delete `app-uptime.*` service + model + routes
- Collapse `LC3Service3` and `lc3.service` duplicates into one
- Delete `api/hono/sdk/` routes (already disused by the new model)
- Delete `sdk.middleware.ts`

### Phase 1 — enabled by the current miniapp SDK PR

- Delete `UnmanagedStreamingExtension.ts` (phone owns unmanaged streaming)
- Delete `services/sdk/simple-storage.service.ts` (phone-local per exec plan §1.9)
- Delete `services/permissions/*` (phone enforces at subscribe time)
- Delete `AppAudioStreamManager.ts`

### Phase 2 — per-miniapp (as each first-party app ports to local SDK)

Execution plan issues OS-1299 through OS-1306. For each port:

- Delete cloud-side first-party app implementation in `cloud/packages/apps/<app>`
- Remove any DashboardManager wiring for that app when Phase 2.14 ships (dashboard moves to phone)

### Phase 3 — after all first-party miniapps ported (big sweep)

- Delete `AppSession.ts`, `AppManager.ts`, `AppLikeSession.ts`
- Delete `websocket-app.service.ts`
- Delete `sdk.auth.service.ts`
- Delete `PhotoManager.ts` (old cloud-app photo flow)
- Delete `DisplayManager6.1.ts`
- Rename `websocket-glasses.service.ts` → `websocket-phone.service.ts`
- Slim `PhoneSession`, `SubscriptionManager`, `UserSession` to phone-only

### Phase 4 — feature-specific moves (can happen in parallel with Phase 2-3)

Each is a small PR: implement phone-side, then delete cloud-side.

- Location → phone (`LocationManager.ts`, `location.service.ts`, possibly `location.api.ts`, `client/location.api.ts`)
- Calendar → phone (`CalendarManager.ts`, `client/calendar.api.ts`)
- Weather → phone (`WeatherService.ts`)
- DeviceManager → phone
- HardwareCompat → phone
- Microphone state → phone (MicStateCoordinator already landed in this PR; delete cloud `MicrophoneManager.ts` once phone is fully authoritative)

### Phase 5 — Redis / serverless refactor

On the slimmed cloud only. Out of scope for this plan — write a separate Redis refactor plan once Phases 0-4 complete.

---

## Open questions to resolve before execution

1. **`cloud/packages/apps/`** — list contents and confirm each one has a local-SDK port planned (or is already deprecated). Anything that doesn't port becomes a stranded cloud-app.
2. **`cloud/packages/cloud-client/`** — what's this and who uses it?
3. **`cloud/packages/display-utils/`** — verify no remaining cloud dependency before deleting.
4. **`alibaba-storage.service.ts`** — still used? China region?
5. **`cloudflare-storage.service.ts` vs `r2-storage.service.ts`** — what's the distinction?
6. **`StreamRegistry.ts`** — still needed once phone owns stream lifecycle state?
7. **`ConnectionValidator.ts`** — validates what kind of connection?
8. **`api/hono/routes/app-settings.routes.ts`** — per-app developer settings (delete) or user-level miniapp settings (keep)?
9. **`api/hono/routes/permissions.routes.ts`** — same question.
10. **`api/hono/routes/hardware.routes.ts`** — any phone-facing usage after hardware compat moves to phone?
11. **`api/hono/routes/tools.routes.ts`** — what does this serve?

---

## What this plan is NOT

- Not a rewrite. No cloud2. No parallel codebases.
- Not a Redis migration. Redis comes AFTER shrinkage.
- Not a spec for the mobile-side work. That lives in `agents/local-miniapp-execution-plan.md` and `agents/local-app-runtime-plan.md`.
- Not a mobile dual-cloud strategy. Mobile speaks one cloud throughout; shrinkage is transparent to mobile.

## Cross-references

- Mobile miniapp execution plan: `agents/local-miniapp-execution-plan.md`
- Mobile miniapp technical plan: `agents/local-app-runtime-plan.md`
- Architecture discussion: `agents/local-miniapp-architecture-discussion.md`
