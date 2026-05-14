# Cloud v2 Audio Path Spike

**Status:** Complete. Findings feed [`spec.md`](./spec.md) and [`design.md`](./design.md).

## Why this spike

Cloud v1's audio pipeline is the hardest piece of v2's "horizontally
scalable from day one" goal. Every per-user piece of state currently
lives in one pod's memory: the LC3 decoder, the Soniox WebSocket for
transcription, the translation streams, the VAD buffers. The pod
owns the user for the entire session.

That's the structural blocker for multi-pod scale. The spike's job
was to research how other audio/streaming systems handle this, lay
out the options, and feed a proposal into the spec.

## Concepts primer

Terms used throughout these docs. Plain English alongside each. Skim
once, refer back as needed.

- **Pod.** A running container instance on Kubernetes. The unit of
  "one cloud server running." Each pod has a unique hostname.
- **Deployment.** The K8s abstraction that manages a set of pods.
  When you say "scale the cloud to 3 replicas," K8s creates 3 pods.
- **Worker (within a pod).** A separate JavaScript thread inside a
  pod, created using Bun's `Worker` API. Lets CPU-bound work happen
  off the main event loop. Communicates with the main thread by
  `postMessage`.
- **Transferable.** A JavaScript value (typically an `ArrayBuffer`)
  that can be *moved* between the main thread and a worker via
  `postMessage` instead of copied. Zero-copy hand-off. Important for
  audio packets to avoid per-packet allocation overhead.
- **MessageEvent.** The standard DOM event delivered to a worker (or
  main thread) when a message arrives. `messageEvent.data` is the
  message body.
- **UDP.** User Datagram Protocol. Connectionless, low-overhead,
  packet-based. Each packet (datagram) is routed independently. No
  delivery guarantees — packets can be dropped, reordered,
  duplicated. Used for audio because the overhead and latency are
  lower than TCP.
- **LC3.** Low Complexity Communication Codec. The audio codec used
  between the glasses and the phone (and forwarded up to the cloud).
  Decoded into PCM (raw audio samples) before being fed to
  transcription providers.
- **PCM.** Pulse Code Modulation. Raw uncompressed audio samples.
  What providers like Soniox accept.
- **Redis Stream.** A persistent, append-only log structure in
  Redis. Producers append entries, consumers read in order. Supports
  consumer groups (multiple consumers, each receiving a different
  entry), acks, and replay. Used here as a per-user audio bus.
- **Consumer group.** A named set of consumers reading from a stream.
  Each entry is delivered to exactly one consumer in the group.
  Unacked entries can be claimed by another consumer if the original
  consumer dies.
- **TTL (Time To Live).** A duration after which Redis automatically
  deletes a key. Used here for ownership claims and pod heartbeats.
- **Hash tag.** Redis cluster mode primitive: keys with the same
  substring inside `{ }` hash to the same shard. We use `{user:X}`
  to keep all of one user's keys colocated.
- **Session affinity.** Load-balancer behavior that routes the same
  client to the same backend. We do not use this — see
  [`spec.md`](./spec.md) for why.
- **Token Exchange (RFC 8693).** OAuth 2.0 standard for swapping one
  token for another. Used by the audio path indirectly: the phone has
  already done a token exchange (specified in 001-oem-auth) and
  presents a Mentra access token. See [`../001-oem-auth/design.md`](../001-oem-auth/design.md).
- **Soniox.** The transcription provider currently used by v1. Has
  its own WebSocket protocol and per-stream lifecycle.

Auth-specific jargon (JWT, JWK, jti, audience) is glossed in
[`../001-oem-auth/design.md`](../001-oem-auth/design.md). Cross-reference
when needed.

## What we explored

Two categories of research:

1. **Other systems' approaches to cross-pod real-time audio routing.**
   Looked at LiveKit (WebRTC SFU), Twilio (telephony), Discord
   (voice channels), Agora (low-latency audio), Daily.co. All have
   their own room/session abstractions; ownership is generally
   server-managed and reconnections route to the same backend.

2. **Generic platform patterns for stateful work behind stateless
   ingress.** Kafka consumer groups, NATS, Redis Streams,
   in-process sticky-routing with external lookup tables. The pattern
   we landed on (stateless ingress + Redis bus + ownership claim)
   is well-trodden in event-driven systems, just applied to audio.

### Why we didn't go with LiveKit

The v1 cloud had a LiveKit integration in progress for audio (see
the stale `LIVEKIT-AUDIO-INTEGRATION.md` in v1's repo). It was
deprecated. The team chose to keep the direct UDP path for v2 rather
than reintroduce LiveKit.

Implications:
- We own the audio routing protocol end-to-end.
- We carry the v1 UDP packet format forward (carried over unchanged).
- We build the cross-pod routing layer ourselves on Redis.

## Prior art (the closest analogues)

| System | Pattern | Why it differs from us |
| --- | --- | --- |
| LiveKit | WebRTC rooms; SFU owns routing | We're not running an SFU; we route UDP directly |
| Kafka consumer groups | Stateless producer, group of stateful consumers | Same pattern at the structural level; Redis Streams give us a smaller dependency |
| Twilio | Per-call media server, sticky | Their use case is duplex audio; ours is one-way mic-up |
| Generic event-driven pattern | Append to a queue, owner reads | This is what we land on, with Redis Streams as the queue |

## Architectural decisions reached

Each of these is fleshed out in [`spec.md`](./spec.md) with reasoning.
Listed here for skimmability.

### Ingress is stateless

Any pod can receive any audio packet. The packet header carries a
session/user identifier; the receiving pod writes the packet to a
Redis Stream keyed by that user. No pod is "the audio receiver" for
any user.

### Redis Streams are the audio bus (not pub/sub)

Streams provide persistence and replay. When a pod takes over a user
from a dead predecessor, it joins the consumer group and uses
`XAUTOCLAIM` to inherit unacked entries — replaying the buffered
audio so transcripts catch up rather than gap. Pub/sub would drop
audio during the failover window.

### Ownership is a Redis key with a short TTL

`{user:X}:owner` holds `<podId>:<workerIdx>`. The owner refreshes
every 1.5s with TTL 5s. Absence of refresh (because the pod died,
hung, or lost Redis access) lets another pod claim the user. No
"is this pod alive" RPC needed; the absence of the heartbeat is the
signal.

### Workers within a pod, not one process per pod

A pod spawns N workers using Bun's `Worker` API (N ≈ number of CPU
cores). Users are assigned to workers by `hash(userId) % N` and stay
on that worker for the session. Main thread holds the WebSocket and
Redis client; workers hold per-user decode/provider state.

### Main thread is the only Redis client

Workers don't talk to Redis directly. The main thread reads from the
audio stream and dispatches packets to workers via `postMessage`
with the audio buffer as a Transferable (zero-copy). Workers send
results back the same way. This keeps the worker IPC surface small
and the failure-isolation story simple.

### Subscriptions are phone-canonical, structured, deduped on the phone

In v1, the cloud's `subscriptionManager` merges duplicate subscriptions
across multiple app sessions. In v2, miniapps run locally on the
phone, so the phone aggregates and dedupes before sending to cloud.
Cloud sees a flat structured set; no string parsing of
`"transcription:en-US?hints=ja"` style identifiers.

### Pod identity comes from `os.hostname()`

K8s sets each pod's hostname to its name (e.g.,
`cloud-v2-cloud-57668d8bc6-dwcwn`). Unique per pod, fresh after each
restart. No Downward API config needed.

### Recovery budget is loose; transcript continuity is strict

Recovery time targets: <5s for common faults, <10s for rare ones.
These are aspirational, not contractual. The strict requirement is
**no missing words in the transcript across a failure**. Redis Streams
+ `XAUTOCLAIM` give us this because audio is buffered through the
gap and replayed when the new owner picks up.

### Soniox reconnect logic is inherited from v1

The team chose not to re-engineer Soniox-side failover for v2. When
Soniox drops, the worker reconnects using the same retry behavior as
v1. Multi-provider redundancy is deferred.

### LiveKit is not used

V1's in-progress LiveKit audio integration is deprecated. v2 uses the
direct UDP path with the same packet format as v1.

## What didn't make the cut

### Cross-pod hot standby

Considered: a designated standby pod for each user, kept warm so
failover is <500ms. Rejected: adds significant resource overhead (~2x
worker resources, 2x provider connections), and the recovery budget
loosened to "transcript continuity" doesn't require it. We can revisit
if a worker death turns out to be common in practice.

### Soniox connection pool

Considered: pre-established Soniox connections per pod to skip the
~1-2s handshake on worker takeover. Rejected: defer until measurement
shows Soniox handshake is the SLO-violating step. Adds complexity
without clear win.

### Pub/sub for the audio bus

Considered: simpler and faster than Streams, lower CPU load on Redis.
Rejected: doesn't survive failover. Audio published during the gap
between owner-death and new-owner-takeover is lost forever with
pub/sub. Streams preserve it.

### Source-IP session affinity at the load balancer

Considered: K8s `sessionAffinity: ClientIP` (or Azure LB equivalent)
to pin a user's UDP packets to one pod. Rejected: mobile clients
change IPs (cellular ↔ WiFi), NAT means multiple clients share an IP,
and the application-layer routing (parsing session ID from the packet
header) is what we actually want. Affinity at the LB layer would
fight that, not help.

### Storing the desired subscription set in Redis

Considered: cache the user's current subscription set in Redis so a
new owner pod doesn't need the phone to re-send on takeover.
Rejected: the phone is the source of truth for user intent; making
cloud a derivative of phone state matches v2's philosophy. Phone
re-sends on reconnect; cost is minimal.

## State ownership map (summary)

Detailed version in [`spec.md`](./spec.md). Summary:

| State | Source of truth |
| --- | --- |
| User intent (which subscriptions, mic state) | Mobile client |
| Running miniapps and their state | Mobile client |
| Installed miniapp code | Mobile client (downloaded from store) |
| Installed miniapp list | Persistent DB (cached on phone) |
| User account, OEM linkage | Persistent DB |
| Active WebSocket connections | Owner pod |
| Per-user decoder, provider connections | Worker on owner pod |
| Cross-pod ownership of user | Redis (`{user:X}:owner`) |
| Audio packets in flight | Redis Stream (`{user:X}:audio`) |
| Pod aliveness | Redis (`pods:heartbeat:<podId>`) |

## Key trade-off axes the spike surfaced

These shape the design without dictating a single answer:

- **Resilience vs. complexity.** Hot standbys, connection pools,
  multi-provider redundancy all reduce recovery time at the cost of
  resource use and code complexity. We chose the simplest design
  that meets the continuity bar; revisit if measurement shows gaps.
- **Cloud-state vs. phone-state.** Anything we put on the cloud's
  side that the phone also knows creates a sync problem. Defaulting
  to phone-canonical removes a class of failure.
- **Cross-pod vs. within-pod.** Each layer (pod-to-pod via Redis,
  worker-to-main via postMessage) has its own failure modes. Keeping
  the ownership story consistent at both layers (TTL'd claim,
  hash-based assignment) makes the system easier to reason about.

## What feeds into spec.md and design.md

- The architectural commitments (stateless ingress, Redis Streams,
  worker model, ownership TTL).
- The fault model (heartbeats, recovery budget, continuity bar).
- The structured subscription types and result types.
- The state ownership map.
- The session bootstrap walkthrough (in design.md) using all of the
  above to validate the design hangs together.
