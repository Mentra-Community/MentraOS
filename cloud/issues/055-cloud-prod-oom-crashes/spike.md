# Spike: Cloud-Prod Crashes — Liveness Probe Failure from Event Loop Blocking

## Overview

**What this doc covers:** Investigation of repeated cloud-prod crashes on the US Central cluster, initially suspected as OOM kills but confirmed via kubectl events as **liveness probe failures** — the Bun event loop blocks for 75+ seconds, the `/health` endpoint can't respond, and Kubernetes kills the pod with SIGKILL (exit code 137).
**Why this doc exists:** 7 bug reports were filed on March 25 during internal testing. Tracing the 401 error (`5797e32a`) through the code revealed the cloud-prod pod was killed at the exact moment of the failures. Further investigation showed this is NOT memory exhaustion — it's the server becoming unresponsive under load.
**Who should read this:** Cloud engineers, anyone investigating session-related failures, 401/5xx errors, or event loop performance.

---

## Background

The MentraOS cloud runs on Bun (single-threaded event loop). All WebSocket messages, UDP audio processing, HTTP requests, LC3 decoding, Soniox stream management, and timer callbacks run on one thread. If any operation blocks this thread for too long, everything freezes — including the `/health` endpoint that Kubernetes uses to determine if the pod is alive.

Sessions are stored in an in-memory `Map<string, UserSession>`. When the process is killed, every session is lost — no persistence layer. Users must reconnect via WebSocket to create a new session.

---

## The Investigation Path

### Initial hypothesis: OOM (wrong)

Exit code 137 = SIGKILL. We initially assumed this was Kubernetes killing the pod for exceeding the 4096MB memory limit, based on:

- `kubectl describe` showing exit code 137
- Porter metrics showing memory growth over time
- 11 restarts in 16 hours

### Memory profiling ruled out OOM

Using the admin memory endpoint (`GET /api/admin/memory/now`) and `kubectl top`, we tracked memory in real-time:

| Uptime   | Sessions | RSS (process) | kubectl top | Note                         |
| -------- | -------- | ------------- | ----------- | ---------------------------- |
| 10 min   | 36       | 428 MB        | —           | Baseline after restart       |
| 12.5 min | 36       | 456 MB        | —           | +28 MB                       |
| 15 min   | 40       | 438 MB        | —           | GC reclaimed some            |
| 20 min   | 41       | 475 MB        | 423 MiB     | Kubernetes and process agree |
| 23 min   | 41       | 468 MB        | 423 MiB     | Steady state                 |

Growth rate: ~5-10 MB/min at 40 sessions. At that rate, it would take **6+ hours** to hit 4GB. But the pod was crashing in 30-96 minutes.

Porter metrics at crash time showed memory at only **924 MB** — nowhere near the 4096MB limit.

We also confirmed incident processing memory impact is negligible: a single incident spikes ~20MB for ~10 seconds, fully reclaimed by GC.

### The real cause: liveness probe failure

```
$ porter kubectl -- describe pod cloud-prod-cloud-...

Liveness:  http-get /health  delay=15s  timeout=1s  period=5s  #failure=15

Events:
  Warning  Unhealthy  (x192 over 8h)  Liveness probe failed: context deadline exceeded
  Warning  Unhealthy  (x129 over 8h)  Readiness probe failed: context deadline exceeded
  Normal   Killing    (x9 over 8h)    Container failed liveness probe, will be restarted
```

The `/health` endpoint must respond within **1 second**. If it fails **15 consecutive times** (75 seconds of unresponsiveness), Kubernetes sends SIGKILL. This happened **9 times in 8 hours**.

Exit code 137 is SIGKILL — the same code for both OOM kills and liveness probe kills. We assumed OOM, but the kubectl events prove it's liveness.

---

## What We Know

### The kill sequence

```
1. Something blocks the Bun event loop for 75+ seconds
2. /health endpoint can't respond (1s timeout, 15 consecutive failures)
3. Kubernetes sends SIGKILL (exit code 137)
4. All in-memory sessions destroyed
5. Pod restarts, all users reconnect simultaneously
6. CPU spikes to 5 cores (reconnection storm)
7. 5xx/4xx flood (2379 5xx + 1073 4xx in one window)
8. Users experience 401 errors, app state desync, transcription loss
```

### The CPU spike at crash time

Porter metrics show CPU jumping from ~0.5 cores to **5.02 cores** at the crash moment. This is the event loop being pegged — something is consuming all available CPU, which prevents the health endpoint from responding, which triggers the kill.

The CPU spike happens BEFORE the kill, not after. It's not the reconnection storm (that comes after restart). Something running in the normal event loop is saturating the CPU.

### What blocks an event loop for 75+ seconds?

Possible causes on a Bun/Node single-threaded event loop:

1. **Heavy synchronous JSON operations** — `JSON.parse()` or `JSON.stringify()` on a very large payload (e.g., a massive incident log, a huge settings object, a Soniox response with thousands of tokens)
2. **LC3 WASM synchronous decoding** — `lc3_decode()` is called synchronously for every audio chunk. Under heavy load with many concurrent sessions, the decode calls queue up and block the event loop
3. **V8 garbage collection** — if the heap grows large enough, a major GC pause can block for seconds. At 900MB heap, a full GC could take 1-5 seconds, but not 75 seconds on its own
4. **Synchronous iteration over large data structures** — iterating all sessions, all apps, all transcription segments in a tight loop
5. **Infinite loop or deadlock** — a code bug that enters an infinite loop under specific conditions
6. **Native/WASM code hanging** — the Soniox SDK or LC3 WASM getting stuck in native code that doesn't yield back to the event loop

### What it's NOT

- **Not OOM** — memory was 924MB at crash time, limit is 4096MB
- **Not the incident system** — confirmed via memory profiling that incidents spike 20MB for 10 seconds, fully reclaimed
- **Not a single-request issue** — the event loop is blocked for 75+ seconds, which means it's either a very long synchronous operation or accumulated blocking from many small operations
- **Not multiple pods** — confirmed 1 instance (kubectl, Porter)

---

## Findings

### 1. The liveness probe is correctly identifying an unresponsive server

The probe config (`timeout=1s, period=5s, failureThreshold=15`) gives the server 75 seconds to recover before killing. This is generous — if the event loop is blocked for 75 continuous seconds, the server is genuinely unresponsive and killing it is the right thing to do.

### 2. The crashes correlate with user load, not time

The pod survived 96 minutes in the last run (evening hours, ~40 sessions) but crashed in ~30 minutes during earlier runs (likely higher load). The crash is triggered by what users are doing, not by a time-based leak.

### 3. LC3 decoding is synchronous and per-chunk

Every audio chunk from every session goes through synchronous WASM `lc3_decode()`. With 40+ sessions each sending audio at 60ms intervals, that's 600+ decode calls per second on the single event loop thread. Under heavier load (100+ sessions), this could saturate the CPU and starve the health endpoint.

### 4. All session reconnections happen simultaneously after a crash

When the pod restarts, all ~40+ users reconnect at once. Each reconnection: creates a UserSession, initializes an LC3 WASM instance (`WebAssembly.Memory.grow()`), starts a Soniox stream, starts previously running apps (webhooks), sets up heartbeat intervals, and processes subscription updates. This thundering herd could itself block the event loop long enough to trigger another liveness failure.

### 5. Two latent bugs found during UserSession audit

**Email case mismatch:** WebSocket init uses `payload.email` (raw), REST middleware uses `decoded.email.toLowerCase()`. If a JWT has mixed-case email, session lookup fails. One-line fix: add `.toLowerCase()` to `bun-websocket.ts:88`.

**dispose() doesn't verify map identity:** `UserSession.sessions.delete(this.userId)` deletes by key without checking `sessions.get(this.userId) === this`. A stale session's dispose could delete a newer session's entry. One-line fix: add identity check before delete.

---

## Relationship to User Incidents

| Incident                                              | How the crash caused it                                                                                             |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `5797e32a` — 401 starting captions                    | Server killed at 18:02:57 UTC (confirmed via BetterStack startup banner). Phone REST call hit during/after restart. |
| `2b8ab1d8` — apps not starting, UI desync             | Cloud lost all sessions on kill. Phone still thought apps were running.                                             |
| `e8e10728` / `f41b82b2` — PCM audio not flowing       | Session recreation after crash — mic state not properly re-synced during thundering herd                            |
| `ddf28de9` — Mentra AI unrecoverable after disconnect | App session destroyed by crash, reconnect path overwhelmed                                                          |
| Issue 052 — 30s transcription latency (March 24)      | Possible event loop pressure causing Soniox stream delays before the kill threshold is reached                      |

---

## What We Don't Know

1. **Which specific operation blocks the event loop for 75+ seconds** — is it LC3 decoding accumulation, a single large JSON operation, native WASM code hanging, or something else?
2. **Whether the thundering herd after restart triggers a second immediate crash** — the pod restarted 12 times, some could be cascading
3. **The exact session count and audio throughput at crash time** — our memory telemetry only captures snapshots, not continuous metrics
4. **Whether the Soniox SDK has any synchronous native calls** that could block

---

## Conclusions

| Finding                                                     | Confidence                                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Crashes are from liveness probe failure, not OOM            | **Confirmed** — kubectl events show `failed liveness probe, will be restarted` |
| Event loop blocks for 75+ seconds under load                | **Confirmed** — probe config requires 15 consecutive 1s-timeout failures       |
| CPU spikes to 5 cores at crash time                         | **Confirmed** — Porter metrics                                                 |
| Memory is NOT the constraint (924MB at crash, 4096MB limit) | **Confirmed** — Porter metrics + kubectl top + admin endpoint                  |
| Incident processing is memory-safe                          | **Confirmed** — live profiling showed 20MB spike, fully reclaimed in 10s       |
| JWT coreToken never expires (401 is session loss, not auth) | **Confirmed** — code audit                                                     |
| Email case mismatch in session lookup (latent bug)          | **Confirmed** — code audit                                                     |
| `dispose()` identity check missing (latent bug)             | **Confirmed** — code audit                                                     |

---

## Next Steps (Original)

1. **Identify what blocks the event loop** — add event loop lag monitoring (e.g., `setInterval` that measures drift between expected and actual fire time). Log a warning when lag exceeds 1 second. This will capture what's running when the blockage starts.
2. **Profile LC3 decode throughput** — measure how many `lc3_decode()` calls per second the single thread can sustain. If 40 sessions × 16 chunks/second = 640 calls/sec is near the limit, the decode needs to be moved off the main thread (worker thread or native async).
3. **Add event loop metrics to the `/health` endpoint** — instead of just returning 200, include the current event loop lag. If lag > 500ms, return 503 so Kubernetes can see the server is degrading before it hits the kill threshold.
4. **Consider increasing liveness probe timeout** — `timeout=1s` is aggressive for a server doing WASM decoding. Increasing to 3-5s would reduce false kills, but it's a band-aid.
5. **Investigate thundering herd on restart** — add a connection rate limiter or staggered reconnection to prevent all users from reconnecting simultaneously after a crash.
6. **Fix the two latent bugs** — email case mismatch (one-line) and dispose identity check (one-line). Neither caused the crashes but both are real bugs.
7. **Enable `MEMORY_TELEMETRY_ENABLED=true`** in Porter env so the periodic memory snapshots are logged to BetterStack — gives us historical data without manual polling.

---

## Spike Update: Code Audit Findings

> **Date:** Follow-up code audit after fresh conversation. No code changes were made since original spike.

### Code audit confirmed every finding — and surfaced new ones

We walked the full audio pipeline, health endpoint, session management, LC3 service, and deployment configs. Everything in the original spike holds. Below are the **new or refined** findings.

---

### New Finding 1: `/health` endpoint does unnecessary work on every probe call

The health endpoint (`hono-app.ts` L203–231) iterates **all** active sessions and counts miniapp WebSockets on every single call:

```
app.get("/health", (c) => {
  const activeSessions = UserSession.getAllSessions();
  let miniappCount = 0;
  for (const session of activeSessions) {
    miniappCount += session.appWebsockets.size;
  }
  metricsService.setUserSessions(activeSessions.length);
  metricsService.setMiniappSessions(miniappCount);
  return c.json({ status: "ok", timestamp: new Date().toISOString(), ...metricsService.toJSON() });
});
```

Kubernetes hits this every **5 seconds**. With 40+ sessions, each with multiple app WebSockets, this is a synchronous iteration + JSON serialization + metric gauge update happening on the already-stressed event loop. During the exact moments the loop is saturated (LC3 decoding, reconnection storms), this endpoint is competing for CPU time and making it **harder** to respond within the 1-second timeout.

**Impact:** The probe meant to detect unresponsiveness is itself adding to the problem. A lightweight `/livez` that just returns `200` with no computation would be far more reliable as the liveness target.

---

### New Finding 2: LC3 `decodeAudioChunk` uses `await` but WASM is synchronous

In `AudioManager.ts` L186, the decode call is:

```
const pcmArrayBuffer = await this.lc3Service.decodeAudioChunk(lc3ArrayBuffer);
```

The `await` is misleading. Looking at `lc3.service.ts` L535–546, the underlying decode closure calls WASM exports directly:

```
decode: (frameBytes: number) => {
  (this.instance.exports as any).lc3_decode(
    decoderPtr, framePtr, frameBytes, 0, samplePtr, 1,
  );
},
```

This is a **synchronous WASM call**. The `await` just unwraps a resolved promise — the actual decode blocks the event loop for the full duration. There is no yielding, no worker thread, no async boundary. Every audio chunk from every session runs this synchronous WASM call inline on the main thread.

**Impact:** Under load (40 sessions × ~16 chunks/sec = 640 WASM calls/sec), these synchronous calls accumulate and starve the event loop. This is the strongest candidate for the 75+ second blockages — not a single long operation, but **hundreds of small synchronous WASM calls per second** that collectively prevent the event loop from servicing the health probe.

---

### New Finding 3: Per-session WASM instances with separate memory

Each `UserSession` creates its own `LC3Service` instance (`lc3.service.ts` L21–45), which instantiates a separate `WebAssembly.Instance` with its own `WebAssembly.Memory`. The WASM module is cached statically (`LC3Service.wasmModule`), but each session gets its own instance.

With 40 sessions, that's 40 WASM instances with 40 separate memory allocations. This isn't the crash cause (memory is confirmed fine), but it means:

- V8/JavaScriptCore must manage 40 WASM memory regions
- GC pressure increases linearly with session count
- There's no batching opportunity — each decode is an isolated call into a separate instance

---

### New Finding 4: US-East is under-provisioned

| Environment               | CPU Cores | RAM (MB) |
| ------------------------- | --------- | -------- |
| `porter.yaml` (base)      | 5         | 4096     |
| `porter-us-west.yaml`     | 5         | 4096     |
| `porter-stress.yaml`      | 5         | 4096     |
| **`porter-us-east.yaml`** | **1.5**   | **2048** |

US-East has **70% less CPU** and **50% less RAM** than every other environment. If this is serving production traffic, it will hit event loop saturation at a much lower session count. The crashes documented in this spike at 40 sessions on 5-core would happen at ~12 sessions on 1.5-core.

---

### New Finding 5: No explicit probe config in Porter YAML

None of the four `porter-*.yaml` files for the cloud service define a `healthCheck` block. The probe settings (`timeout=1s, period=5s, failureThreshold=15`) come from Porter/K8s defaults and are **not version-controlled**. If Porter changes its defaults, our probe behavior changes silently.

The RTMP relay (`rtmp_relay/porter.yaml`) and local Docker Compose (`docker-compose.porter.local.yml`) both have explicit health check configs, but the main cloud service does not.

---

### New Finding 6: Both latent bugs confirmed still unfixed

**Email case mismatch** — `bun-websocket.ts` line 90:

```
const userId = payload.email;  // ← still no .toLowerCase()
```

REST middleware uses `decoded.email.toLowerCase()`. Mixed-case JWT emails will create sessions that REST endpoints can't find.

**dispose() identity check** — `UserSession.ts` line 793:

```
UserSession.sessions.delete(this.userId);  // ← still no identity check
```

A stale session's `dispose()` can delete a newer session's map entry. The `handleGlassesClose` handler has a stale-WebSocket guard (line 480–486) that mitigates this in the happy path, but any code path that calls `dispose()` directly (timeout, error handling) bypasses that guard.

---

### New Finding 7: `MEMORY_TELEMETRY_ENABLED` still not set

The `MemoryTelemetryService` (`services/debug/MemoryTelemetryService.ts`) emits snapshots every 10 minutes with per-session stats (audio buffers, VAD, transcripts, mic state, app counts). Two separate investigations (issue 032 and this spike) have recommended enabling it. It's still disabled in all environments. This is the easiest observability win — one env var in Porter.

---

### Full audio pipeline (single-threaded, confirmed)

```
UDP packet (port 8000) or WebSocket binary message
  → UdpAudioServer.handlePacket() — hash lookup, optional decrypt
    → UdpReorderBuffer — sequence reorder (10-slot buffer, 20ms timeout)
      → session.audioManager.processAudioData(chunk, "udp")
        → LC3 WASM decode (SYNCHRONOUS, blocks event loop)
          → PCM16 alignment (carry-over byte logic)
            → TranscriptionManager.feedAudio(buf)
            → TranslationManager.feedAudio(buf)
            → relayAudioToApps() — iterates subscribers, ws.send(audioData)
```

Every step runs on the main thread. No worker threads, no async boundaries (the `await` on LC3 decode is cosmetic). With N sessions sending audio at 60ms intervals, the main thread processes N×16 = N×16 full pipeline traversals per second.

---

### Refined Root Cause Theory

The original spike asked "which specific operation blocks the event loop for 75+ seconds?" The code audit points to **death by a thousand cuts**, not a single blocking operation:

1. **640+ synchronous WASM decode calls/sec** (at 40 sessions) — each one is fast (~0.1–1ms), but they're back-to-back with no yielding
2. **Each decode triggers a synchronous fan-out** — transcription feed, translation feed, app relay (multiple ws.send calls)
3. **The `/health` probe itself** adds synchronous iteration + JSON serialization on every 5-second tick
4. **V8 GC pauses** compound the problem — 40 WASM memory regions + growing heap = longer GC pauses that stack on top of the decode load
5. **At some threshold** (likely 50–80 sessions or a burst of audio from many sessions simultaneously), the accumulated synchronous work per event loop tick exceeds the tick budget, and the loop falls behind — health probes start timing out, and once 15 consecutive failures accumulate, the pod is killed

This is not a cliff — it's a slope. The event loop degrades gradually, and the 75-second kill threshold is the point of no return.

---

## Prioritized Action Items

### P0 — Stop the bleeding (do these first)

1. **Add a lightweight `/livez` endpoint** — return `200` with zero computation. Point the Kubernetes liveness probe at `/livez` instead of `/health`. Keep `/health` for readiness and observability.

   ```
   app.get("/livez", (c) => c.text("ok"));
   ```

2. **Add explicit `healthCheck` config to Porter YAML** — version-control the probe settings. Increase liveness timeout to 3s, point at `/livez`:

   ```yaml
   healthCheck:
     path: /livez
     port: 80
     initialDelaySeconds: 15
     periodSeconds: 5
     timeoutSeconds: 3
     failureThreshold: 15
   ```

3. **Fix both latent bugs** — two one-liners, no risk:
   - `bun-websocket.ts:90`: `const userId = payload.email.toLowerCase();`
   - `UserSession.ts:793`: `if (UserSession.sessions.get(this.userId) === this) { UserSession.sessions.delete(this.userId); }`

4. **Enable `MEMORY_TELEMETRY_ENABLED=true`** in all Porter env blocks — zero code change, just env var.

### P1 — Fix the root cause

5. **Move LC3 decode off the main thread** — use a Bun worker thread (or pool of workers) for WASM decoding. The main thread sends encoded chunks to the worker, the worker decodes and sends PCM back. This is the single biggest change that would eliminate the event loop saturation.

6. **Add event loop lag monitoring** — `setInterval` drift measurement, log warnings at >500ms, emit as a metric to BetterStack. This gives us data on _when_ and _how badly_ the loop degrades before it hits the kill threshold.

7. **Batch LC3 decodes** — instead of decoding each chunk as it arrives, buffer chunks per session and decode in batches on a timer (e.g., every 20ms). This reduces WASM call overhead and allows yielding between batches.

### P2 — Harden

8. **Add reconnection rate limiting / staggered reconnect** — after a crash, clients should use exponential backoff with jitter instead of all reconnecting simultaneously.

9. **Audit US-East provisioning** — 1.5 CPU / 2GB is 70%/50% less than other environments. Either increase resources or ensure it's not serving production traffic.

10. **Separate readiness from liveness** — `/readyz` should check MongoDB, Soniox, and other dependencies. `/livez` should only check "is the process alive." `/health` becomes an observability endpoint, not a probe target.
