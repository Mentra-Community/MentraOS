# Cloud v2 Audio Path Spec

**Status:** Proposal. Bringing to team for discussion.

## Why this doc

Bridge from the audio spike ([`spike.md`](./spike.md)) to a concrete
architectural proposal. Lays out goals, the chosen approach, the
fault model, and what's deliberately out of scope. Implementation
specifics (Redis commands, message shapes, walkthrough) live in
[`design.md`](./design.md).

## Goals

- **Horizontal scale from day one.** Multiple pods serve the same
  cloud, distributing users. No single-pod bottleneck.
- **Workers per core.** Each pod uses every CPU it's given. CPU-bound
  work (LC3 decode, transcription) runs off the main event loop.
- **Transcript continuity through failure.** Worker death, pod death,
  Redis blip, phone reconnect — none of these produce a transcript
  with missing words for the user. This is the load-bearing quality
  bar.
- **Stateless ingress.** No pod is "the audio receiver" for any user.
  Any pod handles any packet.
- **Inheritance from v1 where possible.** UDP packet format,
  transcription provider behavior, Soniox reconnect logic — all
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

### Commitment 1: Stateless UDP ingress, Redis-routed ownership

Any pod can receive any UDP audio packet. Packets carry a session
identifier in their header. The receiving pod writes the packet to a
Redis Stream keyed by the user. The user's owner pod (the one
holding the user's WebSocket) reads from the stream and processes.

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
- UDP ingress (parse header, write to Redis Stream)
- Redis Stream subscription for owned users (read entries, dispatch
  to the right worker)
- Worker pool lifecycle (spawn, monitor, replace on death)
- Sending results back over the WebSocket

Worker responsibilities:
- Receive audio chunks via `postMessage` (transferred, not copied)
- LC3 decode → PCM
- Maintain provider connections (Soniox, etc.) per active
  subscription
- Emit transcripts and translations back to main thread via
  `postMessage`

Workers do not talk to Redis. The main thread brokers all I/O on
their behalf. Keeps the worker IPC surface small and isolates
failure modes.

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
flight at the moment of the failure — between the phone and the
ingress pod, never reaching Redis — is lost (UDP loss is expected).
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

type AudioForwardingSubscription = {
  kind: "audio-forwarding";
  targetId: string;
  endpoint: string;
  payload: "raw-audio" | "transcription" | "translation";
  authToken?: string;
};

type AudioSubscription =
  | TranscriptionSubscription
  | TranslationSubscription
  | AudioForwardingSubscription;
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
| Installed miniapps (list) | Persistent DB | Mobile client (cache) | Permanent |
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
math in the spike. See [`design.md`](./design.md) for sizing notes.

## What this assumes from other docs

- **OEM auth (001).** A connecting phone has already obtained a
  Mentra access token via the OEM auth flow. The audio path verifies
  this token and uses `MentraUserId` from its claims. See
  [`../001-oem-auth/design.md`](../001-oem-auth/design.md) for the
  token format and verification logic.
- **OEM portal (002).** Not directly assumed by the audio path. OEM
  registration happens through the portal; the audio path just sees
  the resulting issued tokens.
- **E2E test infrastructure (future).** Will reference both 001 and
  003 for what to test against.

## Out of scope

- Specific Redis commands, message shapes, walkthroughs — in
  [`design.md`](./design.md).
- Migration plan from v1 to v2. Big separate topic.
- Multi-region active-active. Single region in v2.
- Audio forwarding (the future subscription kind) implementation.
  Spec'd as a subscription shape, deferred.
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
5. **Test client deployment.** The audio test client (for e2e)
   needs to reach the cloud under test, the TEST OEM, and Redis.
   Deployment topology — local Bun process, sibling Porter app,
   K8s test namespace — needs deciding when we get to e2e tests.

## Related work

- [`../001-oem-auth/`](../001-oem-auth/) — runtime OEM auth (issued
  tokens; this spec consumes them)
- [`../002-oem-portal/`](../002-oem-portal/) — OEM admin portal
  (independent of audio path)
- Future: e2e test infrastructure spec
