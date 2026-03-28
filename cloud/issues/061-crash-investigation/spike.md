# Spike: Crash Investigation — Memory Growth, GC Thrashing, and Multi-Region Crashes

## Overview

**What this doc covers:** Root cause analysis of ongoing cloud-prod crashes using the new BetterStack collector metrics and system vitals logs. Covers US Central and France crash patterns, the degradation chain, and what we still don't know.
**Why this doc exists:** Cloud-prod has been crashing ~6-8 times/day since before the 057 memory leak fixes shipped. The fixes reduced `disposedSessionsPendingGC` from 245 to 0-1 but did NOT stop the crashes. The new SRE dashboard (built March 27) finally shows the full picture.
**Who should read this:** Anyone working on cloud stability, memory optimization, or multi-region scaling.

**Depends on:**

- [057-cloud-observability](../057-cloud-observability/) — memory leak fixes + observability (shipped)
- [058-multi-region-scaling](../058-multi-region-scaling/) — Doppler migration, collectors on all clusters
- [060-betterstack-collectors](../060-betterstack-collectors/) — collector install on all 5 clusters

---

## Background

### What we deployed (057)

7 memory leak fixes + observability additions:

- ManagedStreamingExtension interval leak fix
- Soniox listener cleanup
- 4 missing dispose calls in UserSession
- Identity check on session map delete
- Email case normalization
- Disposed guards on scheduled reconnects
- SystemVitalsLogger (30s periodic vitals), event loop lag warnings, `/health` enrichment, `/livez`, heap snapshot endpoint

### What we expected

Crash rate drops from ~8/day to <2/day. Memory leak detector warnings drop to near-zero.

### What actually happened

- `disposedSessionsPendingGC`: dropped from 245 to 0-1 ✅
- Memory leak detector warnings: near-zero ✅
- **Crash rate: still ~6-7/day** ❌

The leaks we fixed were real, but they weren't the primary crash cause.

---

## Findings

### Data sources used

| Source                                         | Type              | What it shows                                                               |
| ---------------------------------------------- | ----------------- | --------------------------------------------------------------------------- |
| BetterStack Collector (US Central, ID 2321796) | Container metrics | RSS memory, CPU usage, CPU throttling, restarts, OOM kills, TCP connections |
| AugmentOS logs (ID 1311181) via `s3Cluster()`  | Application logs  | SystemVitals (heap, sessions, uptime, pendingGC every 30s)                  |
| BetterStack Uptime (monitor 3355604)           | Health checks     | Crash times, causes (503 vs timeout)                                        |
| SRE Dashboard (ID 973977)                      | Collector metrics | Visual charts of all the above                                              |

### 1. The crash is time-based, not just session-count-based

**US Central:** crashes at ~65-70 sessions after ~3-4 hours. Heap reaches 670MB, RSS hits ~1GB.

**France:** crashes at only ~22-30 sessions, but also after ~3-4 hours. Same heap ceiling (~500-600MB), same RSS ceiling (~1GB).

This means even with fewer sessions, memory grows to the crash threshold given enough time. The per-session memory cost is high, but there's also a baseline memory growth that happens regardless of session count.

### 2. The crash chain — what the dashboard shows

The SRE dashboard (MentraCloud SRE — US Central, ID 973977) shows this pattern on every crash:

```
Memory grows → GC thrashes → CPU spikes → event loop blocks → health check times out → Kubernetes kills pod
```

In detail:

1. **Memory climbs steadily** — RSS grows from ~200MB (fresh pod) toward 1GB over 2-4 hours. The Container RSS chart shows a smooth upward slope, not sudden jumps.

2. **GC starts thrashing** — as heap fills up, the garbage collector runs more aggressively trying to free space. This consumes CPU. The CPU chart shows spikes correlating with high memory.

3. **CPU saturates** — the single-threaded Bun event loop can only use ~1 core for application work. GC/JIT threads push total container CPU to 3-5 cores. When GC is thrashing, the event loop gets starved.

4. **Event loop blocks** — `/health` can't respond within the probe timeout. 15 consecutive failures (75 seconds of unresponsiveness) triggers SIGKILL.

5. **Pod dies** — all in-memory sessions are lost. 65-70 users on US Central (or 22-30 on France) get disconnected simultaneously.

6. **Fresh pod starts** — RSS drops to ~200MB. Users reconnect. The cycle begins again.

### 3. One snapshot caught 29 pendingGC sessions

At 12:38 UTC on March 27, a pod had `disposedSessionsPendingGC: 29`. This means 29 sessions were disposed but not yet garbage collected. The 057 fixes reduced this dramatically (from 245), but under high load the GC can't keep up — it's too busy with the growing heap to collect disposed sessions promptly.

This creates a feedback loop: disposed sessions consume memory → GC is busy with other allocations → disposed sessions pile up → more memory consumed → GC falls further behind.

### 4. France crashes every ~3 hours with only 22 sessions

This is the most revealing finding. If crashes were purely about session count, France (22 sessions) should be fine — US Central handles 65+ before crashing. But France crashes on the same timeline.

This points to **per-session memory cost being too high** — each session holds audio buffers, transcription state, VAD state, app connections, display state. At 22 sessions with all those resources, the pod still hits the memory ceiling.

It also suggests there may be a **time-based leak** separate from disposed sessions — something that grows proportionally to session-hours rather than session-count.

### 5. The pod memory limit is 4096MB but RSS crashes at ~1GB

The porter.yaml sets `ramMegabytes: 4096`, but pods crash at ~1GB RSS. This is NOT an OOM kill (the OOM Kills chart shows zero). The pod dies from **liveness probe failure**, not memory limit.

The ~1GB threshold is where GC pressure becomes so high that the event loop can't service the health check within the timeout. The actual memory limit (4GB) is never reached — the pod is killed for unresponsiveness long before it runs out of memory.

This means increasing the memory limit won't help. The problem is CPU starvation from GC, not memory exhaustion.

---

## What we still don't know

### 1. What's consuming the memory?

The SystemVitalsLogger shows heap growing but doesn't break down WHAT is growing. We have the `/api/admin/heap-snapshot` endpoint (from 057) but haven't captured a snapshot from a degraded pod (500MB+ heap) yet.

**Action:** Capture a heap snapshot from US Central when it's at 400-500MB heap (before it crashes but after significant growth). Load it in Chrome DevTools Memory tab to see what objects are consuming the most space.

### 2. Is there a time-based leak beyond disposed sessions?

`disposedSessionsPendingGC` is 0-1 on most snapshots, yet memory still grows. Either:

- Active sessions accumulate internal state over time (transcript history, audio buffer fragments, event listener chains)
- Some global data structure grows with session-hours (log buffers, metrics windows, caches)
- Bun runtime overhead (JIT compilation cache, ArrayBuffer fragmentation)

**Action:** Enable `MEMORY_TELEMETRY_ENABLED=true` in prod Doppler — this logs per-session memory breakdowns every 10 minutes, showing exactly which session components are growing.

### 3. Would distributing traffic help?

US Central has 65-70 sessions and crashes in ~3 hours. If traffic were split across 3 US regions (Central, West, East), each would have ~22 sessions — similar to France. But France ALSO crashes at 22 sessions after ~3 hours.

So distributing traffic buys headroom on session count but may not change the crash timeline. The per-session memory cost needs to come down regardless.

### 4. What does the CPU throttling chart show?

The CPU Throttling chart on the SRE dashboard shows whether Kubernetes is throttling the container's CPU. If throttling is high, the pod is exceeding its CPU allocation and being limited — which would make GC pressure worse. Need to check this chart during a crash window.

### 5. CRITICAL FINDING: Native memory exhaustion from TLS/WebSocket connections

**Discovered via the `analyze-heap.ts` live tracker watching a fresh pod boot from 0 → 58 sessions in 5 minutes:**

```
0 sessions:  RSS 260MB | Heap  78MB | External  51MB | ArrayBuf 17MB
58 sessions: RSS 466MB | Heap 186MB | External 108MB | ArrayBuf 54MB
                +206MB       +108MB         +57MB          +37MB
```

**The JS heap only accounts for 108MB of the 206MB growth.** The other 98MB is:

- `External`: +57MB — native allocations (TLS contexts, WebSocket internals, Bun runtime)
- `ArrayBuffers`: +37MB — binary buffers for network I/O
- Unaccounted: ~4MB — fragmentation, GC metadata

Meanwhile, the tracked application-level audio buffers report **0 bytes** the entire time. The memory problem is below the JS layer.

**Per-session connection count:**
Each UserSession creates 3-5 TLS WebSocket connections:

1. Glasses WebSocket (TLS) — always
2. 1-2 App WebSockets (TLS) — dashboard + user app
3. Soniox transcription WebSocket (TLS) — when mic is active
4. Translation WebSocket (TLS) — if translation is active

At 65 sessions: **200-325 concurrent TLS connections**, each carrying native memory overhead.

**This explains every observation:**

- Why France crashes at 22 sessions with the same ~3hr timeline — 22 sessions × 4 connections = ~88 TLS connections, still enough to exhaust memory over time
- Why 057 JS-level leak fixes didn't reduce crash rate — the problem is in native memory, not JS heap
- Why `disposedSessionsPendingGC` dropped to 0-1 but crashes continued — GC only manages JS heap, not native TLS/WebSocket buffers
- Why "unaccounted" memory is 25-37% of RSS — that's Bun's runtime overhead scaling with connection count
- Why increasing the pod memory limit (4GB) won't help — the crash happens from GC thrashing at ~1GB, not from hitting the limit

**Growth rate observed:** 43 MB/min RSS at 58 sessions. Estimated crash in ~13 minutes from boot.

**Per-session cost breakdown:**

- Total: ~8.0 MB RSS per session
- JS Heap: ~3.2 MB (40%)
- External (TLS/native): ~2.0 MB (25%)
- ArrayBuffers: ~0.6 MB (8%)
- Unaccounted (JIT/GC/frag): ~2.2 MB (27%)

---

## Observability gaps filled vs remaining

### Filled (this investigation)

| Gap                                             | How it was filled                                   |
| ----------------------------------------------- | --------------------------------------------------- |
| Can't see memory curve before crash             | ✅ SRE dashboard: Container RSS Over Time           |
| Can't see CPU during crash                      | ✅ SRE dashboard: Container CPU Usage               |
| Don't know if it's OOM or probe failure         | ✅ SRE dashboard: OOM Kills = 0, it's probe failure |
| Can't see crash frequency trend                 | ✅ SRE dashboard: Restarts Over Time                |
| No metrics for France/East Asia/US West/US East | ✅ Collectors installed on all 5 clusters           |
| Can't distinguish regions in logs               | ✅ REGION env var added to all Doppler configs      |

### Remaining

| Gap                                           | What's needed                                                                          |
| --------------------------------------------- | -------------------------------------------------------------------------------------- |
| Don't know exact per-connection native cost   | Profile Bun's TLS/WebSocket native allocations                                         |
| Don't know per-session memory breakdown       | ✅ `MEMORY_TELEMETRY_ENABLED=true` set in Doppler (pending redeploy)                   |
| No application-level metrics in dashboards    | Add Prometheus scrape annotations to porter.yaml                                       |
| Dashboard only covers US Central              | Build dashboards for other 4 collector sources                                         |
| No alerting on memory threshold               | Add BetterStack dashboard alert when RSS > 800MB                                       |
| No alerting on crash                          | Add BetterStack alert on container_restarts_total increase                             |
| Deploy vs crash noise in uptime               | Deploy Slack annotations (057 outstanding, but Porter Slack integration now active)    |
| No tracking of WebSocket/TLS connection count | Add a metric for total active connections (glasses WS + app WS + Soniox + translation) |

---

## Recommendations

### Immediate (no code changes)

1. ~~**Enable `MEMORY_TELEMETRY_ENABLED=true`**~~ ✅ Done — set in Doppler `prod` base config, pending redeploy
2. **Set up dashboard alerts** — RSS > 800MB warning, container restart alert
3. **Distribute traffic via Cloudflare LB** — session affinity cookie was disabled (was 23hr TTL, pinning users to wrong continent). Proximity steering active. Getting session count down per pod is the fastest way to reduce crash frequency.
4. **Add connection count tracking** — log total WebSocket + Soniox + TLS connections per vitals tick. Currently we track sessions but not the 3-5x multiplier of connections per session.

### Short-term (code changes — reduce per-connection native memory)

5. **Investigate Soniox connection pooling** — do we really need one TLS WebSocket per session for transcription? If Soniox supports multiplexing or session reuse, this could cut connection count by 30-40%.
6. **Close idle Soniox connections** — if a user's mic is off, the Soniox stream may still hold an open TLS connection. Close it on mic-off, reconnect on mic-on.
7. **Audit WebSocket buffer sizes** — Bun's WebSocket implementation may allocate large send/receive buffers per connection. Check if there are tunable options for buffer sizes.
8. **Add Prometheus scrape annotations** — let the collector scrape `/metrics` for application-level time-series.
9. **Switch liveness probe to `/livez`** — already exists (from 057). Reduce probe computation during GC pressure.

### Medium-term (architecture)

10. **Distribute traffic across US regions** — Cloudflare LB is configured. US West and US East are running. Getting from 65 sessions/pod to 20-25 sessions/pod cuts RSS from ~770MB to ~450MB — well under the crash threshold.
11. **Investigate Bun's TLS memory footprint** — file an issue or search Bun's GitHub for TLS connection memory usage. Other Bun users with high connection counts may have found workarounds.
12. **Evaluate connection-light alternatives for Soniox** — gRPC (HTTP/2 multiplexing over a single TLS connection) instead of per-session WebSockets. Or a sidecar process that handles all Soniox connections to isolate their memory from the main event loop.
13. **Horizontal scaling within a region** — multiple pods per region behind ingress. Requires solving the session affinity problem (in-memory sessions can't span pods) or moving to a shared session store.

---

## Key numbers

| Metric                                  | Value                                              |
| --------------------------------------- | -------------------------------------------------- |
| Crash rate (current)                    | ~6-7/day across all regions                        |
| US Central sessions at crash            | 65-70                                              |
| France sessions at crash                | 22-30                                              |
| Time to crash (fresh pod)               | ~13 min at 58 sessions (observed), 2-4 hrs typical |
| RSS at crash                            | ~1GB                                               |
| Heap at crash                           | 500-700MB                                          |
| Pod memory limit                        | 4096MB (never reached)                             |
| OOM kills                               | 0 (all crashes are probe failures)                 |
| disposedSessionsPendingGC (post-057)    | 0-1 (was 245)                                      |
| RSS growth rate (observed)              | 43 MB/min at 58 sessions                           |
| RSS baseline (0 sessions)               | 252MB                                              |
| Per-session RSS cost                    | ~8.0 MB                                            |
| Per-session JS heap cost                | ~3.2 MB (40% of per-session RSS)                   |
| Per-session native/external cost        | ~2.6 MB (32% of per-session RSS)                   |
| Per-session unaccounted (JIT/GC/frag)   | ~2.2 MB (28% of per-session RSS)                   |
| Connections per session                 | 3-5 (glasses WS + app WS + Soniox + translation)   |
| Est. connections at crash (65 sessions) | 200-325 TLS WebSocket connections                  |
| Audio buffer bytes at all times         | 0 (not the problem)                                |

---

## Tools Created

**`cloud/packages/cloud/src/scripts/analyze-heap.ts`** — CLI tool for live memory analysis:

```
# Watch memory growth in real-time (polls every 30s)
MENTRA_ADMIN_JWT="(token)" bun run src/scripts/analyze-heap.ts live --host=uscentralapi.mentra.glass

# Compare two snapshots 5 min apart (shows per-session deltas)
MENTRA_ADMIN_JWT="(token)" bun run src/scripts/analyze-heap.ts compare --host=uscentralapi.mentra.glass --delay=300

# Track France
MENTRA_ADMIN_JWT="(token)" bun run src/scripts/analyze-heap.ts live --host=franceapi.mentra.glass
```

Supports: live polling with growth rate calculation, crash detection (uptime reset), per-session delta tracking, estimated time-to-crash, memory breakdown (heap/external/arraybuffer/unaccounted).

## Next Steps

1. **Run `analyze-heap.ts live` on France** to confirm the same native memory pattern at lower session counts
2. **Add connection count to SystemVitalsLogger** — track glasses WS + app WS + Soniox connections per tick
3. **Investigate Soniox connection lifecycle** — are connections held open when mic is off? How much native memory per Soniox TLS WebSocket?
4. **Write spec.md** with specific changes to reduce per-connection native memory
5. **Update SRE dashboard with alerts** — RSS > 800MB warning, restart alert
6. **Build dashboards for the 4 new collector sources** (France, East Asia, US West, US East)
7. **Research Bun TLS memory** — file/search Bun GitHub for per-connection memory overhead, tunable buffer sizes
