# Cloud Scaling — SW Sync

## Why We're Here

We're shipping ~1,000 glasses to customers soon. Right now, US Central production handles ~35 concurrent users on a single cloud instance. We don't know how many users that instance can actually handle before things start breaking — captions lagging, miniapps dropping, connections failing.

We need to figure that out before we hit it.

---

## How the Cloud Works (30 second version)

The MentraOS Cloud is a **single Bun process** that sits between phones and mini apps. When a phone connects, a `UserSession` is created **in memory**. Everything for that user — their WebSocket, UDP audio, miniapp connections, transcription streams — lives in that one process.

```
Glasses ←BLE→ Phone ──WebSocket──→ Cloud Instance ──WebSocket──→ Mini App Server(s)
                      ──UDP Audio─→ (same instance)
                      ──REST/HTTP─→ (same instance)
```

The cloud isn't a dumb relay — it orchestrates audio processing, transcription fan-out, display compositing, miniapp lifecycle, and more.

**Today: one pod, one process, one instance. Everything lands in the same place.**

---

## The Core Constraint

Bun (like Node.js) runs all JavaScript on a **single thread** using an event loop. This means:

- The event loop can use **at most 1 CPU core** — doesn't matter if the pod has 5 or 10 cores
- Adding more CPU **does not** increase user capacity
- Adding more RAM **does** help (more sessions fit in memory)
- When there's more work than one core can handle, events queue up → latency rises → things start failing

| Resource       | Helps? | Why                                              |
| -------------- | ------ | ------------------------------------------------ |
| More CPU cores | ❌ No  | Event loop maxes at 1 core, extra cores sit idle |
| More RAM       | ✅ Yes | More sessions, audio buffers, connection state   |
| More pods      | ✅ Yes | But requires a scaling strategy (see below)      |

---

## What We Don't Know

These are the questions we need to answer:

1. **Per-user CPU cost** — Porter shows ~0.7 cores with 35 users. How much is baseline vs per-user?
2. **Event loop saturation** — Are we at 10% utilization (tons of headroom) or 80% (about to fall over)? We had no way to measure this. Now we do.
3. **Where event loop time is spent** — Is the bottleneck UDP handling? WebSocket fan-out? Transcription? JSON serialization?
4. **Per-user memory cost** — How much RAM does each session actually consume?
5. **Concurrency ratio** — 1,000 shipped glasses ≠ 1,000 concurrent users. What's the real number? 10%? 50%?

---

## What We've Done So Far

**The cloud is now instrumented.** We added lightweight metrics tracking across the whole system — session counts, event loop health, message throughput (WebSocket + UDP), HTTP request rates, memory usage. All exposed via two endpoints:

- `/health` — JSON snapshot with all metrics (for quick checks and load testing)
- `/metrics` — Prometheus format (for Porter dashboards and autoscaling)

This is deployed to the debug environment now. No changes to production yet.

**Also shipped:** Soniox model update from v3-preview → v4 (configurable via env var).

---

## What's Next: Load Test

The goal is simple: **find the number.** How many concurrent users can one pod handle before degradation?

**Plan:**

1. **Isolated environment** — use one of the unused Porter clusters (Canada/US West/US East), separate DB, zero risk to prod
2. **Load test mini app** — a real SDK mini app that subscribes to transcription and sends display updates (exercises the full path)
3. **Load test driver** — simulates N phone clients, each connecting WebSocket + streaming fake UDP audio
4. **Ramp up gradually** — 10 → 50 → 100 → 200 → 500 users, watching metrics the whole time
5. **Find the inflection point** — where event loop lag starts climbing, and the breaking point where connections fail

Everything else — which scaling strategy, how many pods, how much it costs — follows from that number.

---

## Scaling Directions

Once we know the per-pod capacity, we pick a strategy. Three options:

### Direction 1: Session Affinity (simplest)

Keep the code as-is. Run multiple pods. Route all traffic for a given user to the same pod.

- **WebSocket** — naturally sticky (TCP connection stays on one pod)
- **REST** — cookie-based routing via nginx
- **Mini apps** — cloud tells mini app which pod to connect back to
- **UDP** — cloud tells phone which pod-specific UDP endpoint to use

**Pros:** Minimal code changes, fast to ship, scales linearly (capacity = per-pod number × pod count)
**Cons:** Pod failure means those users reconnect (but we already handle reconnection), UDP routing needs custom work

### Direction 2: Redis Pub/Sub (most flexible)

Move session coordination to Redis. Any pod can handle any request by looking up state from Redis.

**Pros:** Any pod handles any request, no routing complexity, higher theoretical ceiling
**Cons:** Significant architecture change — UserSession is a big object with ~15 managers, timers, WebSocket refs. Every data flow needs to go through the message bus.

### Direction 3: Hybrid (recommended starting point)

Start with Direction 1 to unblock horizontal scaling quickly. Then incrementally move specific things to Redis where it makes sense — e.g., make REST endpoints pod-agnostic while keeping the hot path (audio → transcription → miniapp fan-out) in-process.

**Why this is probably right:**

- Direction 1 gets us multi-pod with minimal risk
- We don't over-engineer before we know our actual bottlenecks
- Direction 2 improvements can be adopted incrementally later

---

## Timeline

| Step                                         | Status             | Effort               |
| -------------------------------------------- | ------------------ | -------------------- |
| Instrument cloud (metrics, endpoints)        | ✅ Done            | —                    |
| Soniox v4 model update                       | ✅ Done            | —                    |
| Enable Porter metrics scraping + autoscaling | ⬜ Next            | Small (config)       |
| Build load test environment + driver         | ⬜ Next            | ~1 week              |
| Run load test, find capacity number          | ⬜ Next            | ~1 week              |
| Implement scaling strategy (Direction 1/3)   | ⬜ After load test | TBD based on results |

---

## Discussion

- Does this priority make sense for Q1 given the reliability targets?
- Are there other unknowns we should be measuring?
- Any concerns with the hybrid approach?
- Who else should be involved in the load test?
