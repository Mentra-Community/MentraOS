# Spec: Cloud Observability

## Overview

**What this doc covers:** Exactly what observability we need to add to cloud-prod so that when the server crashes (or starts degrading), we can identify the root cause in minutes instead of days. Covers infrastructure metrics via BetterStack Collector, application-level metrics via OpenTelemetry SDK, event loop and GC diagnostics, heap snapshots, degradation alerting, and deploy/crash distinction.
**Why this doc exists:** We spent 16 hours investigating 75 crashes and still can't definitively answer "what blocks the event loop." We have logs but no metrics. We can see that the server died but not why. Every question we asked during the investigation — is it WASM? is it GC? is it JSON processing? is it memory? — required hours of code auditing and guesswork because we had zero runtime data.
**Who should read this:** Cloud engineers.

## What We Need to See When the Server Crashes

When the next crash happens, we need to answer these questions in under 5 minutes:

| Question                                                                   | What answers it                                                          | Do we have it?                                         |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------ |
| Was the event loop blocked for 75 continuous seconds, or repeatedly slow?  | Event loop lag time-series (sampled every 2s)                            | ❌ Sampled but never logged or exposed                 |
| What was consuming CPU — our code, GC, JIT, or native/WASM?                | CPU profile or at minimum GC pause duration + event loop lag correlation | ❌ Nothing                                             |
| Was heap growing in the minutes before? Sudden spike or gradual?           | Heap used/total time-series                                              | ❌ Only checked when >512MB by TranscriptionManager    |
| How many sessions were active?                                             | Session count time-series                                                | ❌ Only in `/health` response, not logged continuously |
| How many transcription streams, audio chunks/sec, WS messages?             | Per-operation counters                                                   | ❌ Nothing                                             |
| Was there a trigger — bug report filed, reconnection storm, specific user? | Correlated event log + session count + error rate                        | ❌ Requires manual log grepping                        |
| What degraded first — lag, heap, errors?                                   | Time-aligned metrics for all three                                       | ❌ No time-series data exists                          |
| Was this a deploy restart or a crash restart?                              | Deploy annotation in the timeline                                        | ❌ Both look identical                                 |

Every item marked ❌ is what this spec adds.

---

## Part 1: Infrastructure Metrics — BetterStack Collector

### What it is

BetterStack has a Kubernetes collector that installs via Helm chart. It uses eBPF to auto-instrument everything in the cluster. Zero code changes.

### What it gives us

| Metric category          | Examples                                                                     | How it helps                                                                                                                                |
| ------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Host/node metrics**    | CPU utilization, memory usage, disk I/O, network I/O per node                | Shows whether the node itself is under pressure (not just our pod)                                                                          |
| **Pod resource metrics** | CPU/memory per pod, restart count, OOM kills                                 | Continuous pod-level metrics at higher resolution than Porter's 1-min charts. Directly shows crash cycles.                                  |
| **Service RED metrics**  | Request rate, error rate, duration (latency) per service — detected via eBPF | Three of the four Golden Signals (traffic, errors, latency) with zero instrumentation. Shows HTTP request latency degradation before crash. |
| **MongoDB metrics**      | Query latency, connection pool, operations/sec                               | MongoDB is auto-discovered. Shows if slow DB queries are contributing to event loop blocking.                                               |
| **Kubernetes events**    | Pod restarts, scheduling, OOM kills — persisted to BetterStack               | K8s events expire after 1 hour in etcd. The collector persists them. We'd have had the full crash history from day one.                     |
| **Prometheus scraping**  | Scrapes pods with `prometheus.io/scrape: "true"` annotation                  | Our existing `/metrics` endpoint (which nobody scrapes) gets scraped automatically. Those gauges appear in BetterStack dashboards.          |

### What to do

1. Install the BetterStack Collector via Helm on the Porter cluster (cluster ID 4689):

```
helm repo add better-stack https://betterstackhq.github.io/collector-helm-chart
helm repo update
helm install better-stack-collector better-stack/collector \
  --set collector.env.COLLECTOR_SECRET="$COLLECTOR_SECRET"
```

2. Add Prometheus scrape annotations to `porter.yaml` so the collector picks up our existing `/metrics` endpoint:

```yaml
podAnnotations:
  prometheus.io/scrape: "true"
  prometheus.io/path: "/metrics"
  prometheus.io/port: "80"
```

3. Verify in BetterStack: host metrics, pod metrics, service RED metrics, and Prometheus gauges should all appear within minutes.

### What this doesn't give us

eBPF and Prometheus scraping give us infrastructure and basic application gauges, but NOT the detailed application-level metrics we need (event loop lag, heap internals, session-level data, transcription stream counts). That's Part 2.

---

## Part 2: Application Metrics — OpenTelemetry SDK

### Why OpenTelemetry, not just structured logs

During the investigation, we tried to build a BetterStack dashboard from log data. It failed because dashboard charts use `{{source}}` which resolves to the metrics table — and the metrics table is empty because we only send logs.

OpenTelemetry SDK sends proper metrics to BetterStack's OTLP endpoint. They land in the metrics table. Dashboards work natively. No workarounds.

The alternative — "log metrics as JSON and query via ClickHouse" — works for ad-hoc investigation but doesn't give us dashboards, doesn't give us alerting on metric thresholds, and requires writing ClickHouse queries for every question.

### What metrics to emit

#### Event loop health (the #1 gap)

| Metric name                    | Type  | Unit      | Emit frequency | What it tells us                                                                                                                                                                                       |
| ------------------------------ | ----- | --------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cloud.event_loop.lag_ms`      | Gauge | ms        | Every 2s       | How far behind the event loop is RIGHT NOW. Normal: 2-5ms. Degraded: >100ms. Crisis: >1000ms. This is the single metric that would have answered our main question.                                    |
| `cloud.event_loop.lag_p99_ms`  | Gauge | ms        | Every 30s      | p99 lag over the last 30s window. Catches brief spikes that a 2s sample might miss. Use the existing rolling window in MetricsService.                                                                 |
| `cloud.event_loop.utilization` | Gauge | ratio 0-1 | Every 30s      | What fraction of the last 30 seconds the event loop was busy vs idle. >0.8 means the loop is saturated. Bun may not expose this directly — if not, derive from lag samples (lag > threshold = "busy"). |

#### Memory (heap + external)

| Metric name                        | Type  | Unit  | Emit frequency | What it tells us                                                                                                          |
| ---------------------------------- | ----- | ----- | -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `cloud.memory.heap_used_bytes`     | Gauge | bytes | Every 10s      | V8/JSC heap in use. The 512MB TranscriptionManager threshold triggers here. Shows leak progression.                       |
| `cloud.memory.heap_total_bytes`    | Gauge | bytes | Every 10s      | Total heap allocated by the runtime. Growing heap_total means the runtime is requesting more from the OS.                 |
| `cloud.memory.rss_bytes`           | Gauge | bytes | Every 10s      | Resident Set Size — total process memory including heap + WASM + native buffers. This is what K8s uses for OOM decisions. |
| `cloud.memory.external_bytes`      | Gauge | bytes | Every 10s      | Memory held by C++ objects (Buffers, WASM memory). Shows non-heap growth that RSS captures but heapUsed doesn't.          |
| `cloud.memory.array_buffers_bytes` | Gauge | bytes | Every 10s      | ArrayBuffer + SharedArrayBuffer memory. LC3 WASM instances, audio buffers, typed arrays.                                  |

#### Sessions and connections (traffic / capacity)

| Metric name                          | Type  | Unit  | Emit frequency | What it tells us                                                                                                                                                |
| ------------------------------------ | ----- | ----- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud.sessions.active`              | Gauge | count | Every 10s      | Number of entries in the static `UserSession.sessions` Map. The primary load indicator.                                                                         |
| `cloud.sessions.disposed_pending_gc` | Gauge | count | Every 10s      | Sessions that called `dispose()` but haven't been collected by GC (from MemoryLeakDetector). Should be 0 after leak fixes. If not 0, leaks are still happening. |
| `cloud.websockets.glasses`           | Gauge | count | Every 10s      | Active glasses WebSocket connections.                                                                                                                           |
| `cloud.websockets.apps`              | Gauge | count | Every 10s      | Total app WebSocket connections across all sessions.                                                                                                            |
| `cloud.transcription.streams_active` | Gauge | count | Every 10s      | Total open Soniox transcription streams. Expensive resource. Correlates with memory and CPU.                                                                    |
| `cloud.translation.streams_active`   | Gauge | count | Every 10s      | Total open translation streams.                                                                                                                                 |

#### Request performance (latency / errors)

| Metric name                      | Type      | Unit  | What it tells us                                                                                                                                                                   |
| -------------------------------- | --------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud.http.request_duration_ms` | Histogram | ms    | Request latency by endpoint. Tags: `method`, `path`, `status_code`. Shows which endpoints are slow and whether latency is climbing before a crash. p50/p95/p99 from the histogram. |
| `cloud.http.requests_total`      | Counter   | count | Total requests. Tags: `method`, `path`, `status_code`. Gives us request rate (traffic) and error rate (5xx count / total).                                                         |
| `cloud.ws.messages_in_total`     | Counter   | count | WebSocket messages received. Tags: `type` (glasses/app). Shows message throughput.                                                                                                 |
| `cloud.ws.messages_out_total`    | Counter   | count | WebSocket messages sent.                                                                                                                                                           |

#### Audio pipeline

| Metric name                          | Type      | Unit  | What it tells us                                                                                                                                    |
| ------------------------------------ | --------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud.audio.chunks_processed_total` | Counter   | count | Audio chunks processed through AudioManager. Tags: `format` (lc3/pcm), `source` (udp/ws). Shows audio throughput — the main workload of the server. |
| `cloud.audio.decode_duration_ms`     | Histogram | ms    | Time spent in LC3 WASM decode per chunk. Shows if decode is ever slow (we proved it's fast on average, but a histogram catches outliers).           |

#### GC and runtime (if Bun exposes it)

| Metric name                  | Type      | Unit  | What it tells us                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------- | --------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cloud.gc.pause_duration_ms` | Histogram | ms    | Time the GC paused the event loop. **This is the metric that directly answers "is GC blocking the event loop for 75 seconds?"** Bun/JSC may not expose this via standard API. If `performance.measureUserAgentSpecificMemory()` or `PerformanceObserver` GC entries are available in Bun, use them. If not, document that this gap exists and needs Bun-level support. |
| `cloud.gc.collections_total` | Counter   | count | Number of GC runs. Tags: `type` (minor/major). High frequency = memory pressure.                                                                                                                                                                                                                                                                                       |

**Note on GC metrics:** These are the most valuable and the hardest to get. If Bun doesn't expose GC pause timing, we can approximate it: if `event_loop.lag_ms` spikes while heap_used is high and no user code is provably blocking, it's very likely GC. The event loop lag + heap correlation is our proxy for GC visibility.

### How to emit these

**Option A: OpenTelemetry SDK → BetterStack OTLP endpoint (recommended)**

Use `@opentelemetry/sdk-metrics` (which works with Bun's Node.js compatibility) to create a MeterProvider that exports to BetterStack:

```
Endpoint: https://$INGESTING_HOST/v1/metrics
Headers:  Authorization: Bearer $SOURCE_TOKEN
Protocol: OTLP/HTTP with gzip
```

Create an OpenTelemetry source in BetterStack (platform: `open_telemetry`). Use the source token for authentication.

Metrics are batched and exported every 10-30 seconds (configurable). The SDK handles batching, retry, and compression.

**Option B: Prometheus `/metrics` + BetterStack Collector scraping**

Emit all metrics as Prometheus gauges/counters/histograms on the existing `/metrics` endpoint. The BetterStack Collector (Part 1) scrapes them automatically via the pod annotation.

**Tradeoff:** Option A is cleaner (push-based, no dependency on collector scraping interval). Option B reuses existing infrastructure (we already have a `/metrics` endpoint and the collector would already be installed from Part 1). If the collector is installed, Option B is simpler. If not, Option A works standalone.

**Recommendation:** Start with Option B (Prometheus on `/metrics` + collector scraping). It's less code, reuses what exists, and the collector gives us infrastructure metrics too. Add Option A later if we need push-based metrics or finer control over export intervals.

---

## Part 3: Event Loop Lag Warnings

The vitals metrics (Part 2) give us continuous data. But we also want an immediate, loud warning in the logs when the event loop starts degrading. Metrics are polled — logs are immediate.

**What to build:** In the existing `MetricsService.sampleEventLoopLag()`, after updating the current lag value:

```ts
if (lag > 100) {
  logger.warn(
    {
      lagMs: lag,
      heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1048576),
      rssMB: Math.round(process.memoryUsage().rss / 1048576),
      activeSessions: UserSession.sessions.size,
      feature: "event-loop-lag",
    },
    `Event loop lag: ${Math.round(lag)}ms`,
  )
}
```

**Thresholds:**

- **>100ms:** `warn` — something is wrong, event loop is 20-50x slower than normal
- **>1000ms:** `error` — event loop is critically degraded, health probes are likely failing
- **>5000ms:** `error` with additional context — dump active session count, stream count, and `process.memoryUsage()` full snapshot. This is the "about to die" signal.

At 2-second sampling, this generates at most 1 log/2s during degradation, 0 logs when healthy.

---

## Part 4: /health Endpoint Enrichment

Every Kubernetes probe (5s) and every BetterStack Uptime check (60s) hits `/health`. Currently it returns session count and basic metrics. Add runtime diagnostics:

```ts
const memUsage = process.memoryUsage()
return c.json({
  status: "ok",
  timestamp: new Date().toISOString(),
  heapUsedMB: Math.round(memUsage.heapUsed / 1048576),
  heapTotalMB: Math.round(memUsage.heapTotal / 1048576),
  rssMB: Math.round(memUsage.rss / 1048576),
  externalMB: Math.round(memUsage.external / 1048576),
  eventLoopLagMs: metricsService.getCurrentLag(),
  activeSessions: UserSession.sessions.size,
  uptimeSeconds: Math.round(process.uptime()),
  ...metricsService.toJSON(),
})
```

This makes every probe response a diagnostic snapshot. When reviewing a crash, we can see the degradation curve from the `/health` response bodies logged by BetterStack Uptime (they log the response body on keyword checks).

---

## Part 5: /livez and Probe Configuration

### /livez endpoint

```ts
app.get("/livez", (c) => c.text("ok"))
```

Zero computation. If the event loop can return 2 bytes, the process is alive.

### Probe reconfiguration

| Probe         | Target    | Timeout | Period | Failure threshold | Purpose                                                                                                                          |
| ------------- | --------- | ------- | ------ | ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Liveness**  | `/livez`  | **3s**  | 5s     | 15 (= 75s)        | "Is the process alive?" Zero-computation endpoint. 3s timeout instead of 1s — stops brief GC pauses from killing the pod.        |
| **Readiness** | `/health` | 5s      | 10s    | 3                 | "Can this pod serve traffic?" Does real checks (sessions, metrics). If slow, K8s stops routing traffic but doesn't kill the pod. |

The current config uses `/health` for liveness with 1s timeout. That means the health endpoint's own computation (session iteration, metrics update, JSON serialization) competes with the probe timeout. Separating them means the liveness probe never has to do more than return "ok."

---

## Part 6: Heap Snapshot On Demand

When the next memory mystery happens, we need to capture what's retained in memory without redeploying.

**Endpoint:**

```ts
app.get("/api/admin/heap-snapshot", adminAuth, async (c) => {
  const snapshot = Bun.generateHeapSnapshot()
  return c.json(snapshot)
})
```

`Bun.generateHeapSnapshot()` returns a JSON object analyzable in Chrome DevTools (Memory tab → Load). It shows:

- Every object in the heap
- What retains each object (the retainer chain)
- Size of each object

This is how we'd have found the `ManagedStreamingExtension` interval leak in 5 minutes instead of 2 hours of code reading.

**Security:** Admin auth only. Rate limit to 1 per 5 minutes (snapshots are expensive — they pause the runtime briefly).

---

## Part 7: Deploy vs. Crash Distinction

### The problem

BetterStack Uptime has detected 69 incidents since February. We ignored them because deploys produce the same alerts as crashes. Both cause ~4 minutes of `/health` downtime.

### The fix

Slack notifications from the GitHub Actions deploy workflow. Don't reduce monitoring sensitivity — add context.

**Before `porter apply`:**

```
🚀 cloud-prod deploy started (us-central, commit: abc1234)
```

**After health endpoint is reachable:**

```
✅ cloud-prod deploy complete (us-central). Health restored after ~180s.
```

**If health doesn't come back within 10 minutes:**

```
⚠️ cloud-prod deploy: health not restored after 10 min. Commit: abc1234. Investigate.
```

When a BetterStack alert fires:

- **Matching Slack deploy message within 5 min** → deploy restart, expected
- **No matching message** → crash, investigate now

Apply to every region job in `porter-prod.yml`: us-central, east-asia, france, us-west, us-east.

Requires a `SLACK_DEPLOY_WEBHOOK` secret in GitHub pointing to a Slack incoming webhook.

---

## Part 8: Degradation Alerting

### Response-time monitor

Create a second BetterStack Uptime monitor on `prod.augmentos.cloud/health`:

| Setting         | Value                                 | Why                                                                                                                  |
| --------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Type            | HTTP response time                    | Catches slow, not just down                                                                                          |
| URL             | `https://prod.augmentos.cloud/health` | Same endpoint                                                                                                        |
| Alert when      | Response time > 3000ms                | Before the 75-second kill, response times climb: 50ms → 500ms → 2s → 5s → timeout. 3s catches the degradation stage. |
| Confirmation    | 120 seconds                           | Brief GC pauses shouldn't trigger. 2 minutes of sustained >3s means genuine degradation.                             |
| Check frequency | 60 seconds                            | Same as existing monitor                                                                                             |

The existing keyword monitor (ID 3355604) stays at 10-second confirmation for availability. This new one catches degradation with different sensitivity.

### Enable MEMORY_TELEMETRY_ENABLED

Set `MEMORY_TELEMETRY_ENABLED=true` in Porter env for cloud-debug and cloud-prod. Already built, already logs per-session memory breakdowns every 10 minutes. Zero code change.

---

## What This Gives Us For Each Crash Question

| Question from the investigation                        | What answers it now                                                                                                                                                                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "Is it WASM decode?"                                   | `cloud.audio.decode_duration_ms` histogram — see p99. If it's <1ms (which the benchmark proved), it's not WASM. Answered in one chart glance.                                                                                                    |
| "Is it GC?"                                            | `cloud.event_loop.lag_ms` spike + `cloud.memory.heap_used_bytes` high + no user-code blocking visible in request latency = GC. If we get `cloud.gc.pause_duration_ms`, it's a direct answer.                                                     |
| "Is it memory leak?"                                   | `cloud.sessions.disposed_pending_gc` > 0 = sessions leaking. `cloud.memory.heap_used_bytes` growing over time without correlation to session count = leak.                                                                                       |
| "Is it the incident system?"                           | `cloud.http.request_duration_ms` for `/api/incidents` endpoints. If incident processing is slow, we see it in the latency histogram. Plus the system vitals show if heap spikes after an incident is filed.                                      |
| "How many sessions at crash time?"                     | `cloud.sessions.active` — continuous time-series, not a snapshot.                                                                                                                                                                                |
| "Is the event loop blocked for 75 continuous seconds?" | `cloud.event_loop.lag_ms` at 2s resolution shows the exact pattern — continuous block, repeated stalls, or gradual degradation.                                                                                                                  |
| "Did a deploy cause this or was it a crash?"           | Slack deploy annotation present or absent.                                                                                                                                                                                                       |
| "What objects are retained in memory?"                 | `GET /api/admin/heap-snapshot` → Chrome DevTools → retainer chain.                                                                                                                                                                               |
| "Is the server degrading before users notice?"         | BetterStack response-time monitor alerts at >3s sustained — minutes before the liveness kill.                                                                                                                                                    |
| "What was the CPU doing?"                              | BetterStack Collector eBPF RED metrics show per-service CPU time. Combined with event loop lag + heap, we can distinguish: user code (lag high, heap stable), GC (lag high, heap high), or external (lag low, CPU high from background threads). |

---

## Part 9: CPU Profiling & Operation Timing

### The gap

The collector tells us _how much_ CPU cloud-prod uses. It does NOT tell us _what code_ is consuming it. We can see CPU climb from 0.5 → 1.0 → crash, but we can't see whether it's audio processing, display rendering, transcription callbacks, GC, or timer spam that's eating the budget.

Without this, we can't answer: what do we pull into a worker thread? What becomes a microservice? What do we optimize? Why can't we support more than ~50 sessions on one core?

### What a flame graph shows

A CPU flame graph shows every function the CPU executes, how long each takes, and what called it:

```
100% of CPU time (1000ms/sec budget on single thread)
├── ??% handleGlassesMessage → processAudioData → lc3_decode
├── ??% DashboardManager.updateDashboard → generateLayout → JSON.stringify
├── ??% TranscriptionManager → Soniox callback processing
├── ??% relayAudioToApps → ws.send() × N apps per session
├── ??% setInterval callbacks (pings, heartbeats, keepalives)
├── ??% GC (garbage collection pauses)
└── ??% HTTP request handling
```

We proved LC3 WASM is 0.7% via an isolated benchmark. But we don't know the actual production breakdown. DashboardManager could be 30%. GC could be 25%. We have no idea.

### Option A: Lightweight operation timing (add now)

Wrap the major code paths with `performance.now()` and report time spent per category every 30 seconds. This runs in production with negligible overhead.

**Categories to time:**

| Category            | What it wraps                                                           | Why it matters                                            |
| ------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------- |
| `audioProcessing`   | `AudioManager.processAudioData()` — includes LC3 decode + PCM alignment | The main workload. N sessions × 16 chunks/sec.            |
| `transcriptionFeed` | `TranscriptionManager.feedAudio()` + Soniox callback processing         | Feeds audio to Soniox, processes token responses.         |
| `translationFeed`   | `TranslationManager.feedAudio()`                                        | Same for translation streams.                             |
| `displayRendering`  | `DashboardManager.updateDashboard()` + `DisplayManager.sendDisplay()`   | 645K display requests/day — could be a huge CPU consumer. |
| `appRelay`          | `relayAudioToApps()` — iterates subscribers, `ws.send()` each           | N sessions × M apps × 16 chunks/sec of WebSocket sends.   |
| `wsMessageHandling` | `handleGlassesMessage()` + `handleAppMessage()` — JSON.parse + routing  | Every inbound WebSocket message.                          |
| `httpHandling`      | Hono middleware + route handlers                                        | HTTP request/response cycle.                              |
| `timerCallbacks`    | App-level ping, heartbeat, mic keepalive, health checks                 | 28+ callbacks/sec at 40 sessions.                         |

**Implementation:** A simple object that accumulates milliseconds per category, logged every 30 seconds as part of the system vitals:

```ts
// Wrap a hot path:
const t0 = performance.now()
this.audioManager.processAudioData(chunk)
operationTimers.audioProcessing += performance.now() - t0

// Every 30s, log the breakdown:
logger.info(
  {
    feature: "operation-timing",
    audioProcessingMs: operationTimers.audioProcessing,
    displayRenderingMs: operationTimers.displayRendering,
    appRelayMs: operationTimers.appRelay,
    // ... etc
    budgetUsedPct: (totalMs / 30000) * 100, // % of 30-second budget consumed
  },
  "operation-timing",
)
// Reset counters
```

`budgetUsedPct` is the key number. If it's 80%, you're at 80% of the single-threaded event loop capacity. The per-category breakdown shows where the time is going.

**What this answers:**

- "DashboardManager uses 320ms/sec → 32% of the single-threaded budget → candidate for worker thread or optimization"
- "Audio relay uses 180ms/sec → 18% → if we batch ws.send() calls, we could cut this in half"
- "At 50 sessions, budgetUsedPct is 95% → each session costs ~19ms/sec → max capacity is ~52 sessions per core"

### Option B: `perf` flame graphs on demand (use for deep dives)

Linux `perf` works at the OS level and captures native + JS stacks. It's production-safe (2-5% overhead during the capture window) and gives the full flame graph.

```
# Capture 30 seconds of CPU profile from the cloud-prod container
porter kubectl -- exec cloud-prod-cloud-<pod> -- perf record -p 1 -g -- sleep 30
porter kubectl -- cp cloud-prod-cloud-<pod>:/perf.data ./perf.data
# Generate flame graph locally
perf script -i perf.data | stackcollapse-perf.pl | flamegraph.pl > flamegraph.svg
```

Requires `perf` installed in the container (may need a debug sidecar or a custom Dockerfile with `linux-perf` package). Not for this hotfix, but document as the next-level diagnostic when operation timing isn't granular enough.

### Option C: Bun `--inspect` + Chrome DevTools (use on debug env)

Start Bun with `--inspect=0.0.0.0:9229`, port-forward to the pod, connect Chrome DevTools, record a CPU profile. Gives a full flame graph with JS function names.

Not suitable for prod (overhead + security), but perfect for cloud-debug when reproducing issues under simulated load.

### What to add now vs. later

| Approach                            | When                                    | Effort                                                                       |
| ----------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------- |
| **Operation timing (Option A)**     | This hotfix                             | 3-4 hours — wrap ~8 hot paths with `performance.now()`, add to vitals logger |
| **`perf` flame graph (Option B)**   | Next deep dive investigation            | 2-4 hours — add `perf` to Dockerfile, document the capture process           |
| **`--inspect` on debug (Option C)** | Next time we need function-level detail | 30 min — add `--inspect` flag to debug start command, document port-forward  |

---

## Part 10: Ongoing Log Volume Management

### The current situation

Cloud-prod generates **11.3 million logs per day** (after filtering — debug is already suppressed in prod). Non-prod environments (cloud-local, cloud-staging, cloud-dev) add another **10 million logs per day** to the same BetterStack source, for a total of **~21 million logs/day**.

| Server        | Logs/day | Notes                                                                |
| ------------- | -------- | -------------------------------------------------------------------- |
| cloud-prod    | 11.3M    | Debug already filtered, but info-level spam is heavy                 |
| cloud-local   | 7.6M     | Devs running locally — useful for debugging, but same source as prod |
| cloud-staging | 1.9M     | Includes 1.5M debug logs — should match prod log level               |
| cloud-dev     | 463K     | Dev environment                                                      |

### Top volume offenders in prod (March 25)

| Service           | Level                        | Count    | What it's logging                                        |
| ----------------- | ---------------------------- | -------- | -------------------------------------------------------- |
| app-session debug | debug (from apps, not cloud) | 3.2M     | "Format time section" — dashboard app logging            |
| DisplayManager    | info                         | 3.0M     | Every display update for every session                   |
| DeviceManager     | info                         | 2.1M     | Device state updates                                     |
| app-server        | error                        | **886K** | 884K identical "❌ [Session ...-dashboard] Error:"       |
| DashboardManager  | warn                         | 784K     | "Display request not sent — DisplayManager is not ready" |

### What to do

1. **Separate BetterStack source for prod** — `MentraCloud - Prod` (ID 2324289) is created. Point prod and staging Porter env vars at this source. The existing `AugmentOS` source becomes the dev/local dumping ground. No developer `.env` changes needed.

2. **Set staging log level to `info`** — match prod. Eliminates 1.5M debug logs/day from staging.

3. **Fix the 884K identical `app-server` error** — likely same root cause as DashboardManager spam. One error pattern generating nearly a million logs/day.

4. **Evaluate rate-limiting for high-volume log patterns** — DisplayManager (3M/day), DeviceManager (2.1M/day), and DashboardManager (784K/day) could benefit from sampling or deduplication at the pino transport level.

---

## What We Don't Need Right Now

| Tool                                    | Why not yet                                                                                                                                                                                   |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Continuous CPU profiler (Pyroscope)** | The metrics above narrow the cause to a category (GC, user code, native). If we need function-level detail within that category, add Pyroscope then. It's the next tool if this isn't enough. |
| **Distributed tracing**                 | Our service is a monolith. Tracing helps when requests cross service boundaries. We can add OpenTelemetry spans to Soniox API calls later if needed.                                          |
| **Custom Grafana**                      | BetterStack dashboards cover our needs once metrics flow. Grafana is for when we need advanced cross-metric correlation or custom alerting rules.                                             |
| **Chaos engineering**                   | Get basic observability working first. You can't chaos-test what you can't observe.                                                                                                           |

---

## Implementation Summary

| #   | What                                          | How                                                                                      | Effort    | Impact                                                                                                           |
| --- | --------------------------------------------- | ---------------------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------- |
| 1   | BetterStack Collector on K8s                  | `helm install` + pod annotations                                                         | 1 hour    | Infrastructure metrics, MongoDB metrics, Prometheus scraping, K8s event persistence — all with zero code changes |
| 2   | Application metrics via Prometheus `/metrics` | Add gauges/counters/histograms to existing `/metrics` endpoint for all metrics in Part 2 | 4-6 hours | All four Golden Signals as proper metrics in BetterStack dashboards                                              |
| 3   | Event loop lag warnings                       | 20 lines in MetricsService                                                               | 30 min    | Immediate log signal when event loop degrades                                                                    |
| 4   | `/health` enrichment                          | Add 6 fields to existing response                                                        | 15 min    | Every probe becomes a diagnostic snapshot                                                                        |
| 5   | `/livez` + probe reconfig                     | New endpoint + porter.yaml change                                                        | 30 min    | Stops the probe from competing with the event loop                                                               |
| 6   | Heap snapshot endpoint                        | One endpoint calling `Bun.generateHeapSnapshot()`                                        | 30 min    | Next memory investigation takes minutes                                                                          |
| 7   | Deploy annotations                            | Slack webhook in GitHub Actions                                                          | 1-2 hours | Every BetterStack alert becomes actionable                                                                       |
| 8   | Response-time monitor                         | New BetterStack Uptime monitor                                                           | 15 min    | Catches degradation before crash                                                                                 |
| 9   | Enable MEMORY_TELEMETRY_ENABLED               | Porter env var                                                                           | 5 min     | Per-session memory data, zero code                                                                               |
| 10  | Operation timing on hot paths (Part 9)        | Wrap ~8 code paths with `performance.now()`, add to vitals logger                        | 3-4 hours | Answers "what code is consuming the CPU?" — the key question for scaling                                         |
| 11  | Separate prod BetterStack source (Part 10)    | Point prod/staging Porter env at new source token                                        | 30 min    | Clean prod data, no dev noise, enables proper dashboards and alerts                                              |
| 12  | Set staging log level to `info`               | Porter env var                                                                           | 5 min     | Eliminates 1.5M debug logs/day from staging                                                                      |
