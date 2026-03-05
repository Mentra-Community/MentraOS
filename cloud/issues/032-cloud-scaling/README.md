# 032 — Cloud Scaling

How many concurrent users can one cloud instance handle, and how do we scale beyond that?

## Context

We're shipping ~1,000 glasses to customers soon. Current US Central production serves ~35 concurrent users. We need to understand our capacity ceiling and have a plan before we hit it.

This issue captures what we know, what we don't know, what we need to measure, and the possible directions for scaling.

---

## How the Cloud Works Today

The MentraOS Cloud is a single Bun process that acts as the hub between phones (with connected glasses) and mini apps (third-party app servers built with the SDK).

A `UserSession` is created in-memory when a phone connects. It lives in a static `Map<userId, UserSession>` inside the process. **All traffic for a given user must reach the same process:**

| Traffic Type           | Source → Cloud                                                   | Why It's Pinned                                                       |
| ---------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Glasses WebSocket**  | Phone → `/glasses-ws`                                            | `UserSession` lives in a static in-memory Map                         |
| **UDP Audio**          | Phone → `:8000` UDP                                              | `UdpAudioServer` has an in-memory `Map<userIdHash, UserSession>`      |
| **REST API**           | Phone → Hono HTTP routes                                         | Many routes call `UserSession.getById(userId)` from the in-memory Map |
| **Mini App WebSocket** | Mini app server → `/app-ws`                                      | `AppSession` is wired into the `UserSession.appManager` in-memory     |
| **Outbound Webhooks**  | Cloud → mini app HTTP, then mini app connects back via `/app-ws` | The returning WS must find the `UserSession` that sent the webhook    |

Today there is one pod, one process, one instance. Everything lands in the same place by default.

### Data flow

```
Glasses ←BLE→ Phone ──WebSocket──→ Cloud Instance ──WebSocket──→ Mini App Server(s)
                      ──UDP:8000──→ (same instance)
                      ──REST/HTTP─→ (same instance)
                                    ──HTTP webhook──→ Mini App Server
                                    ←──WebSocket────← Mini App Server (connects back)
```

The cloud isn't a dumb relay. It sits between the phone and mini apps as an orchestration layer:

- Receives audio → processes/transcribes → fans out transcription events to subscribed mini apps
- Receives display updates from mini apps → resolves conflicts via DisplayManager → sends result to phone
- Manages subscriptions — knows which mini apps want which data streams
- Manages mini app lifecycle — webhooks, connection state, grace periods, resurrection

---

## The Bun Event Loop

### What it is

Bun (like Node.js) runs all JavaScript/TypeScript on a **single thread** using an **event loop**. The event loop is a continuous cycle:

1. Check for pending I/O (incoming WebSocket messages, UDP packets, HTTP requests, timer callbacks)
2. Run the JavaScript handler for each ready event (parse JSON, look up session, send response)
3. Go back to step 1

All of our code — every WebSocket message handler, every UDP packet parser, every REST endpoint, every timer callback (heartbeats, grace periods) — runs on this one thread, one event at a time. While one handler is executing, everything else waits.

### Why this matters for scaling

**This single thread can use at most 1 CPU core.** It doesn't matter if the pod has 5 cores, 10 cores, or 100 cores allocated. The JavaScript execution is bound to 1 core.

Things that do use additional cores (but are minor):

- Bun's internal thread pool for TLS, DNS, crypto, file I/O
- The Go LiveKit bridge process (separate process, runs alongside Bun)
- Garbage collection (background threads)
- OS kernel networking (TCP/UDP socket I/O)

These are real but marginal. The bottleneck is the JS event loop thread.

### What this means for vertical scaling

| Resource                   | Helps? | Why                                                                                              |
| -------------------------- | ------ | ------------------------------------------------------------------------------------------------ |
| **More CPU cores**         | ❌ No  | JS event loop maxes at 1 core. Extra cores sit idle.                                             |
| **More RAM**               | ✅ Yes | More UserSession objects, audio buffers, WebSocket connection state. Scales linearly with users. |
| **More network bandwidth** | ✅ Yes | Bigger instance types have better NIC throughput. Matters with many users streaming audio.       |

**Adding more CPU to the current architecture does not increase user capacity.**

### When is the event loop "full"?

The event loop processes events as fast as it can. When there's more work than one core can handle:

- Events queue up waiting to be processed
- Latency increases (a WebSocket message sits in the queue before its handler runs)
- Eventually things start timing out, connections drop, audio gaps appear

The key metric is **event loop lag** — how long an event waits before being processed. Low lag = healthy. Rising lag = approaching capacity. We don't measure this today.

---

## What We Don't Know

### Per-user CPU cost

Porter shows ~0.7 cores with 35 users on prod, ~0.45 cores on dev with very few users. That suggests a large baseline cost independent of user count. But we can't decompose it — we don't know how much is baseline overhead vs per-user work.

### Event loop saturation

We have no measurement of event loop lag. We don't know if we're at 10% utilization (massive headroom) or 80% (about to fall over).

### Where event loop time is spent

Is the bottleneck UDP packet handling? WebSocket fan-out to mini apps? Heartbeat timers? JSON serialization? We have no per-operation profiling.

### Per-user memory cost

The `MemoryTelemetryService` exists and tracks per-session stats (audio buffers, transcription state, running mini apps) but is **disabled in production** (`MEMORY_TELEMETRY_ENABLED` env var not set).

### Concurrency ratio

1,000 shipped glasses ≠ 1,000 concurrent users. What percentage are active simultaneously? 10%? 20%? 50%? This determines whether we need capacity for 100 or 500 users.

---

## How We Find Out

### Step 1: Instrument the cloud

Add lightweight metrics to answer the unknowns above. Expose them in three places:

1. **Prometheus `/metrics` endpoint** — Porter scrapes this and graphs it in the Metrics dashboard tab alongside CPU/memory/network. This also enables custom autoscaling (see below).
2. **Enhanced `/health` endpoint** — JSON snapshot for polling during load tests and quick checks.
3. **Better Stack** — structured log lines (already using Pino → Better Stack). Use for alerting and historical analysis.

**Metrics exposed (Prometheus gauges/counters on `/metrics`):**

| Metric                                                    | Type    | Description                                                                                     |
| --------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------- |
| **Sessions**                                              |         |                                                                                                 |
| `mentra_user_sessions`                                    | Gauge   | Current number of connected UserSessions                                                        |
| `mentra_miniapp_sessions`                                 | Gauge   | Current number of mini app sessions                                                             |
| **Event Loop**                                            |         |                                                                                                 |
| `mentra_event_loop_lag_ms`                                | Gauge   | Event loop lag — current sample via `setTimeout(fn, 0)`. The single best indicator of overload. |
| `mentra_event_loop_lag_avg_ms`                            | Gauge   | Event loop lag rolling average (~5 min window, 150 samples × 2s)                                |
| `mentra_event_loop_lag_p99_ms`                            | Gauge   | Event loop lag p99 over the rolling window                                                      |
| **UDP**                                                   |         |                                                                                                 |
| `mentra_udp_packets_received_total`                       | Counter | UDP audio packets received                                                                      |
| `mentra_udp_packets_dropped_total`                        | Counter | UDP packets dropped (no session found)                                                          |
| `mentra_udp_pings_received_total`                         | Counter | UDP ping packets received                                                                       |
| `mentra_udp_packets_decrypted_total`                      | Counter | UDP packets successfully decrypted                                                              |
| `mentra_udp_decryption_failures_total`                    | Counter | UDP decryption failures                                                                         |
| `mentra_udp_registered_sessions`                          | Gauge   | UDP sessions currently registered                                                               |
| **WebSocket**                                             |         |                                                                                                 |
| `mentra_ws_client_messages_in_total`                      | Counter | WebSocket messages received from mobile client                                                  |
| `mentra_ws_client_messages_out_total`                     | Counter | WebSocket messages sent to mobile client                                                        |
| `mentra_ws_miniapp_messages_in_total`                     | Counter | WebSocket messages received from mini apps                                                      |
| `mentra_ws_miniapp_messages_out_total`                    | Counter | WebSocket messages sent to mini apps                                                            |
| **HTTP**                                                  |         |                                                                                                 |
| `mentra_http_requests_total{status="2xx\|3xx\|4xx\|5xx"}` | Counter | HTTP requests by status code group                                                              |
| **Memory**                                                |         |                                                                                                 |
| `mentra_heap_used_bytes`                                  | Gauge   | V8 heap used in bytes                                                                           |
| `mentra_heap_total_bytes`                                 | Gauge   | V8 heap total in bytes                                                                          |
| `mentra_rss_bytes`                                        | Gauge   | Resident set size in bytes                                                                      |
| `mentra_external_bytes`                                   | Gauge   | External memory (C++ objects bound to JS)                                                       |
| `mentra_array_buffers_bytes`                              | Gauge   | ArrayBuffers memory in bytes                                                                    |
| **Process**                                               |         |                                                                                                 |
| `mentra_uptime_seconds`                                   | Gauge   | Process uptime in seconds                                                                       |

These show up directly in the Porter Metrics dashboard tab, graphed over time alongside the existing CPU/memory/network charts.

**Enhanced `/health` endpoint:**
Returns the same data as JSON, structured as:

- `eventLoop` — current lag, rolling average, p99, sample count
- `sessions` — user sessions, mini app sessions
- `throughput` — WS client in/out, WS miniapp in/out, HTTP requests by status group
- `udp` — received, dropped, pings, sessions, decrypted, decryption failures
- `memory` — rss, heapTotal, heapUsed, external, arrayBuffers
- `uptime` — process uptime in seconds

**Better Stack alerting:**

- Alert when event loop lag exceeds a threshold (e.g., 50ms)
- Alert when active sessions cross a capacity warning threshold
- Historical trends for capacity planning over weeks/months

**Meaningful autoscaling with Porter:**
Porter can autoscale based on custom Prometheus metrics instead of CPU. This is critical for us — CPU-based autoscaling doesn't work well because our event loop maxes at 1 core while the pod might show low overall CPU. Instead we can autoscale on:

- `mentra_user_sessions` — "when sessions per pod exceeds N, add a pod"
- `mentra_event_loop_lag_ms` — "when event loop lag exceeds Xms, add a pod"

This requires the Prometheus `/metrics` endpoint and enabling metrics scraping in Porter (Advanced tab → Metrics scraping → enable, port 80, path `/metrics`).

**Enable memory telemetry:**

- Set `MEMORY_TELEMETRY_ENABLED=true` on the load test environment
- Tracks per-session audio buffers, transcription state, mini app counts

### Step 1b: Implementation details

> **Status: ✅ Implemented** — all items below are complete and smoke tested on `cloud/cloud-scaling`.

**✅ New: `src/services/metrics/MetricsService.ts`**

Singleton service that owns all metrics. No external dependencies — just counters, gauges, and Prometheus text output.

- **Gauges** (current values): `activeSessions`, `miniappConnections`
- **Counters** (monotonically increasing): `wsClientMessagesIn/Out`, `wsMiniappMessagesIn/Out`, `httpRequests` by status group (2xx/3xx/4xx/5xx)
- **Event loop lag**: sampled every 2s via `setTimeout(0)` delay measurement, tracks current, rolling average, and p99 over a ~5 min window (150 samples)
- **UDP stats**: pulled lazily from `udpAudioServer.getStats()` — zero coupling to UdpAudioServer
- **Memory**: `process.memoryUsage()` (rss, heapTotal, heapUsed, external, arrayBuffers)
- **Process**: `process.uptime()`

Key methods:

- `incrementClientMessagesIn/Out(amount?)` — called from WS handlers
- `incrementMiniappMessagesIn/Out(amount?)` — called from WS handlers and AppManager
- `incrementHttpRequests(statusCode)` — called from HTTP middleware
- `setUserSessions(count)` / `setMiniappSessions(count)` — set on `/health` and `/metrics` reads
- `toPrometheus(): string` — Prometheus text exposition format
- `toJSON(): object` — structured JSON for `/health`
- `start()` / `stop()` — lifecycle for event loop lag sampling

**✅ New: `src/services/metrics/index.ts`**

Re-exports the singleton.

**✅ Modified: `src/hono-app.ts`**

1. `/metrics` endpoint — returns `metricsService.toPrometheus()` with `content-type: text/plain; version=0.0.4; charset=utf-8`
2. `/health` endpoint — enriched with `metricsService.toJSON()` (sessions counted fresh on each request)
3. HTTP middleware — calls `metricsService.incrementHttpRequests(status)` after `await next()`

**✅ Modified: `src/services/websocket/bun-websocket.ts`**

- `handleGlassesMessage()`: calls `metricsService.incrementClientMessagesIn()` on every inbound message
- `handleGlassesConnectionInit()`: calls `metricsService.incrementClientMessagesOut()` when CONNECTION_ACK is sent
- `handleAppMessage()`: calls `metricsService.incrementMiniappMessagesIn()` on every inbound message

**✅ Modified: `src/services/session/AppManager.ts`**

- `sendMessageToApp()`: calls `metricsService.incrementMiniappMessagesOut()` after successful `websocket.send()`

**✅ Unchanged: `src/services/udp/UdpAudioServer.ts`**

Lazy pull approach — `MetricsService.toPrometheus()` calls `udpAudioServer.getStats()` and includes received, dropped, pings, decrypted, decryptionFailures, and sessions. Zero changes to UdpAudioServer.

**✅ Modified: `src/index.ts`**

- Imports `metricsService` and calls `metricsService.start()` at boot (starts event loop lag sampling)

**✅ Session/connection gauges**

Rather than hooking into UserSession create/dispose, session and miniapp connection counts are computed fresh on each `/health` and `/metrics` request by iterating `UserSession.getAllSessions()` and summing `session.appWebsockets.size`. This avoids race conditions and is accurate on every read.

**⬜ Porter configuration (not yet done):**

After deploying, enable metrics scraping in Porter:

- Advanced tab → Metrics scraping → Enable
- Port: 80
- Path: `/metrics`

This makes all custom metrics appear in the Porter Metrics dashboard and available for custom autoscaling.

### Step 2: Load test

Build a load test to find the per-pod capacity number.

**Environment — fully isolated:**

- Use one of the unused Porter clusters (Canada, US West, or US East)
- Separate MongoDB instance (or separate database name) — no shared state with production
- Deploy cloud-loadtest Porter app with its own UDP LoadBalancer
- Zero risk to production users or data

**Load test mini app:**

- A real mini app built with the SDK, deployed alongside the load test
- Subscribes to transcription, sends display updates back — exercises the full production path
- Configurable: can toggle which features it uses (transcription, audio chunks, display, etc.)
- Start simple: subscribe to transcription, send a `showTextWall` on each transcript

**Load test driver:**

- Simulates N concurrent phone clients
- Each simulated client: authenticates → connects WebSocket → registers UDP → streams fake audio at 25 packets/sec (40ms intervals)
- Ramps up gradually (e.g. 10 users/sec)
- Pre-creates fake test users in the test DB
- Web UI or API to start/stop and configure user count
- Runs as its own Porter service (load generation needs its own resources)

**What we measure during the test:**

- Poll the cloud's `/health` endpoint continuously
- Plot event loop lag, CPU, memory, connection counts, throughput vs user count
- Find the inflection point where event loop lag starts climbing
- Find the breaking point where connections start failing

**This gives us the number:** "one Bun process handles N concurrent users before degradation."

Everything else — which scaling strategy to use, how many pods we need, how much it costs — follows from that number.

---

## Scaling Strategies

Once we have the per-pod capacity number, we choose a strategy. Here are the directions:

### Direction 1: Session Affinity

**Idea:** Keep the code as-is. `UserSession` stays in-memory. Run multiple pods, but make sure all traffic for a given user always reaches the same pod.

**How routing works per traffic type:**

| Traffic            | Affinity mechanism                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------ |
| Glasses WebSocket  | Naturally sticky — TCP connection stays on one pod once established                                          |
| REST API           | nginx cookie or header — phone gets a cookie on first response, nginx routes subsequent requests to same pod |
| Mini App WebSocket | Cloud includes pod-specific WS URL in the webhook payload, mini app connects back to the right pod           |
| UDP Audio          | After phone connects via WS, cloud tells phone which pod-specific UDP endpoint to use                        |

**What Porter gives us:**

- Autoscaling: `porter.yaml` supports `autoscaling` with `minInstances`, `maxInstances`, CPU/memory thresholds — Porter adds/removes pods automatically
- nginx ingress annotations: Porter exposes `ingressAnnotations` which pass through to the nginx Ingress controller. nginx supports cookie-based session affinity via annotations (`nginx.ingress.kubernetes.io/affinity: "cookie"` etc.) — **this needs verification on Porter specifically before relying on it**
- UDP: Porter/nginx does not handle UDP. Requires separate LoadBalancer service (same as today) and custom routing logic

**Capacity:** per-pod capacity × number of pods. Scales linearly. Each user's full session (phone connection + all their mini app connections) lives on one pod, but different users are on different pods.

**Pod failure:** Client reconnects to a new pod, `UserSession.createOrReconnect()` fires, mini apps get restarted via `startPreviouslyRunningApps()`. Brief interruption but the system already handles reconnection.

**Scaling events (pod added/removed):** New users land on new pods naturally via load balancing. If a pod is removed, its users reconnect to surviving pods. No session migration needed.

**Effort:** Infrastructure and routing work. Minimal cloud code changes.

### Direction 2: Decouple via Redis / Pub-Sub

**Idea:** Move session coordination out of in-memory maps into Redis. Any pod can handle any request by looking up state from Redis. `UserSession` and `AppSession` don't need to live on the same instance.

**Architecture:**

```
Phone ──WS──→ Pod A (holds phone WebSocket)
                 │
                 ├── publishes events to Redis pub/sub
                 │
                 ▼
              Redis (in-cluster)
                 │
                 ├──→ Pod B (holds Mini App 1 WebSocket, subscribed to this user's events)
                 ├──→ Pod C (holds Mini App 2 WebSocket)
                 └──→ Pod A (holds Mini App 3 WebSocket, same pod by chance)
```

**Latency concern — not actually a problem:**

- In-cluster Redis round-trip: ~0.1–0.5ms (same VPC, same datacenter)
- Compare to: existing internet round-trip to external mini app servers: 10–100ms+
- Adding 0.5ms of Redis in the middle is noise relative to the latency we already have

**Redis throughput:**

- A single Redis instance handles ~200,000+ ops/sec
- If each concurrent user generates ~50 ops/sec (audio events, transcription fan-out, display updates, subscription checks), that's ~4,000 concurrent users per Redis instance
- Redis Cluster shards across multiple nodes and scales linearly beyond that
- Porter has a one-click Redis add-on for provisioning

**The hard part — engineering effort:**

- `UserSession` is a large object with ~15 managers, timers, WebSocket references, audio buffers
- Need to decide what goes in Redis (session metadata, subscriptions, routing info) vs stays in-memory (WebSocket connections, audio buffers, active timers)
- Every data flow between phone ↔ cloud ↔ mini apps needs to go through the message bus
- Reverse direction is complex: mini app sends display update → needs to reach the DisplayManager on the pod holding the phone connection → gets composited with other mini apps' displays → sent to phone

**Capacity:** Similar per-pod JS throughput to Direction 1 (slightly lower due to Redis overhead per operation). Redis itself scales via Redis Cluster. Theoretically higher ceiling since mini app connections can spread across pods independently of the phone connection.

**Effort:** Significant architecture change. Rethink how every data flow works.

### Direction 3: Hybrid

**Idea:** Start with Direction 1 (session affinity). Get multi-pod working with minimal code changes. Then incrementally move specific state to Redis as needed — e.g., make REST endpoints pod-agnostic by reading from Redis, while keeping the hot path (audio → transcription → mini app fan-out) in-process.

This is probably the most pragmatic path:

- Direction 1 unblocks horizontal scaling quickly
- Direction 2 improvements can be adopted incrementally where they matter
- We don't over-engineer before we know our actual bottlenecks

---

## Summary

| What                                | Status                                                              |
| ----------------------------------- | ------------------------------------------------------------------- |
| Per-pod user capacity               | **Unknown** — need to instrument and load test                      |
| Event loop saturation               | **Unknown** — no metrics exist                                      |
| Can we scale vertically (more CPU)? | **No** — Bun event loop is single-threaded, 1 core max              |
| Can we scale vertically (more RAM)? | **Yes** — more sessions fit in memory                               |
| Can we scale horizontally?          | **Yes, with work** — need session affinity or architecture changes  |
| Which scaling strategy?             | **Decide after load test** — depends on the per-pod capacity number |

## Next Steps

- [x] Instrument the cloud (event loop lag, throughput counters, enhanced `/health`)
- [x] Expose `/metrics` Prometheus endpoint (26 metrics across 6 categories)
- [x] Enrich `/health` endpoint with structured metrics JSON
- [x] Wire WS message counters (glasses + miniapp, inbound + outbound)
- [x] Wire HTTP request counters by status group
- [x] Pull UDP stats from `UdpAudioServer.getStats()` (lazy, zero coupling)
- [x] Event loop lag sampling (current, avg, p99 over ~5 min rolling window)
- [ ] Enable Porter metrics scraping (port 80, path `/metrics`)
- [ ] Configure custom autoscaling on `mentra_user_sessions` / `mentra_event_loop_lag_ms`
- [ ] Set up isolated load test environment on unused Porter cluster
- [ ] Build load test mini app (SDK-based, subscribes to transcription, sends display updates)
- [ ] Build load test driver (simulates N phone clients with WS + UDP)
- [ ] Run load test, find per-pod capacity number
- [ ] Choose scaling strategy based on real data
- [ ] Implement chosen strategy
