# Cloud Scaling

TODO: Detailed implementation plan needs to be written. The sections below capture what we know so far.

## Goal

MentraOS currently serves ~1,000 weekly active users across three regions. The goal is to support 5,000+ weekly active users as G2 adoption grows. This requires the cloud to be more reliable, more performant, and architecturally capable of horizontal scaling.

## Current State

- Three active regions: US Central (~60-75 sessions), France (~16-18 sessions), East Asia (~3-4 sessions)
- Two additional regions deployed but not receiving traffic: US West, US East (client still points to old load balancer)
- China region WIP
- Each region runs a single Bun process, single-threaded, all sessions in memory
- One crash kills every session in that region
- A user's phone, glasses audio, and all their MiniApp connections must all land on the exact same cloud instance because session state is in memory

## Step 1: Reliability

Before scaling horizontally, make each instance handle more users reliably. A single instance that runs for days without crashing is worth more than three instances that all crash every 7 hours.

- Fix remaining memory leaks (disposedSessionsPendingGC creeping back up, heap objects growing ~1M/hr)
- Reduce log noise so real problems surface faster
- Continue crash investigation and fix cycle
- This work is already in progress

## Step 2: More Regions, Less Latency

Get all deployed regions receiving real traffic and reduce cross-region latency.

- Switch client to new `api.mentraglass.com` load balancer so US West and US East start receiving traffic
- Set up MongoDB Atlas read replicas in each region so non-cached DB reads hit local replicas instead of crossing the network (80-370ms round-trip today)
- Evaluate additional regions based on user distribution

## Step 3: Performance

Improve how much work a single instance can handle before it degrades.

- Profile per-session memory footprint (never measured)
- Lazy-initialize managers (15+ managers instantiated per session, most idle)
- Multi-core utilization (Bun is single-threaded today, explore worker threads or clustering)
- Reduce per-request MongoDB blocking (app cache handles the hot path, read replicas handle the rest)
- Load test to find the per-instance capacity ceiling

## Step 4: Horizontal Scaling

The core architectural change. Today, everything for one user must be on one instance. The refactor breaks this apart so instances within a region can share load.

### What stays sticky

**User session.** A user's phone WebSocket and REST requests use session affinity (HTTP headers) to always hit the same instance. That instance owns the user's session state. This is straightforward.

**App session.** Each MiniApp's WebSocket and REST requests also use session affinity to hit a consistent instance. That instance owns that app session's state.

### What changes

**User sessions and app sessions no longer need to be on the same instance.** A user could be on instance 1, their captions app session on instance 2, and their notes app session on instance 3. All within the same region.

An eventing layer (Redis pub/sub or similar) bridges them. The instance that owns the user session publishes events (transcription, display updates, device state). The instance(s) that own the app sessions subscribe to what they need.

### The hard parts

**UDP audio.** UDP goes through a separate load balancer and doesn't carry HTTP headers, so session affinity doesn't work the same way. Options:

- A separate microservice that receives all UDP audio, handles transcription, and publishes results to the eventing layer. Decoupled from the user session instance entirely.
- UDP packets tagged with a session identifier that the load balancer can route on.
- Needs more design work.

**Audio fan-out to MiniApps.** Most MiniApps only subscribe to JSON events (transcription text, display commands, device state changes). These are small and fan out easily through Redis pub/sub. But some MiniApps subscribe to raw audio chunks. If the MiniApp session is on a different instance than the user, those audio chunks need to get there. Options:

- The UDP microservice fans audio directly to subscribing instances.
- A binary pub/sub channel alongside the JSON event channel.
- Needs more design work.

**SDK v3 reconnection is a prerequisite.** You can't safely add/remove instances or move sessions between them unless the SDK can survive a transport blip without losing state. The reconnection architecture in SDK v3 (TRANSPORT_DOWN state, RECONNECT message, session preservation) makes this possible.

## What Still Needs to Be Figured Out

- Per-session memory footprint (never profiled)
- Per-instance capacity ceiling (never load tested)
- Multi-core strategy (worker threads? Bun clustering? separate processes behind a local LB?)
- Redis schema for session state and event routing
- UDP load balancer routing mechanism (how to get audio packets to the right place without HTTP headers)
- Binary data fan-out strategy for MiniApps subscribing to audio
- Graceful drain during instance scaling events
- Whether the UDP/transcription microservice is the right split point or if there's a better boundary
