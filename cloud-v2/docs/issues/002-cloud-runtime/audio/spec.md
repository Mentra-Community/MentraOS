# Cloud v2 Audio Path Spec

**Status:** Proposal. Bringing to team for discussion.

## Why this doc

The audio architecture: the goals, the chosen approach, the fault model, and what's
deliberately out of scope. The plain-language overview of the whole runtime is in
[`../architecture.md`](../architecture.md); the implementation specifics (Redis
commands, message shapes, walkthroughs) are in [`design.md`](./design.md).

## Goals

- **Horizontal scale from day one.** Multiple pods serve the same
  cloud, distributing users. No single-pod bottleneck.
- **Workers per core.** Each pod uses every CPU it's given. CPU-bound
  work (LC3 decode, transcription) runs off the main event loop.
- **Transcript continuity through failure.** Worker death, pod death,
  Redis blip, phone reconnect, none of these produce a transcript
  with missing words for the user. This is the load-bearing quality
  bar.
- **Stateless ingress.** No pod is "the audio receiver" for any user.
  Any pod handles any packet.
- **Inheritance from v1 where possible.** UDP packet format,
  transcription provider behavior, Soniox reconnect logic, all
  carry forward. v2 is an architecture rewrite, not a from-scratch
  reimplementation of every component.

## Goals we're not chasing

- Sub-second recovery from pod death. We aim for <5s common, <10s
  worst case; we don't engineer for invisible recovery.
- Multi-provider transcription redundancy. Deferred.
- Cloud-side audio history or transcript retention. Per v1's issue
  098, transcripts are not stored.
- App sessions on cloud. Apps are local miniapps on the phone in v2.

## Two architectural commitments

These are the proposal. Reasoning, alternatives, and details follow.

### Commitment 1: Stateless ingress (UDP primary, WS fallback), Redis-routed ownership

Audio ingress is dual-transport. Both deliver the same v1 packet format
into the same Redis stream; downstream logic is transport-agnostic.

- **UDP** is the primary path. Lower overhead, lower latency. Any pod can
  receive any UDP packet on the audio service's UDP port.
- **WebSocket binary frames** are the fallback. When UDP can't get through
  (mobile NAT, client on cellular vs laptop on LAN during local dev, etc.)
  the phone sends the same packet payload as a binary message on the
  per-user transcript-delivery WebSocket. v1 already supports this: see
  `bun-websocket.ts handleGlassesMessage` (binary messages route into
  `AudioManager.processAudioData`).

Phones decide which transport to use; cloud accepts whichever arrives.
Local dev typically uses WS (no NAT/firewall headaches); prod typically
uses UDP. Same code path on the cloud side either way.

Packets carry a session identifier in their header. The receiving pod
writes the packet to a Redis Stream keyed by the user. The user's owner
pod (the one holding the user's WebSocket) reads from the stream and
processes.

```
                    LB (round-robin UDP)
                          │
              ┌───────────┼───────────┐
              ▼           ▼           ▼
            Pod A       Pod B       Pod C   (any can receive)
              │           │           │
              └───────────┼───────────┘
                          ▼
                    Redis Stream
                  {user:X}:audio
                          │
                          ▼
                Owner Pod (Pod B says)
                          │
                          ▼
                  Worker for user X
                          │
                          ▼
              decode → Soniox → transcript
                          │
                          ▼
              Phone WebSocket (on Pod B)
```

Ownership is recorded in `{user:X}:owner` with a short TTL, refreshed
by the owner. Absence of refresh = owner is dead (crashed, hung,
network partition, doesn't matter) = another pod can take over.

### Commitment 2: Workers within a pod, hash-assigned

A pod spawns N workers (one per CPU core, roughly) using Bun's
`Worker` API. Users are assigned to workers by `hash(userId) % N`
and remain on that worker for the session. Workers hold per-user
state: LC3 decoder, transcription provider connection, VAD buffer,
optional translation streams.

Main thread responsibilities:
- WebSocket accept and lifecycle
- Ownership claim / refresh / release
- UDP ingress (parse header, write to Redis Stream)
- User assignment to workers (least-loaded picker)
- Forwarding transcripts from workers back over the WebSocket
- Worker pool lifecycle (spawn, monitor, replace on death)

Worker responsibilities:
- Own a slice of users (assigned by main thread via `postMessage`)
- Maintain a Redis streams client; XREADGROUP the assigned users'
  audio streams, XAUTOCLAIM for failover replay, XACK after processing
- LC3 decode → PCM
- Maintain provider connections (Soniox, etc.) per active
  subscription
- Emit transcripts and translations back to main thread via
  `postMessage`

**Workers handle their own stream reads.** This is a revision from the
earlier draft, which had main thread brokering every entry. The earlier
rule was motivated by IPC-surface minimization, but at the scale we
want to hit (target ~200–300 users/pod comfortable, ceiling ~1000),
routing every entry through the main thread makes it the bottleneck
(one event loop doing WS accept + UDP ingress + ownership refresh +
per-entry postMessage routing). Splitting stream reads to workers
keeps the main thread lean, it only sees user-assignment changes
and transcripts going out, while parallelism scales with worker
count. ioredis client per worker is cheap (a few hundred connections
to the Redis cluster across the fleet) and worker death stays local
(ioredis cleans up on thread exit).

The IPC surface that the earlier rule wanted to keep small is still
small: main↔worker messages are `ATTACH_USER`, `DETACH_USER`, and
`TRANSCRIPT`. No per-audio-frame shuttling.

## Fault tolerance model

The single primitive: **TTL'd claims refreshed by the owner.**
Absence of refresh is the universal failure signal. Crashes, hangs,
network partitions all manifest as "claim expired."

| Claim | TTL | Refresh cadence |
| --- | --- | --- |
| `{user:X}:owner` (Redis key) | 5s | every 1.5s by owner pod |
| `pods:heartbeat:<podId>` (Redis key) | 3s | every 1s by pod |
| Worker liveness (in-pod, in-memory) | 3s | every 1s by worker (ping/pong) |
| Phone WS keepalive | 3s | every 1s ping |

### Failure mode catalog

| Failure | Detection | Recovery |
| --- | --- | --- |
| Worker crashes | Bun `Worker` `exit` event, immediate | Main thread spawns replacement worker, reassigns affected users; provider connections rebuild |
| Worker hangs | Heartbeat miss for 3s | Main thread kills the worker, same recovery as crash |
| Pod crashes | Ownership claim TTL expires after 5s | Another pod (chosen by phone reconnect) claims; replays buffered audio via `XAUTOCLAIM` |
| Pod hangs | K8s liveness probe fails | K8s restarts; same recovery as crash |
| Redis transient | Client reconnects with backoff | Audio buffered briefly at ingress; cleared on reconnect |
| Soniox connection drops | Provider's own error event | Reconnect (carry v1 logic); audio buffered in Redis during the gap |
| Phone WS drops + reconnects | WS close event | Owner releases claim, phone reconnects to any pod, claim re-acquired |
| Graceful pod shutdown | SIGTERM | Pod drains: stops accepting new claims, releases existing, lets in-flight finish, exits |

Detail flows in [`design.md`](./design.md).

### Recovery time budget

| Failure mode | Target |
| --- | --- |
| Worker crash | <3s |
| Pod crash, phone-driven reconnect | <8s |
| Graceful deploy (pod drain) | <1s (invisible) |
| Soniox reconnect | <3s |
| Redis transient | <2s |

These are targets, not contracts. The contract is transcript
continuity. We measure recovery time in the e2e test suite to know
when something has regressed.

### Continuity: how we guarantee no missing words

The Redis Stream for audio retains roughly 10-20 seconds of audio
per user (configured via `MAXLEN`, see [`design.md`](./design.md)).
On failover:

1. The new owner joins the consumer group `audio-workers`.
2. The new owner runs `XAUTOCLAIM` to inherit unacked entries from
   the previous consumer (the dead one).
3. The new owner replays those entries through its decoder and
   provider connection in order.
4. Provider emits transcripts for the replayed audio.
5. Transcripts flow to the phone WebSocket (on the new owner pod).

The user perceives a brief delay in transcript output during the
failover, not a gap. No words are missing.

This only works if the audio is in the stream. Audio that was in
flight at the moment of the failure, between the phone and the
ingress pod, never reaching Redis, is lost (UDP loss is expected).
Audio that reached an ingress pod and was written to Redis is
guaranteed delivery.

## Subscription model

Subscriptions are structured discriminated-union types, not strings.
Phone aggregates and dedupes across local miniapps; sends a flat
list to cloud on every (re)connect.

```ts
type LanguageSource =
  | { mode: "specific"; code: string }                  // "en-US"
  | { mode: "auto"; hints?: string[] };                  // detect, optionally with candidate list

type TranscriptionSubscription = {
  kind: "transcription";
  language: LanguageSource;
};

type TranslationSubscription = {
  kind: "translation";
  source: LanguageSource;
  target: string;                                        // ISO code
};

type AudioSubscription =
  | TranscriptionSubscription
  | TranslationSubscription;
```

Identity is structural: two subscriptions are the same if their
fields are equal (after canonicalization, e.g., sorting `hints[]`).
Reconciliation: cloud diffs the phone's desired set against its
current set, starts new streams, stops removed ones.

No subscription IDs. No string-encoded options. No query parameters.

## Result types

Modeled on v1's `TranscriptionData` and `TranslationData` so the SDK
boundary is familiar. Grounded in what providers (Soniox) actually
return.

```ts
type TranscriptionToken = {
  text: string;
  startMs: number;
  endMs: number;
  confidence: number;
  isFinal: boolean;
  speaker?: string;
  detectedLanguage?: string;     // per-token; mid-sentence switches possible
};

type TranscriptionData = {
  userId: string;
  subscription: TranscriptionSubscription;

  // Aggregated for simple consumers
  text: string;
  isFinal: boolean;
  utteranceId?: string;
  speakerId?: string;
  startMs: number;
  endMs: number;
  durationMs?: number;
  confidence?: number;

  // Language resolution
  resolvedLanguage: string;
  languageDetected: boolean;

  // Per-token detail for consumers that need it
  tokens: TranscriptionToken[];

  provider: string;
  timestamp: number;
};

type TranslationData = {
  userId: string;
  subscription: TranslationSubscription;

  text: string;                  // translated
  originalText?: string;         // source-language text
  isFinal: boolean;
  speakerId?: string;
  startMs: number;
  endMs: number;
  durationMs?: number;
  confidence?: number;

  source: {
    language: string;            // resolved (specified or detected)
    detected: boolean;
    confidence?: number;
  };
  target: { language: string };

  provider: string;
  timestamp: number;
};
```

## State ownership map

Detailed table of what state lives where and who's the source of
truth.

| State | Source of truth | Cached/replicated where | Lifetime |
| --- | --- | --- | --- |
| User account, OEM linkage, MentraUserId | Persistent DB (Mongo) | Brief in-memory at request time | Permanent |
| Installed miniapps (list) | Mobile client | Persistent DB (cache for cross-device sync) | Permanent |
| Installed miniapps (code/JS bundles) | Mobile client | Downloaded from store/CDN | Until uninstall |
| Miniapp catalog | Persistent DB / object storage | CDN | Permanent |
| User preferences | Persistent DB | Mobile client | Permanent |
| Running miniapps on the phone | Mobile client | nowhere | While running |
| Display state, mic state | Mobile client | nowhere | ms to seconds |
| Per-miniapp subscriptions | Mobile client | nowhere | While running |
| Deduped subscription set sent to cloud | Mobile client | Owner pod's worker (in-memory) | Session |
| Active WS connection | Phone + Owner pod | n/a | Session |
| Audio sender state (codec, sequence) | Mobile client | n/a | Session |
| `userId → pod` ownership | Redis (`{user:X}:owner`) | Owner pod (in-memory mirror) | TTL'd, ~session |
| `userId → workerIndex` (within a pod) | Owner pod's main thread | n/a | Derived: `hash(userId) % N` |
| Audio packets in flight | Redis Stream (`{user:X}:audio`) | Worker's read position | Bounded retention (~10-20s) |
| LC3 decoder state | Worker | n/a | Session; rebuilds on takeover |
| Provider WS (Soniox) | Worker | n/a | Session; rebuilds on takeover |
| VAD / stream-startup buffers | Worker | n/a | Stream startup window |
| Pod heartbeat | Redis (`pods:heartbeat:<podId>`) | Pod main thread | TTL'd, pod uptime |
| Worker heartbeat | Worker → main, in-memory | n/a | Worker uptime |
| Transcript history | Nobody (intentional) | Phone keeps local if it wants | Live only |

## Pod identity

Each pod identifies itself by `os.hostname()`. K8s sets the hostname
to the pod name automatically (e.g., `cloud-v2-cloud-57668d8bc6-dwcwn`).
Unique per pod, fresh on each restart. Used in:

- Redis ownership claim values: `<hostname>:<workerIndex>`
- Redis Stream consumer names
- Pod heartbeat keys
- Log fields and metrics labels

Local dev fallback: when `process.env.NODE_ENV !== "production"`,
prepend `local-` and append `process.pid` for distinctness across
multiple local instances.

## Load balancer behavior

- **Session affinity is disabled** for both UDP and WS services.
  Routing is round-robin or random.
- **UDP ingress** intentionally distributes packets across pods.
  Application-layer routing (parse session ID, write to Redis) does
  the work.
- **WS connections** are TCP-sticky for their lifetime by nature of
  TCP. On disconnect+reconnect, the new WS lands on whatever pod the
  LB picks; the application layer (ownership claim) handles the
  routing.

This is a deliberate choice. Source-IP affinity on the LB would
fight the application-layer routing without giving us better
session-pod stickiness (mobile IPs are unstable, NAT means many
clients share an IP).

## Cluster mode considerations (future)

The Redis key design uses hash tags `{user:X}` so all of one user's
keys land on the same shard when we eventually move to Redis Cluster
Mode (e.g., ElastiCache cluster mode). The audio stream operations
(`XADD`, `XREADGROUP`, `XAUTOCLAIM`, `XACK`) stay on one shard per
user.

Pub/sub-style fan-out is not used in v2's audio path. If we ever
need cross-pod broadcast for something else, we'd use Redis 7+
sharded pub/sub (`SPUBLISH`/`SSUBSCRIBE`).

Single-node Redis (in-cluster pod or `cache.t4g.medium` ElastiCache)
is plenty for the experiment phase. Cluster mode is the answer when
we exceed ~3,000 concurrent users sustained, based on rough capacity
math. See [`design.md`](./design.md) for sizing notes.

## Alternatives considered and rejected

Things we looked at and chose not to build, so the reasoning isn't lost:

- **A warm standby pod per user** (a second pod kept ready so failover is under half
  a second). Rejected: it roughly doubles the worker and provider resources, and the
  bar we set (transcript continuity, not invisible recovery) doesn't need it. Worth
  revisiting only if a worker dying turns out to be common in practice.
- **A pool of pre-opened Soniox connections** (to skip the ~1 to 2 second handshake
  when a worker takes over a user). Rejected for now: only worth it if measurement
  shows that handshake is the step blowing the recovery budget.
- **Pub/sub instead of a Redis stream for the audio bus** (simpler, lighter on
  Redis). Rejected: pub/sub doesn't survive failover. Any audio published during the
  gap between the old owner dying and the new one taking over is gone for good; a
  stream keeps it, which is what makes the no-missing-words guarantee possible.
- **Source-IP affinity at the load balancer** (pin a user's packets to one pod).
  Rejected: mobile IPs change (cellular to WiFi), NAT means many clients share one IP,
  and the routing we actually want is application-layer (read the session id from the
  packet header). LB affinity would fight that, not help.

## What this assumes from other docs

- **Runtime auth (007).** A connecting phone presents a `cloud-runtime` token. The
  audio path verifies this token against Runtime's configured issuer/JWKS list and
  uses the normalized user id plus `tenantId` from its claims. Hosted deployments may
  obtain that runtime token through the Core/Auth OEM exchange; self-hosted
  runtimes can trust the OEM's issuer directly.
- **OEM portal (002).** Not directly assumed by the audio path. OEM
  registration happens through the portal; the audio path just sees
  the resulting issued tokens.
- **E2E test infrastructure (future).** Will reference both 001 and
  003 for what to test against.

## Out of scope

- Specific Redis commands, message shapes, walkthroughs, in
  [`design.md`](./design.md).
- Migration plan from v1 to v2. Big separate topic.
- Multi-region active-active. Single region in v2.
- Audio forwarding to external developer endpoints (raw audio,
  transcripts, or translations sent to a webhook-style target).
  Mentioned in the v2 plan as a later/non-goal; not in scope here.
- Specific cluster sizing and capacity planning. Rough math in
  [`design.md`](./design.md); real numbers come from measurement.

## Open questions for team review

1. **Codec changes mid-session.** Can the phone switch from LC3 to
   PCM mid-session? Affects whether `codec` is a session-setup
   parameter (immutable) or supports change messages. Lean:
   immutable, set at session start.
2. **Subscription update granularity.** Phone sends full deduped set
   on every change. Idempotent reconciliation on cloud. Alternative:
   delta semantics (add this, remove that). Lean: full set, simpler.
3. **Audio retention window in Redis.** Proposed: 10-20 seconds via
   `MAXLEN ~ 1000`. Tied to the recovery budget. Worth team review.
4. **Provider abstraction.** Workers hold provider connections
   (Soniox today, maybe Alibaba or Azure later). Carry v1's
   `TranscriptionProvider` interface or redesign? Lean: carry v1's
   surface; we're not chasing multi-provider in v2's audio.
5. **Test client deployment.** The test client is the `@mentra/cloud-client` node
   build (see [`../../004-cloud-client/`](../../004-cloud-client/)): the same client
   the phone runs, driven from a server. It still needs to reach the cloud under
   test, the TEST OEM, and Redis; the deployment topology (local Bun process, sibling
   Porter app, K8s test namespace) is decided when we get to e2e tests.

## Related work

- [`../../007-runtime-auth-independence/README.md`](../../007-runtime-auth-independence/README.md),
  Runtime token issuer/JWKS verification model
- [`../../001-cloud-core/auth/oem-auth.md`](../../001-cloud-core/auth/oem-auth.md),
  OEM subject-token exchange Core/Auth can use to broker hosted Runtime tokens
- [`../../005-websites/oem-portal/`](../../005-websites/oem-portal/), OEM admin portal
  (independent of audio path)
- Future: e2e test infrastructure spec
