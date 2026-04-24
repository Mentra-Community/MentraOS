# Spike: Cloud Pod Event-Loop Stall Cascade (us-central)

## Overview

**What this doc covers:** Investigation of recurring SIGKILL crashes on the us-central cloud pod. The pod is crashing daily with exit code 137. Direct gap-detector evidence shows 40-80 second event-loop blockages preceding each kill. Cumulative `op_audioProcessing_ms` accounts for ~99% of the blocked sync time, but **we have not yet proven what initiates the stall**, and three different mechanisms are equally compatible with the data.

**Why this doc exists:** Multiple prior investigations (BetterStack AI SRE, internal triage) reached confident-but-wrong conclusions: "MongoDB query slowness," "readiness probe timeout from Mongo saturation," "reconnect storm trigger." All three were falsified by direct examination of source + telemetry. This spike captures what we actually know, what we falsified, and why the next step must be instrumentation rather than speculative fix.

**Why we are fixing this on a single pod, not horizontally scaling first:** us-central runs a single pod handling 60+ sessions. Other regions handle 7-18 sessions per pod and are stable. The eventual fix is multi-pod (covered by the cloud scaling plan), but it is blocked today by these single-pod assumptions in the architecture:

- A user's glasses WebSocket lands on a specific pod (Cloudflare LB hash)
- The mini-app webhook lands an SDK WebSocket which must reach the same pod (in-memory `UserSession` map)
- UDP audio register binds session to a specific pod's UDP server
- No Redis, no shared session store, no pod-to-pod routing
- Photo response REST calls must reach the pod with the originating session in `pendingPhotoRequests`

Multi-pod requires Redis (or equivalent) for cross-pod session lookup, a UDP routing layer, and sticky LB. That work belongs to the cloud scaling plan and is a multi-week project. **We need single-pod us-central to stop crashing before the scaling plan lands.** This spike is for what we can do in the meantime — single-pod stabilization.

**Who should read this:** Cloud + SRE engineers triaging us-central crashes. Anyone considering "the obvious fix" to know what's been ruled out.

**Depends on:**

- Direct evidence from BetterStack `system-vitals`, `event-loop-gap`, `slow-query`, `gc-probe` features
- Porter kubectl describe output for the affected pod

---

## The Pattern in 30 Seconds

us-central pod crashes daily:

- Exit code 137 (SIGKILL)
- Container Reason: "Error" (not OOMKilled)
- Container memory limit 4096MB; pod RSS at death usually 800-1010MB (well under limit)
- Last logs before death: 0-1 ms 200 OK responses (pod is responsive _just before_ the kill)
- No SIGTERM-handler log line emitted before SIGKILL
- Other regions (east-asia, france, us-west, us-east) are stable for days/weeks

Direct gap-detector log from the most recent crash (2026-04-23 19:48 UTC):

```
event-loop-gap: 80,497ms (expected 1000ms, actual 81,497ms)
```

This is ground truth: the JS event loop was blocked for 80.5 seconds before the kill.

---

## What We Proved

### 1. The event loop was demonstrably blocked

`SystemVitalsLogger`'s gap detector ([SystemVitalsLogger.ts:163-185](../../packages/cloud/src/services/metrics/SystemVitalsLogger.ts#L163-L185)) is a 1-second `setInterval` that logs when its tick takes >2 seconds. For the 19:48 crash it logged a single gap of 80,497ms. Multiple independent signals confirm the same blockage:

- **Vitals callback fired 63 seconds late** (last normal sample 19:47:12, next at 19:48:45 — should have been 19:47:42)
- **Log volume cratered then burst**: 1,716 logs/30s (normal) → 59 logs/30s (during blockage, pino async-buffered) → 2,605 logs/30s (drain after recovery)
- **8 Mongo queries each timed at 81,371-81,566 ms within the same second** — impossible unless their callbacks were queued behind the blockage and all fired together when it cleared

### 2. The 75-second K8s threshold determines kill vs survive

K8s liveness config: `timeout=3s period=5s failureThreshold=15`. To trigger kill: 15 consecutive failed probes = ~75 seconds of sustained blockage.

Looking at peak `op_audioProcessing_ms` bursts on the prior pod (lived 4h56m):

- 17:12: 39,334 ms cascade — survived (only ~40s of blockage, 8 probes failed, under threshold)
- 17:31: 8,377 ms — survived
- 17:36: 1,844 ms — survived
- 18:26: ~80s+ blockage — killed

These cascades happen 3-4 times per pod life. Whether they cause death is largely determined by whether the blockage exceeds 75 seconds — which appears to be a coin-flip on the cascade's amplification factor.

### 3. Cumulative measured sync time was in the audio path

For the 19:48 blockage window, op_total breakdown:

```
op_audioProcessing:  80,114 ms    (99.96% of total)
op_glassesMessage:        7 ms
op_appMessage:           18 ms
op_displayRendering:     11 ms
opTotalMs:           80,150 ms
```

The `addTiming("audioProcessing")` call wraps the synchronous portion of `UdpAudioServer.handleAudioPacket`'s for-loop over `packetsToProcess` ([UdpAudioServer.ts:259-278](../../packages/cloud/src/services/udp/UdpAudioServer.ts#L259-L278)). Because `processAudioData` is `async` but called without await, the sync portion of each call (which for PCM is the entire body) executes inline on the caller's stack.

So 80 seconds of sync wall-time during the blockage can be attributed to code reachable through this for loop. **What we cannot determine from the timer alone is whether the 80s came from many small calls (cascade), one giant call (pathological bug), or a fan-out blowup in `relayAudioToApps`.**

---

## What We Falsified

### Falsified hypothesis 1: "MongoDB slow queries caused the 503"

Origin: BetterStack AI SRE tool's first analysis.

**What was wrong:**

- `/health` endpoint does NOT touch MongoDB. [hono-app.ts:222-276](../../packages/cloud/src/hono-app.ts#L222-L276) only reads in-memory session map + `process.memoryUsage()`. So Mongo slowness cannot cause `/health` to return 503.
- The 8 slow queries each timed at ~81,500ms were **callbacks waiting for the blocked event loop to fire them**, not Mongo being slow. Atlas had answered; the JS runtime couldn't process the response.

### Falsified hypothesis 2: "Readiness probe times out because /health is heavy"

Origin: BetterStack AI SRE tool's revised analysis.

**What was wrong:**

- `/health` is in-process and emits a `health-timing` log only when duration exceeds 50ms. **Zero `health-timing` entries** appeared in the 30-min window around the incident. `/health` was always fast when invocable.
- The pod was serving 0-1 ms responses (including the BetterStack uptime probe itself hitting `/favicon.ico`) within 4 seconds of SIGKILL. This is not a "probe timeout" pattern — it's "pod was alive and responsive, then suddenly killed."

### Falsified hypothesis 3: "GC pauses from heap growth blocked the loop"

Origin: my first internal hypothesis.

**What was wrong:**

- gc-probe (forced full-GC, sync, measured wall-clock pause) returned 165-184 ms across the entire pre-crash window. That is not enough to fail a 3-second liveness timeout, let alone 15 consecutive ones.
- Heap did grow (117 → 739 MB over 4.9 hours on the prior pod) but the actual GC pause durations did not.

Caveat: we only measure **forced** GC duration. Natural major GCs (V8's "MarkCompact" on heap pressure) might be longer. We have no instrumentation for natural GC duration. Hypothesis is unsupported but not strictly disproved.

### Falsified hypothesis 4: "Reconnect storm from one user triggers the cascade"

Origin: my second internal hypothesis after seeing `Glasses reconnect #4850` in the pre-crash logs.

**What was wrong:**

- Reconnect counter is **cumulative across the session's life**, not a current rate.
- Per-30s reconnect rate for the 7 minutes before the 19:48 crash was flat at 35-40 (≈80/min). It was actually slightly _declining_ (32 at 19:47:00) when the blockage began at 19:47:24.
- The system was handling that reconnect rate cleanly for a long time. There was no spike correlating with crash onset.

The reconnect rate **is** chronically elevated (single users at #4850 reconnects exposes a real client bug, see issue 101) but it is background load, not a per-event trigger.

---

## What We Don't Know

**The trigger.** What blocks the event loop initially? The audio bucket accounts for 99% of the _measured_ time during the blockage, but that measurement starts _after_ something already paused the loop long enough for backlog to build. Candidates we cannot distinguish without further instrumentation:

1. **Natural V8 major GC.** Heap was 533 MB at 19:47:12. A MarkCompact at that size could take several seconds. We don't measure natural GCs.
2. **`logVitals()` itself.** Vitals callback fires every 30 seconds and iterates all sessions, calling `session.getMemoryCensus()` which walks several owner maps per session. If that iteration takes seconds at peak session count, it IS the trigger and the audio cascade is just downstream amplification. (The largest historical owner — `transcription.history` — was removed by issue 098 on dev; this hypothesis is about whatever else the census walks today, not about that specific map.)
3. **`relayAudioToApps` fan-out** ([AudioManager.ts:353-389](../../packages/cloud/src/services/session/AudioManager.ts#L353-L389)). Per audio packet, iterates subscribed apps and calls `connection.send(audioData)` synchronously. If sub count grew unbounded for some session, a single packet could trigger N synchronous WS sends.
4. **A specific pathological audio packet.** LC3 decode edge case, buffer alignment edge case, etc.
5. **Mongo connection pool exhaustion.** During the blockage we saw 8 queries waiting for the same ~81,500ms — could indicate pool was already saturated when the blockage started.
6. **Kernel/Azure-VM-level event.** I/O throttling, CPU steal, page reclaim. Hard to verify without node-level metrics.

The amplifier mechanism is also unconfirmed:

- **A. High-volume cascade.** Many UDP packets queue in kernel buffer during initial pause; loop drains them sequentially; drain takes longer than incoming rate; cascade. UDP backpressure (drop packets when behind) would fix this.
- **B. Pathological single call.** One `processAudioData` call entered some bug and took 80 seconds. Backpressure wouldn't help; need to find the bug.
- **C. Fan-out blowup.** `relayAudioToApps` iterating an unbounded subscriber list. Cap subscribers per session.

The op_audioProcessing timer alone cannot distinguish A, B, or C. They all produce the same aggregate measurement.

---

## Why Confident-Wrong Diagnoses Keep Happening

Three independent investigations confidently identified different "root causes" and proposed three different fixes, all of which were wrong on inspection. The shared failure mode:

1. The op_total / op_audioProcessing / mongoBlockingMs telemetry **measures cumulative wall-time, not work**. When the loop is blocked, the next available log/measurement attributes the blockage to whichever bucket the next-completed operation lives in. It's easy to misread "audio bucket has 80s" as "audio is the cause" when it might be "audio is what was running when the loop unblocked."

2. The pod **was responsive** in the moments immediately before SIGKILL (1ms response times). It is counterintuitive that an apparently-healthy pod was killed; this leads investigators to look for something happening _at the moment of death_ rather than ~80 seconds prior.

3. The Mongo callback storm during loop recovery looks identical in BetterStack's UI to a real Mongo slowdown. Both show "many slow queries clustered in a small time window." Distinguishing requires reading the application source to know that `/health` doesn't query Mongo.

The lesson: **stop reasoning from telemetry alone.** We need to instrument the actual code path with a measurement that disambiguates trigger vs amplifier, before designing any fix.

---

## Relationship to Multi-Pod (Cloud Scaling Plan)

Multi-pod is the eventual fix and is covered by the separate cloud scaling plan. It is the right long-term answer: each pod carries a fraction of session load, no single pod approaches the cascade threshold, regional capacity scales horizontally with demand.

Multi-pod is blocked today by the single-pod assumptions catalogued earlier in this spike (in-memory `UserSession` map, UDP server binding, photo-response routing, no shared session store). The scaling plan addresses these via Redis-backed session registry, a UDP routing layer, and sticky LB. That work is multi-week.

**This issue exists because we cannot wait for multi-pod to stop the crashes.** us-central is crashing daily right now. Single-pod stabilization needs to land first; multi-pod lands after.

Vertical scaling (more CPU/memory for us-central) is a separate option that doesn't conflict with this work. It buys headroom but doesn't address the cascade mechanism. Worth doing in parallel as a defensive measure, but not a substitute for fixing the cascade itself.

---

## Recommendation

Do **not** ship a speculative fix for the cascade. Three prior diagnoses were wrong; the fourth would also likely be wrong without disambiguating data.

Ship a small, targeted observability PR (~50 lines, no behavior change) and let one more crash cycle answer the trigger-vs-amplifier question definitively. See [spec.md](./spec.md) and [design.md](./design.md).

Then, with data in hand, design the actual fix.

---

## Evidence Index

For anyone re-running this investigation:

```bash
# Direct event-loop-gap log for the 19:48 crash
bstack sql "SELECT dt, JSONExtract(raw,'gapMs','Nullable(Float64)') as gap_ms, JSONExtract(raw,'rssMB','Nullable(Float64)') as rss FROM s3Cluster(primary, t373499_mentracloud_prod_s3) WHERE _row_type=1 AND dt >= '2026-04-23 19:00:00' AND dt <= '2026-04-23 20:00:00' AND JSONExtract(raw,'feature','Nullable(String)')='event-loop-gap' AND JSONExtract(raw,'region','Nullable(String)')='us-central'"

# Pod restart timeline (us-central, 44 hours)
bstack sql "SELECT toStartOfInterval(dt, INTERVAL 1 HOUR) as hour, count() as restarts FROM (SELECT dt, JSONExtract(raw,'uptimeSeconds','Nullable(Int32)') as up FROM s3Cluster(primary, t373499_mentracloud_prod_s3) WHERE _row_type=1 AND dt >= '2026-04-22 00:00:00' AND dt <= '2026-04-23 20:00:00' AND JSONExtract(raw,'feature','Nullable(String)')='system-vitals' AND JSONExtract(raw,'region','Nullable(String)')='us-central' AND up < 60) GROUP BY hour ORDER BY hour"

# Reconnect rate per 30s before crash (proves no spike)
bstack sql "SELECT toStartOfInterval(dt, INTERVAL 30 SECOND) as bucket, countIf(JSONExtract(raw,'message','Nullable(String)') LIKE '%Glasses reconnect #%') as reconnects FROM s3Cluster(primary, t373499_mentracloud_prod_s3) WHERE _row_type=1 AND dt >= '2026-04-23 19:40:00' AND dt <= '2026-04-23 19:50:00' AND JSONExtract(raw,'region','Nullable(String)')='us-central' GROUP BY bucket ORDER BY bucket"

# Pod kill state (verify exit 137, Reason)
porter kubectl --cluster 4689 -- describe pod -n default -l "app.kubernetes.io/name=cloud-prod-cloud" | grep -A8 "Last State"
```
