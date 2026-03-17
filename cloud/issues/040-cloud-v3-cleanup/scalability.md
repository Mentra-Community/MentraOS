# Cloud v3 — Scalability

> **Status**: Draft
> **Date**: 2025-07-17
> **Related**: [overview.md](./overview.md) · [039-sdk-v3-api-surface](../039-sdk-v3-api-surface/v2-v3-api-map.md)

## What is this doc?

This doc covers scalability concerns in the MentraOS cloud — what happens as the number of concurrent users grows, where the bottlenecks are, and what architectural decisions need to be made to support growth beyond a single server.

## Why it matters

The MentraOS cloud already runs multi-region (US Central, France, East Asia), with each region running as a single-process server. User sessions live in an in-memory `Map`, WebSocket connections are stateful and pinned to the process, and each active transcription user consumes a persistent connection to Soniox. The short-term plan is to add US West and US East clusters alongside US Central. The longer-term goal is horizontal auto-scaling within each region. This doc documents the current constraints, the short-term plan, and what's needed for auto-scaling.

## System context

See [overview.md](./overview.md) for full system architecture. The key scalability-relevant facts:

- **Multi-region already exists** — US Central, France, East Asia. Each region runs independently.
- **Each region is a single Bun process** — all user sessions, WebSocket connections, and transcription streams for that region live in one process
- **Sessions are in-memory** — `UserSession` instances are stored in a static `Map<string, UserSession>`. No external session store.
- **WebSocket connections are stateful** — each user has a persistent WebSocket to the cloud. These connections can't be moved between servers.
- **Each transcription user = one Soniox connection** — persistent WebSocket to Soniox per active transcription stream. Resource-heavy.
- **Mini app communication is HTTP** — stateless webhooks to mini app servers. This scales naturally.

---

## Current Constraints

### 1. In-memory session storage

`UserSession` uses a static `Map`:

```typescript
// In UserSession.ts
private static sessions: Map<string, UserSession> = new Map();
```

Every user session — including all its managers (TranscriptionManager, DisplayManager, AppManager, etc.) — lives in the heap of a single process within a single region.

**Implications:**

- Within a region, can't horizontally scale by adding more instances — sessions are pinned to one process
- If the process crashes, all sessions in that region are lost (users must reconnect)
- Memory usage grows linearly with concurrent users per region
- There's a practical ceiling on how many concurrent users one region/process can handle (depends on per-session memory footprint)

### 2. WebSocket connections are stateful

Each user maintains a persistent WebSocket connection to the cloud. This connection is the pipe for all real-time data: audio chunks, transcription results, display updates, device events.

**Implications:**

- Load balancers need sticky sessions (or route by user ID) to keep WebSocket connections on the same server
- Can't round-robin across servers — user X must always land on the same server where their session lives
- Standard HTTP load balancing doesn't work for WebSocket; needs WebSocket-aware routing
- Cloudflare (current proxy) handles WebSocket forwarding, but adds its own constraints (e.g., absorbing protocol-level ping/pong — see [reliability.md](./reliability.md) §3)

### 3. One Soniox connection per transcription user

Each user with active transcription has a persistent WebSocket to Soniox. Audio is streamed in, transcription results stream back.

**Implications:**

- 1,000 transcription users = 1,000 concurrent WebSocket connections to Soniox from a single server
- Soniox may have connection limits or rate limits per API key
- Each stream consumes memory for audio buffering and state tracking
- If the Soniox connection drops, recovery is per-stream (see [reliability.md](./reliability.md) §4)

### 4. Managers multiply per-session memory

Each `UserSession` instantiates ~15+ managers:

```
AppManager, AudioManager, DashboardManager, DisplayManager,
SubscriptionManager, MicrophoneManager, TranscriptionManager,
TranslationManager, CalendarManager, LocationManager,
PhotoManager, StreamRegistry, UnmanagedStreamingExtension,
ManagedStreamingExtension, LiveKitManager, UserSettingsManager,
SpeakerManager, DeviceManager, UdpAudioManager
```

Even if most managers are idle for a given session, they're all instantiated. The memory footprint per session is the sum of all these objects plus any buffers they maintain (audio buffers, transcript history, etc.).

### 5. MongoDB as the persistent store

User data, app configurations, settings, and storage are in MongoDB. Current usage patterns should be reviewed:

- Are there N+1 query patterns? (The `getInstalledApps` function has a TODO about this: "There's a better way to get list of all apps from MongoDB that doesn't spam DB with fetching one at a time.")
- Are indexes appropriate for the query patterns?
- What's the read/write ratio? Can reads be cached?

### 6. Mini app webhooks are stateless (this is good)

Cloud → mini app communication is HTTP. This scales naturally:

- No persistent connections to maintain
- Can be load-balanced across multiple cloud instances
- Timeout and retry logic is straightforward
- The only concern is webhook latency under load, which is the mini app's problem

---

## Current State: Multi-Region (already running)

MentraOS already runs process-per-region. Each region is an independent single-process deployment:

| Region     | Status                                       |
| ---------- | -------------------------------------------- |
| US Central | ✅ Active                                    |
| France     | ✅ Active                                    |
| East Asia  | ✅ Active                                    |
| US West    | 🔜 Planned (short-term)                      |
| US East    | 🔜 Planned (short-term)                      |
| China      | 🔧 WIP (separate engineer, Alibaba provider) |

Users are routed to their nearest region. Each region runs independently — its own process, its own in-memory sessions, its own Soniox/Alibaba connections.

---

## Short-Term Plan: Add US West + US East

Add two more US regions alongside US Central. This spreads the US user base across three regions, reducing per-region load and improving latency for coast users.

**What's needed:**

- Deploy cloud instances to US West and US East
- Update user-to-region routing to include the new regions
- Ensure Soniox API key/limits support the additional connection sources
- Verify mini app webhooks work across regions (mini app servers may be in a single location — latency to the mini app is the app developer's concern, but cloud should handle webhook timeouts gracefully regardless of region)

This is additive — no architecture changes needed. Same single-process-per-region model.

---

## Longer-Term: Horizontal Auto-Scaling Within Each Region

The current model (one process per region) has a ceiling per region. When a single region's user count outgrows what one process can handle, we need multiple instances within that region.

### Horizontal scaling with sticky sessions

Run multiple cloud instances per region behind a load balancer. Route WebSocket connections by user ID to a specific instance (sticky sessions / consistent hashing).

**Pros:** Scales horizontally within a region. No single instance handles all users.
**Cons:** Sessions are still in-memory per instance. If an instance dies, its users on that instance are lost (must reconnect). Load balancer must be WebSocket-aware.
**Requires:** User ID-based routing at the load balancer level. Session state is isolated per instance (no cross-instance session access needed).

**What makes this feasible:**

- Sessions are already independent — no cross-session dependencies (app-to-app communication is being removed, see [maintainability.md](./maintainability.md) §9)
- Mini app webhooks are HTTP — stateless, work from any instance
- The only state is per-user — as long as a user's WebSocket always lands on the same instance, everything works

**What needs to change for this:**

- WebSocket-aware load balancer configuration (route by user ID or session token)
- Health checks per instance (so the load balancer can drain a dying instance)
- Graceful shutdown — when an instance is scaling down, it should signal connected clients to reconnect (they'll be routed to a remaining instance)
- Auto-scaling triggers — based on concurrent session count, memory usage, or CPU

### Externalized session state (probably not needed)

Move session state to an external store (Redis, etc.). Cloud instances become fully stateless.

**Pros:** Instances are interchangeable. Survives instance failures without reconnection.
**Cons:** Major architectural change. Every manager that holds in-memory state needs to be refactored. Real-time audio streaming through an external store is impractical — streaming data paths would still need affinity.
**Note:** This is likely overkill for MentraOS's scale trajectory. Sticky sessions should be sufficient. Mentioned for completeness.

---

## What to do now

1. **Deploy US West + US East.** Additive, no architecture changes. Spreads US user load.

2. **Measure the per-session memory footprint.** Profile how much memory each `UserSession` + all its managers actually consume. This tells you how many concurrent users one region/process can handle and when you'll need horizontal scaling.

3. **Lazy-initialize managers (open question from 039 Q3).** If most sessions never use camera, streaming, or translation, don't instantiate those managers until first use. Could significantly reduce per-session memory and push the per-region ceiling higher.

4. **Keep sessions independent.** No cross-session dependencies. The app-to-app communication removal (see [maintainability.md](./maintainability.md) §9) already helps — it was the main cross-session feature. This keeps the horizontal scaling path clean.

5. **Monitor per-region.** Track concurrent session count, memory usage, Soniox connection count, and webhook latency per region. Know when a region is approaching its ceiling before it hits it.

---

## Multi-Region Questions (existing deployment)

Multi-region is already running, but some questions remain:

| Question                                | Notes                                                                                                           |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| How is user-to-region routing done?     | DNS-based? User setting? Auto-detect from location? Document the current mechanism.                             |
| Is each region fully independent?       | Separate database per region? Shared MongoDB? Separate Soniox/Alibaba keys?                                     |
| Do mini apps need to deploy per-region? | Or can the cloud in one region call a mini app server in another? (Adds latency but simplifies for developers.) |
| What about user data portability?       | If a user travels from US Central to France, what happens to their session/storage?                             |
| China region specifics                  | Fully separate deployment? Different auth? Separate app ecosystem? (Separate engineer owns this.)               |

---

## Prioritization

### Short-term

| Action                                    | Why                                                                     |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| Deploy US West + US East                  | Spread US load, improve latency for coast users                         |
| Profile per-session memory                | Know the per-region ceiling                                             |
| Track concurrent session count per region | Basic capacity monitoring                                               |
| Remove app-to-app communication           | Eliminates cross-session dependency, clears path for horizontal scaling |

### When a region approaches its ceiling

| Action                                      | Why                                                |
| ------------------------------------------- | -------------------------------------------------- |
| Lazy-initialize managers                    | Reduce per-session memory, push the ceiling higher |
| Vertical scale (bigger instance per region) | Cheapest way to buy headroom                       |

### When vertical scaling isn't enough

| Action                                       | Why                                                   |
| -------------------------------------------- | ----------------------------------------------------- |
| Horizontal auto-scaling with sticky sessions | Multiple instances per region, user-routed            |
| WebSocket-aware load balancer configuration  | Required for sticky sessions                          |
| Graceful instance shutdown / drain           | Users reconnect cleanly during scale-down             |
| Soniox connection pooling / limits           | Manage external resource consumption across instances |

---

## Related docs

- [maintainability.md](./maintainability.md) — app-to-app removal (§9) eliminates the main cross-session dependency
- [reliability.md](./reliability.md) — connection stability (§3) and reconnection behavior matter more with multiple instances
- [observability.md](./observability.md) — monitoring concurrent sessions and memory is the first step to understanding scale limits

---

## Open Questions

| #   | Question                                               | Notes                                                                             |
| --- | ------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Q1  | What's the current per-session memory footprint?       | Need to profile. Determines how many users one region can handle.                 |
| Q2  | What's the Soniox connection limit per API key/region? | Need to check with Soniox. Determines transcription scaling ceiling per region.   |
| Q3  | Lazy-initialize managers?                              | 039 Q3 — saves memory but adds complexity. Worth profiling first.                 |
| Q4  | Current user-to-region routing mechanism               | How are users currently assigned to US Central / France / East Asia? Document it. |
| Q5  | Projected concurrent user count per region?            | Informs when horizontal scaling becomes necessary.                                |
| Q6  | Load balancer for horizontal scaling                   | What load balancer? How to configure sticky sessions for WebSocket?               |
| Q7  | Auto-scaling triggers                                  | What metric triggers scale-up? Concurrent sessions? Memory? CPU?                  |
