# Cloud v2 Plan

**Status:** First-pass draft. Consolidates scattered notes that did not previously have a canonical home. Decisions in this doc are concrete enough to argue against; none are locked.

**Audience:** Cloud engineering, leadership, and anyone who needs a single reference for what cloud v2 is.

## Goal

A clean rewrite of the cloud, scoped to the role miniapps will need once they run on the phone (the puddle architecture). Built scalable from day one rather than retrofitted onto cloud1.

Cloud v2 does three things and only three things:

1. **Hosts the platform identity surface.** Auth, accounts, the developer console, the miniapp store, token issuance for "bring your own backend" miniapps and OEM partners.
2. **Routes audio.** UDP LC3 ingest from phones, transcription via Soniox, translation, TTS. The one tier that has to be stateful by physics.
3. **Provides a small set of REST endpoints for things that have to be cloud-hosted.** Photo relay (R2 signed upload URLs), managed streaming initiation (Cloudflare hand-off), min client version, incident reporting.

That is the whole job. No per-app WebSocket orchestration. No cloud-hosted miniapp runtime. No layout compositing. No per-app event permission checks. All of those move to the phone.

## Why a rewrite, not a refactor

The CTO's shrinkage plan argued for incremental delete-in-place against a rewrite. That argument was correct at the time. The reason we are reopening it now is that the post-shrinkage cloud and a clean cloud v2 land in the same place architecturally, and getting there incrementally is more expensive than starting fresh:

- The Redis retrofit alone is 8 to 12 weeks against the existing codebase's session model. Doing it on a new codebase that was designed for Redis from line one is a fraction of that.
- The shrinkage plan still leaves us with a per-pod-state architecture that "happens to be deployable on multiple pods" rather than one that was designed for it.
- Multiple regions, multi-tenant isolation, and the OEM token-issuance surface are all easier to implement once than to backport.

The rewrite is bounded because the scope is bounded. Cloud v2 owns ten things, not the dozens of features cloud1 accumulated as cloud-hosted miniapps multiplied. The smaller surface area is what makes the rewrite tractable.

The risk a rewrite introduces is the parallel-codebases trap: cloud1 and cloud2 both running, both getting bug fixes, never finishing the cutover. The migration plan section addresses that explicitly.

## What runs in cloud v2

The ten-item scope, expanded:

| Service                   | Surface         | Notes                                                                                                                         |
| ------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Auth                      | REST + JWKS     | Mentra user identity. Issues JWTs for phones to present to dev backends. Hosts `/.well-known/jwks.json`.                      |
| Account page backend      | REST            | User profile, devices, installed miniapps, subscription state.                                                                |
| Developer console backend | REST            | Orgs, invites, CLI keys, app catalog management, miniapp publish flow.                                                        |
| Miniapp store             | REST + R2       | Catalog browse, ZIP distribution, ratings, moderation, age gate, universal link index. Apple 4.7.4 + 4.7.5 compliance.        |
| STT / translation         | UDP + WebSocket | LC3 audio ingest from phone, Soniox routing, transcription delivery back to phone over the existing phone↔cloud WebSocket.   |
| TTS                       | REST            | Returns MP3 stream URLs. Phone fetches and plays.                                                                             |
| Photo relay               | REST + R2       | Signed upload URLs with short TTL (24h).                                                                                      |
| Managed streaming         | REST            | Cloudflare initiation step plus status relay. Keep-alive lives on the phone. Unmanaged streaming does not touch cloud at all. |
| Min client version        | REST            | Mobile checks before connecting; gates degraded modes.                                                                        |
| Incident reporting        | REST            | Cloud log ingest to BetterStack, admin incident pages, phone/glasses telemetry log aggregation.                               |

Everything else cloud1 currently does either moves to the phone (puddle architecture, see `./puddle-architecture.md`) or is deleted because cloud-hosted miniapps no longer exist.

## Architecture

### Stateless tier (most of cloud v2)

Multi-pod, horizontally scalable from day one. Pods are interchangeable. No per-user state pinned to any pod. All session state in Redis. Phone reconnects can land on any pod.

Concretely:

- REST endpoints (auth, store, console, photo relay, TTS, min-version, incidents) are stateless services running behind a load balancer.
- The phone↔cloud WebSocket is held open by whichever pod the phone reconnects to. Pod-to-phone messages go through a per-user Redis pubsub channel; whichever pod has the phone's socket consumes from that channel and forwards.
- Background work (Soniox stream lifecycle, transcription routing) reads from per-user state in Redis and writes results back the same way.

This is what "Redis from day one" means in practice: there is no in-process `Map<userId, UserSession>` anywhere. Every read and write goes through Redis, and the in-memory cache is bounded and purely a performance optimization, never a correctness one.

### Stateful tier (audio only)

The audio tier is intentionally stateful, scoped narrowly:

- UDP socket for LC3 audio cannot be load-balanced per-request. The phone's audio stream pins to one pod for the lifetime of the connection.
- LC3 decoder state is per-stream and lives in pod memory.
- Soniox provider connections are long-lived per-user.

This pod group is a separate deploy unit. It can scale independently from the stateless tier. If a pod dies, the phone reconnects via UDP and lands on a different pod with fresh decoder state.

### Storage

| Class                                                                | Backing       |
| -------------------------------------------------------------------- | ------------- |
| User accounts, orgs, miniapp catalog, console state                  | Postgres      |
| User session state, subscription routing, ephemeral request tracking | Redis         |
| Photos, miniapp ZIPs, audio files                                    | Cloudflare R2 |
| Logs, incident reports                                               | BetterStack   |

No MongoDB. The cloud1 use cases for MongoDB collapse to either Postgres (well-shaped relational data) or Redis (ephemeral session state) when we redesign without the legacy.

### Identity and the OEM auth surface

Mentra issues short-lived JWTs scoped to a `(user, miniapp)` pair. The JWT is signed by a key Mentra controls; the public key is published at a JWKS endpoint that any backend can verify against offline.

```
JWT payload:
  iss: https://auth.mentra.glass
  sub: user_<id>           // Mentra user
  aud: <packageName>       // miniapp identity
  iat: ...
  exp: ...                 // short, ~1 hour
  scopes: ["microphone", ...]
```

This is the load-bearing primitive for "bring your own backend" miniapps and for OEM partners running their own infrastructure. The dev's backend (or the OEM's backend) verifies the signature against `https://auth.mentra.glass/.well-known/jwks.json` and trusts the result.

Token issuance is a small, hot-path REST endpoint in cloud v2 that authenticates the requesting Mentra session and mints a fresh JWT. Verification happens entirely on the dev's side; cloud v2 is not in the request path between the miniapp and the dev's backend.

If we revoke a miniapp's API key (e.g., terms violation), token issuance for that miniapp stops, in-flight tokens expire within an hour, and the miniapp's traffic to its dev backend dies. Local glasses functionality keeps working until the user reconnects. This is the platform-control story from the OEM plan, made concrete.

### Multi-region

Cloud v2 is region-local from day one. Each region (US Central, US East, US West, France, East Asia, China) runs an independent stateless tier and audio tier, with its own Redis cluster and Postgres replica. Cross-region failover is out of scope for v2; we accept that a region outage degrades that region's users until the region recovers.

Region routing is by Cloudflare load balancer (or equivalent), based on user geography. Within a region, all infrastructure is colocated.

## What runs on the phone instead

See `./puddle-architecture.md` for the on-device runtime model. Briefly:

- Miniapps run on the phone in the puddle (the local platform layer hosting WebViews and the per-miniapp JS context).
- Display compositing, layout, per-app permissions, microphone state coordination, device manager, hardware compat, and most user-facing app logic live on the phone.
- The phone holds one WebSocket to cloud v2 for cross-cutting services (audio, store, identity).

The relationship between cloud v2 and the puddle:

- The phone is cloud v2's only client (besides the dev console, store frontend, OEM portal).
- The phone speaks one WebSocket protocol to cloud v2; cloud v2 does not need to know about miniapps as runtime entities, only as catalog records.
- Audio flows phone → cloud → Soniox → cloud → phone → puddle → miniapp. Cloud routes; the puddle delivers to the right miniapp.

## What we deliberately do not port from cloud1

This is the load-bearing section for "clean rewrite." A clean rewrite is only clean if we explicitly delete the parts that no longer belong.

| Deleted from cloud v2                                         | Why                                                        |
| ------------------------------------------------------------- | ---------------------------------------------------------- |
| `AppSession` / `AppManager` / `AppLikeSession`                | Per-app WebSocket orchestration, gone with cloud-SDK apps. |
| `DisplayManager`                                              | Phone composes display. Cloud has no role.                 |
| `AppAudioStreamManager`                                       | No streaming audio to apps because no apps run in cloud.   |
| `MicrophoneManager` (cloud-side)                              | Phone owns mic state.                                      |
| `DeviceManager`, `HardwareCompatibilityService`               | Phone knows its own devices.                               |
| `LocationManager` (cloud-side)                                | `expo-location` on the phone.                              |
| `CalendarManager`, `WeatherService`                           | Phone-owned.                                               |
| `PhotoManager` (the cloud-app photo flow)                     | Replaced by the simple photo relay.                        |
| `UnmanagedStreamingExtension`                                 | 100% phone-side.                                           |
| Per-app event permission checks                               | Phone enforces at subscribe time.                          |
| First-party miniapp implementations in `cloud/packages/apps/` | Ported to local miniapp SDK.                               |
| OTA firmware update hosting                                   | Static Cloudflare Pages, never touched cloud.              |
| Store frontend, universal link landing pages                  | Cloudflare Pages.                                          |
| Managed streaming keep-alive                                  | Phone owns lifecycle.                                      |
| Per-miniapp simple storage                                    | Phone-local AsyncStorage.                                  |
| Cloud-SDK auth, cloud-SDK simple-storage                      | No cloud SDK consumers after sunset.                       |
| `app-uptime` tracking                                         | No cloud-hosted apps to track uptime for.                  |
| Per-app permissions REST routes                               | Per-miniapp manifest enforced on phone.                    |

If a feature is not in the ten-item list and not in this delete list, that is a gap to flag.

## Migration plan

### v3 alpha SDK

Status: stable, not promoted, sunset target two months from cloud v2 GA.

- No new features in v3 alpha.
- Bug fixes only for production-blocking issues.
- Apps shipping on v3 alpha continue to work against cloud1 until cloud1 sunsets.
- New apps directed to the on-device miniapp path.

### Cloud1 sunset

Cloud1 stays running until every miniapp it serves has migrated. Concretely:

1. **Cloud v2 GA in one region (probably US Central).** New users provisioned there. Existing users on cloud1.
2. **First-party miniapps port.** Captions, translation, notes, merge, livestreamer, call, etc. Each port deletes the cloud-side implementation and ships the on-device version. Tracking issues OS-1299 through OS-1306.
3. **Region by region cutover.** As each region reaches "all active users have a phone build that supports the on-device miniapp model," migrate that region's WebSocket traffic from cloud1 to cloud v2. Cloud1 in that region goes read-only, then off.
4. **Cloud1 turn-off.** When the last region migrates, cloud1 is decommissioned. Any remaining v3 alpha SDK apps stop receiving traffic.

The risk during this window is the parallel-codebases problem the CTO originally flagged. Mitigations:

- Cloud1 receives no new feature work after cloud v2 GA. Only critical bug fixes.
- The phone build supports talking to cloud1 OR cloud v2 (whichever the user's account is provisioned against), to remove "bad migration timing" as a class of bug.
- An explicit migration deadline forces the issue: at month 12 of cloud v2 GA, cloud1 is off, period. Anything not migrated by then loses traffic.

### What apps do during migration

Apps fall into three buckets:

1. **First-party miniapps.** We port them. They get a fresh on-device implementation and the cloud-side version is deleted.
2. **Third-party apps on v3 alpha SDK.** They keep working against cloud1 until cloud1 sunsets. They can migrate to the on-device model whenever they want; we do not force them, but cloud1 going away forces them eventually.
3. **Future third-party apps.** They scaffold on the on-device model from day one.

The honest message to existing cloud-SDK app developers: "Cloud1 sunsets in approximately 12 months. The migration target is the on-device miniapp model. We will help you port. If you do not port, your app stops getting traffic when cloud1 is off."

## Open questions

This is a first-pass draft. The following decisions are not landed.

1. **Cutover strategy.** Region-by-region migration vs. global flag-flip vs. user-by-user opt-in. Region-by-region is what I sketched above; alternatives have different blast radius and rollback profiles.

2. **Postgres vs Cockroach vs DynamoDB for the relational tier.** Cloud1 uses MongoDB. Cloud v2 should not. Default to Postgres pending an architecture review.

3. **Redis topology per region.** One cluster vs sentinel vs Cloudflare KV vs Upstash. Affects cost, latency, and operational complexity.

4. **Audio tier deploy unit.** Same Kubernetes namespace as the stateless tier vs separate node pool vs separate cluster. Pros and cons around blast radius, cost, and ops simplicity.

5. **OEM portal placement.** Internal-only admin tool vs partner-facing dashboard. Starts internal; question is when it becomes external.

6. **Backwards compatibility window for v3 alpha SDK.** "Two months" was the verbal target. The migration plan suggests something closer to twelve months for cloud1 sunset, which means v3 alpha SDK lives that long. Reconcile.

7. **Multi-region failover.** Out of scope for v2 (each region is independent). At what point does it become required? Probably tied to enterprise SLAs.

8. **What happens to incident reporting during migration.** Cloud1 and cloud v2 will both produce incidents during the transition. Where do they aggregate? Probably cloud v2's incident system, but cloud1 needs a forwarding shim.

## Cross-references

- `./puddle-architecture.md`: the on-device miniapp runtime that cloud v2 serves.
- `./cloud-scaling.md`: the multi-region scaling plan that cloud v2 inherits.
- `../../../sdk/captions-framework/library-vs-framework.md`: the developer-surface decision the puddle architecture sits on top of.
- `../../OEM-related drafts`: the partner-facing pitch this doc backs.
