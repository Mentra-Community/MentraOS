# Cloud v2 Audio Path

**Status:** Spike + spec under review

## Problem

Cloud v1's audio path can't scale horizontally. User session state
(audio decoder, transcription provider connection, etc.) lives in pod
memory, so a single pod owns each user for the duration of their
session. Pod restarts drop sessions, multi-pod deployments can't share
load on a single user, and the system has no way to recover from a
pod death without dropping the user's transcript continuity.

Cloud v2's audio path must be horizontally scalable from day one,
support failover without losing transcript continuity, and use workers
to spread CPU-bound work (LC3 decode, transcription routing) across
all cores of a pod.

## Files

- `README.md` — this doc
- [`spike.md`](./spike.md) — research findings, concepts primer,
  options considered, decisions reached
- [`spec.md`](./spec.md) — proposal: stateless UDP ingress, Redis-routed
  ownership, worker model, fault tolerance, transcript continuity.
  **Start here for the architecture.**
- [`design.md`](./design.md) — implementation specifics: Redis keys,
  typed worker protocol, walkthroughs, packet header format

## tl;dr

Three architectural commitments:

1. **Stateless UDP ingress.** Any pod can receive any audio packet.
   Each packet's header carries a session ID; the receiving pod
   writes the packet to a Redis Stream keyed by user. The owner pod
   (the one holding the user's WebSocket) reads from the stream.

2. **Workers within a pod.** Each pod runs N workers (one per core,
   roughly). Users are dispatched to workers by hash. Workers hold
   per-user state (LC3 decoder, transcription provider connection)
   and do all CPU-bound work off the main event loop.

3. **Redis-routed ownership.** A user's owner pod is recorded in
   Redis with a short TTL, refreshed by the owner. Absence of refresh
   is the universal failure signal. Failover: a new pod claims
   ownership, replays unacked audio from the stream, and transcripts
   resume with no missing words.

The single quality bar: **transcript continuity through failure**.
Recovery time target is <5s for common faults, <10s for rare ones,
but the absolute requirement is no missing words across the gap.

Full reasoning, alternatives considered, fault model, and protocol in
[`spec.md`](./spec.md) and [`design.md`](./design.md).

## Cross-references

- OEM auth runtime: [`../001-oem-auth/`](../001-oem-auth/). The audio
  path assumes users have already obtained a Mentra access token
  through the OEM auth flow. The test client uses the TEST OEM
  (specified in 001) to authenticate before exercising audio.
- E2E test infrastructure: not yet specified. Will reference both
  001 and 003 once spec'd.
