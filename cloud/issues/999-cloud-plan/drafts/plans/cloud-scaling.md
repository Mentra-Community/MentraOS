# Cloud Scaling Plan

## Overview

How the MentraOS cloud goes from "single process per region, all sessions in memory, one crash kills everyone" to a horizontally scalable system that handles significantly more users.

Three phases. Each one builds on the last.

## Current State

- Three active regions: US Central, France, East Asia
- Two additional regions deployed but not receiving traffic: US West, US East (client still points to old load balancer)
- China region WIP
- Each region runs a single Bun process, single-threaded, all sessions in memory
- One crash kills every session in that region
- A user's phone, glasses audio, and all their mini app connections must all land on the exact same cloud instance because session state is in memory

## Phase 1: Stability

No point in scaling if the cloud is broken, unreliable, unobservable, and inefficient.

This is active and has made real progress. The goal is a single instance that runs for days without crashing.

**What's been done:**

- Timer leaks pinning disposed sessions in memory (OOM root cause) - fixed
- Hot-path allocation causing JSC heap fragmentation - fixed
- @logtail/pino transport causing heap growth - replaced with Vector
- Unhandled promise rejections crashing the process - fixed
- ResourceTracker throw on disposed session - fixed
- Graceful shutdown (SIGTERM/SIGINT handler, WS close frames, drain middleware) - shipped
- Prometheus metrics scraping (session count, event loop lag, UDP stats) - shipped
- Structured disconnect observability (5 new UserSession fields, 3 new log events) - shipped
- BetterStack log volume fixed (significant daily cost from duplicate collectors) - shipped

**What's still open:**

- Rare crashes still happening on US Central, needs investigation
- Heap objects still growing ~1M/hr, eventually triggering GC death spiral
- `disposedSessionsPendingGC` creeping back to 7-10, indicating more timer/closure leaks
- Heap diagnostics (077) and memory ownership census (078) on hold until signal quality is tightened
- Cloud log noise needs further cleanup so real problems surface faster

**Done when:** Cloud runs for 7+ consecutive days without an OOM kill or crash on all active regions.

## Phase 2: More Regions, Less Latency

Get all deployed regions receiving real traffic and reduce cross-region database latency.

**Load balancer:**

- New load balancer on `api.mentraglass.com` is almost set up
- Had issues with missing properties in Porter configuration
- Still using the old `api.mentra.glass` load balancer
- Need to verify the new LB is fully configured before next mobile client release
- Once verified, mobile client update points users to the new LB, and US West / US East start receiving traffic

**MongoDB read replicas:**

- Non-cached DB calls (user lookups, settings, etc.) have 80ms (US) to 370ms (East Asia) round-trip times
- In-memory app cache handles the hot path (already built and deployed)
- Local read replicas in Europe and East Asia would drop remaining reads to single-digit ms
- This is Atlas configuration plus updating MongoDB connection strings to use read preference routing

**Soniox multi-region:**

- Transcription requests currently cross regions
- Soniox endpoints need to be region-aware so audio doesn't round-trip across the world

**Done when:** All five regions receiving real user traffic. DB reads are single-digit ms in all regions. Transcription stays in-region.

## Phase 3: Stateless Cloud

The core architectural change. Today, everything for one user must be on one instance. This phase breaks that apart so instances within a region can share load, and instances can be added/removed without killing sessions.

### What changes

Session state moves out of process memory and into Redis. The cloud becomes stateless. Any instance can handle any request. Instances can be added, removed, or restarted without losing user sessions.

Redis pub/sub bridges instances. The instance that receives a user's audio publishes transcription results. The instance(s) handling that user's mini app connections subscribe to what they need. No instance needs to hold the full picture.

### What stays sticky

**User session affinity.** A user's phone WebSocket and REST requests use session affinity (HTTP headers) to hit a consistent instance. That instance owns the active connection. But if that instance dies, another instance picks up the session from Redis.

**App session affinity.** Same pattern. Each mini app's WebSocket hits a consistent instance, but the state is in Redis so failover works.

### The key difference from today

User sessions and app sessions no longer need to be on the same instance. A user could be on instance 1, their captions app on instance 2, and their notes app on instance 3. All within the same region.

### Hard problems to solve

**UDP audio routing.** UDP goes through a separate load balancer and doesn't carry HTTP headers, so session affinity doesn't work the same way. Options: a dedicated audio forwarding service, UDP packets tagged with a session identifier, or something else. Needs design work.

**Audio fan-out to mini apps.** Most mini apps subscribe to JSON events, but some subscribe to raw audio chunks. If the mini app session is on a different instance than the user, audio needs a binary pub/sub channel or a dedicated audio service that fans out directly. Needs design work.

**Redis schema.** What exactly goes into Redis? Full session state? Just identity + subscriptions + connection metadata? The less state in Redis, the faster operations are. But too little state means failover doesn't work. Needs design work.

### What makes this easier than it sounds

**SDK v3 was designed for this.** The transport abstraction means the SDK doesn't care whether it's talking to the same instance or a different one. The reconnection model (parked/reattach lifecycle) means transport blips from instance changes don't kill sessions. The subscription model is declarative (derived from handler registrations), so subscriptions can be reconstructed on any instance.

**The Puddle architecture reduces cloud load.** As mini app logic moves to the device (local JS runtime on the phone), the cloud handles fewer app sessions. The cloud becomes more of an SFU (selective forwarding unit) for audio/transcription. Fewer stateful operations per user means horizontal scaling is simpler.

### What still needs to be figured out

- Redis schema for session state and event routing
- UDP audio routing mechanism
- Binary data fan-out strategy for mini apps subscribing to audio
- Load testing to find per-instance capacity before and after the refactor
- Migration strategy (how do you go from stateful to stateless without downtime?)

## How the Puddle Changes the Scaling Story

The Puddle architecture (local runtime on the phone) shifts a lot of work off the cloud:

- Session management, app lifecycle, subscriptions, display routing all move to the device
- The cloud keeps: audio streaming (UDP), transcription/translation (Soniox), app store/registry, and a read-only replica of subscriptions
- Per-user cloud load drops significantly since the cloud is forwarding, not orchestrating
- This makes Phase 3 easier because there's less state to externalize

The Puddle isn't a scaling prerequisite, but the two efforts reinforce each other. A stateless SFU cloud is simpler to scale than a stateful session-management cloud.

## Summary

| Phase              | What                                                   | Depends on                                                          |
| ------------------ | ------------------------------------------------------ | ------------------------------------------------------------------- |
| 1. Stability       | Stop crashing, fix leaks, improve observability        | Nothing (active)                                                    |
| 2. More regions    | LB verification, MongoDB replicas, Soniox multi-region | Phase 1 (stable enough to trust with more users)                    |
| 3. Stateless cloud | Redis, session externalization, UDP routing            | Phase 2 (multi-region is live), SDK v3 reconnection model (shipped) |
