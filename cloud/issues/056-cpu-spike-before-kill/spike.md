# Spike: What Causes the 5-Core CPU Spike Before Pod Kill?

## Overview

**What this doc covers:** Investigation into what drives the cloud-prod Bun process from ~0.5 cores steady-state to 5.02 cores (the resource limit) immediately before Kubernetes kills the pod via liveness probe failure.
**Why this doc exists:** Issue 055 confirmed the crashes are liveness probe failures, not OOM — but the root question remains unanswered: what blocks the event loop for 75+ seconds? The CPU spike happens _before_ the kill, not after. Something in the running server saturates all available CPU, starving the `/health` endpoint. This spike identifies the specific code paths responsible.
**Who should read this:** Cloud engineers, anyone working on cloud-prod stability, performance, or scaling.

**Depends on:** [055-cloud-prod-oom-crashes/spike.md](../055-cloud-prod-oom-crashes/spike.md)

---

## Background

From issue 055, we know:

- Cloud-prod runs on Bun (single-threaded event loop) with a 5-core / 4096MB resource limit
- Kubernetes liveness probe: `GET /health`, timeout=1s, period=5s, failureThreshold=15 → 75s to kill
- At crash time: CPU = **5.02 cores**, Memory = **924 MB** (well under 4096MB limit)
- The CPU spike happens **before** the SIGKILL, not after — this is not the reconnection storm
- Steady-state CPU is ~0.5–1.0 cores with ~40 sessions
- The pod was crashing every 30–96 minutes depending on load

The question 055 left open: **which specific code paths drive CPU from 0.5 to 5.0 cores?**

### How does a single-threaded runtime use 5 cores?

Bun uses JavaScriptCore (JSC), which has background threads for:

- JIT compilation (FTL/DFG tiers)
- Garbage collection (concurrent marking, parallel sweeping)
- WASM compilation and tier-up

So "5.02 cores" means: the main JS thread is pegged at 100%, AND JSC's background threads (GC, JIT) are also fully loaded. This happens when the main thread is generating enormous GC pressure and/or triggering JIT recompilation under hot code that keeps changing shapes.

---

## Critical Context: This Is a Regression With a Known Start Date

**The crashes started after a specific deploy. The WASM/LC3 decode code has not changed in months.**

### Git timeline (Feb–March 2026)

| Date       | Commit          | What Changed                                                                              |
| ---------- | --------------- | ----------------------------------------------------------------------------------------- |
| Feb 13     | `dafa16859`     | feat: cloud-side WS liveness detection + 503 for missing session                          |
| Feb 14     | `647914e63`     | fix: disable pong timeout killing healthy WS connections                                  |
| **Feb 22** | **`6668b2847`** | **first pass at better telemetry (incident processor created)**                           |
| Feb 23     | `57c34df38`     | fix lots of bugs w this (incident system patches)                                         |
| Feb 23     | `867c9bd6e`     | fix: enable Soniox SDK by default, remove broken tokenOffset logic                        |
| Feb 24     | `88d9da5dc`     | address codex bug reports (incident system patches)                                       |
| Feb 26     | `0efb0dfc9`     | feat(041): audio output streaming, realtime AI providers, reconnectable relay             |
| Feb 27     | `3b79a9ad9`     | **refactor: mass delete dead code — LiveKit, Express, Azure, app-communication**          |
| Mar 3      | `bad5327ea`     | Revert "Add BES log collection…" (reverted due to instability)                            |
| Mar 9      | `81b4eae33`     | feat(046): SDK app-ws liveness ping-pong                                                  |
| Mar 17     | `6d7b4cf32`     | fix: resolve all pre-existing TypeScript strict errors (34 violations)                    |
| **Mar 22** | **`71a2ab8b2`** | **fixes (touched incident processor again — 3 days before crash)**                        |
| **Mar 23** | **`9a6c81ed6`** | **feat(048): SDK v3 runtime — MentraSession, managers, MiniAppServer, transport, compat** |
| Mar 23     | `598a4f51c`     | refactor(048): rename compat adapters, add missing v2 compat methods                      |
| Mar 23     | `f52d8cfd8`     | fix(048): batch subscriptions, fix LocationManager leak                                   |
| Mar 24     | `379f9653d`     | chore: enable the content moderation                                                      |
| **Mar 25** | —               | **7 bug reports filed, 12 pod restarts in 8 hours**                                       |

The two highest-risk changes that landed in the 72 hours before the March 25 crash:

1. **March 22: `71a2ab8b2` — incident processor touched again.** The incident system was introduced Feb 22 and has been patched multiple times. This is its most recent change before the crash.

2. **March 23: `9a6c81ed6` — SDK v3 runtime.** A massive refactor introducing `MentraSession`, new managers, `MiniAppServer`, transport layer, and compatibility adapters. This is the single largest change in the 30 days before the crash.

**The LC3 WASM decode code has NOT been modified in any of these commits.** It has been running fine with 40+ sessions for months.

---

## The Evidence

### Porter metrics at crash time (March 25, 13:41 UTC)

| Metric        | Value      |
| ------------- | ---------- |
| Max CPU       | 5.02 cores |
| Avg CPU       | 5.02 cores |
| Min CPU       | 5.02 cores |
| Memory        | 924.44 MB  |
| Instances     | 1          |
| 2xx responses | 1195.5     |
| 3xx responses | 37.5       |
| 4xx responses | 1073.5     |
| 5xx responses | 2379.8     |

The CPU reading is min=avg=max=5.02 for the sample window. This means the process was **pegged at the resource limit** for the entire metric interval — not a brief spike, but sustained saturation.

---

## Benchmark Results: LC3 WASM Decode Is Ruled OUT

We wrote a comprehensive benchmark (`src/scripts/benchmark-cpu-suspects.ts`) that tests LC3 decode throughput, incident JSON processing, and event loop blocking under simulated load.

**Run on:** Bun 1.3.11, macOS arm64, 14 cores.

### LC3 WASM decode at 40 sessions: **0.7% of CPU budget**

```
Sessions   Chunks     Decode Time    % of 1s budget   Verdict
---------- ---------- -------------- ---------------- --------
10         160        3.51ms         0.4%             ✅ Fine
20         320        4.52ms         0.5%             ✅ Fine
30         480        7.51ms         0.8%             ✅ Fine
40         640        7.41ms         0.7%             ✅ Fine
50         800        9.80ms         1.0%             ✅ Fine
60         960        10.58ms        1.1%             ✅ Fine
70         1120       11.81ms        1.2%             ✅ Fine
80         1280       15.03ms        1.5%             ✅ Fine
```

At 40 sessions (640 decode calls/sec), WASM decode uses **0.7% of the event loop budget.** Even at 80 sessions it's only 1.5%. Single-frame decode averages **1.28µs**. This is negligible.

**Event loop lag from 640 decodes: 4.01ms** — nowhere near the 1-second health probe timeout.

### WASM instantiation burst: also fine

```
10 concurrent instantiations:  4.72ms  (471µs each)
20 concurrent instantiations:  8.22ms  (411µs each)
40 concurrent instantiations: 16.26ms  (406µs each)
```

40 simultaneous WASM instantiations during a thundering herd would block for only 16ms. Not a factor.

### LC3 is definitively ruled out

The WASM decode code:

- Uses **0.7%** of CPU at 40 sessions
- Has **not been modified** in the timeframe of the regression
- Causes **4ms of event loop lag** at production load — 250× below the 1s health probe timeout

**We will not investigate LC3 further for this issue.**

---

## Incident JSON Processing: Small at Realistic Sizes

### Read-modify-write cycle (what `incident-storage.service.ts` actually does)

```
Starting doc: 709.6KB (1000 cloud logs, 500 phone logs)
Each append adds 200 log entries

Append #1: doc=802.3KB, cycle=1.46ms   ✅ Fine
Append #2: doc=894.9KB, cycle=1.57ms   ✅ Fine
Append #3: doc=987.6KB, cycle=1.76ms   ✅ Fine
Append #4: doc=1.1MB,   cycle=2.09ms   ✅ Fine
Append #5: doc=1.1MB,   cycle=2.12ms   ✅ Fine
Append #6: doc=1.2MB,   cycle=2.26ms   ✅ Fine

Total blocking time for 6 append cycles: 11.26ms
```

At realistic incident sizes (1000 cloud logs, a few app uploads), the full read-modify-write cycle blocks for ~2ms per append, ~11ms total for 6 appends. Not enough to cause a 75-second event loop stall.

### BetterStack log parsing: fine

```
Response size: 436.3KB
Split 1000 lines: 1.67ms
Parse all lines (2× JSON.parse each): 1.05ms
Total blocking time: 2.72ms  ✅ Fine
```

### But it gets bad at extreme sizes

```
JSON.stringify at large sizes (pretty-print with null, 2):

Cloud Logs   Phone Logs   App Logs     Doc Size     Pretty         Verdict
------------ ------------ ------------ ------------ -------------- --------
1000         500          500          25.8MB       38.53ms        🟠 Noticeable
1000         1000         1000         101.5MB      144.21ms       🔴 BLOCKS >100ms
2000         1000         2000         403.9MB      570.94ms       🔴 BLOCKS >100ms
```

The incident storage code uses `JSON.stringify(logs, null, 2)` (pretty-print). At very large incident sizes (5+ apps each uploading substantial telemetry), this could block for 100ms+. Not 75 seconds — but it could compound with other operations during a period when the event loop is already under pressure.

### Combined work (40-session decode + incident JSON): fine

```
Combined (640 LC3 decodes + incident JSON cycle): work=3.83ms, event loop lag=3.84ms  ✅ OK
```

The incident system at realistic sizes is **not the primary cause**, but:

- The `JSON.stringify(logs, null, 2)` should still be changed to compact `JSON.stringify(logs)` — there's no reason to pretty-print data stored in R2
- At extreme sizes it can block the event loop for 100ms+ which is bad hygiene
- It was modified March 22, 3 days before the crash — still suspicious as a contributing factor

---

## What We've Ruled Out

| Suspect                                    | Status                         | Evidence                                                                  |
| ------------------------------------------ | ------------------------------ | ------------------------------------------------------------------------- |
| LC3 WASM decode                            | **RULED OUT**                  | 0.7% of CPU at 40 sessions, 4ms event loop lag, code unchanged for months |
| WASM instantiation burst                   | **RULED OUT**                  | 40 concurrent instantiations = 16ms total                                 |
| Incident JSON processing (realistic sizes) | **RULED OUT as primary cause** | 2ms per append cycle, 11ms for 6 cycles                                   |
| BetterStack log parsing                    | **RULED OUT**                  | 2.7ms for 1000 lines                                                      |
| OOM / memory exhaustion                    | **RULED OUT** (from 055)       | Memory was 924MB at crash, limit is 4096MB                                |

---

## What Remains: The Real Suspects

### Suspect 1: SDK v3 Runtime (feat 048) — landed March 23

Commit `9a6c81ed6` introduced `MentraSession`, new managers, `MiniAppServer`, transport layer, and compatibility adapters. This is a **massive** change that landed 2 days before the crash.

**What we need to investigate:**

- Does `MentraSession` or the new transport layer introduce new per-message processing overhead?
- Do the compatibility adapters add synchronous work to the hot audio/message path?
- Does the new `MiniAppServer` change how app WebSocket messages are handled?
- Are there new timers, intervals, or event handlers that fire per-session?
- Does `batch subscriptions` (commit `f52d8cfd8`) change the subscription evaluation frequency?

**This is the #1 suspect based on timing.**

### Suspect 2: Accumulated Timer/Callback Pressure

From the code audit, at 40 sessions the server has:

- 40 app-level ping intervals (every **2 seconds** — `JSON.stringify` + WS send per app)
- 40 glasses heartbeat intervals (every 10s)
- 40 mic keep-alive intervals (every 10s — includes `getFreshSubscriptionState()`)
- 40 transcription health check intervals (every 60s)
- 40 translation health check intervals (every 60s)
- Various fire-and-forget promises from provider initializations

**Total: ~28 timer callbacks/second** in steady state. This isn't enough to cause a 75-second stall by itself, but if SDK v3 added more per-session timers or callbacks, the cumulative load could cross a threshold.

### Suspect 3: Something in the Code Paths We Haven't Benchmarked

The benchmark tested isolated components (WASM decode, JSON processing). But the actual server has interactions between components that may create emergent behavior:

- **Promise resolution storms** — if many async operations resolve on the same tick, the microtask queue can block the event loop for extended periods
- **Subscription evaluation cascades** — `getFreshSubscriptionState()` might trigger re-evaluation of all subscriptions, which could cascade through managers
- **Soniox raw WebSocket provider O(n²) token processing** — if the old `SonioxTranscriptionProvider` is still used as a fallback (not just `SonioxSdkStream`), the rolling-window token iteration is O(n) per message × O(n) messages = O(n²) cumulative CPU per utterance

### Suspect 4: The March 22 Incident Processor Change

Commit `71a2ab8b2` ("fixes") touched the incident processor 3 days before the crash. While incident JSON processing at realistic sizes is fast, we don't know:

- What specifically changed in this commit
- Whether the change introduced a new code path that runs more frequently (not just on bug reports)
- Whether it introduced a regression in the fire-and-forget processing that causes unbounded work

---

## What We Don't Know

1. **What specifically changed in commits `71a2ab8b2` (Mar 22) and `9a6c81ed6` (Mar 23)** — we need a detailed diff review of these two commits against the hot paths (audio processing, WebSocket message handling, session management, timers)
2. **Whether SDK v3 added new per-session timers or synchronous callbacks** — the benchmark tested pre-v3 code paths; if v3 added overhead to every message or every timer tick, that's not captured
3. **Whether the Soniox raw WebSocket provider is active in production** — if it is, the O(n²) token processing is a major suspect
4. **Whether the crash pattern started after Feb 22 (incident system), March 22 (incident fix), or March 23 (SDK v3)** — narrowing the regression window to the exact deploy would identify the cause
5. **What the actual session count was at crash time** — we know ~40 from memory profiling, but don't have continuous session metrics
6. **Whether any of the crashes were cascading** (thundering herd from a previous crash triggering another) — checking BetterStack startup banner timestamps would answer this

---

## Conclusions

| Finding                                                                   | Confidence                                                                           |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| LC3 WASM decode is NOT the cause (0.7% CPU at 40 sessions)                | **Confirmed** — benchmark, code unchanged                                            |
| WASM instantiation burst is NOT the cause (16ms for 40 instances)         | **Confirmed** — benchmark                                                            |
| Incident JSON at realistic sizes is NOT the primary cause (2ms/cycle)     | **Confirmed** — benchmark                                                            |
| The crash is a regression that started after a specific deploy            | **High** — user reports, no crashes before this window                               |
| SDK v3 (March 23) is the most likely cause based on timing + scope        | **High** — largest change in 72 hours before crash                                   |
| Incident processor change (March 22) is a secondary suspect               | **Medium** — small change, but right in the window                                   |
| The 5-core spike requires main thread saturation + background thread load | **High** — 5 cores on a single-threaded runtime means GC/JIT threads are also pegged |

---

## Next Steps

### Immediate: Narrow the regression window

1. **Diff review of `9a6c81ed6` (SDK v3 runtime)** — specifically look at:
   - Any code that runs on the per-message or per-audio-chunk hot path
   - New `setInterval`/`setTimeout` timers added per session
   - Changes to how WebSocket messages are dispatched or processed
   - New synchronous iteration over sessions, apps, or subscriptions
   - Any `.on()` event handlers or watchers created per session

2. **Diff review of `71a2ab8b2` (incident processor fix)** — check if this commit changed anything that runs outside of incident creation (e.g., a new interval, a new middleware, a startup task)

3. **Check Porter deploy history** — determine exactly which commits were deployed to cloud-prod before the crashes started. Did the crashes begin after the March 23 deploy or earlier?

4. **Check BetterStack for cascade evidence** — look at startup banner timestamps. If two restarts are <2 minutes apart, the second was a thundering-herd-induced cascade.

### Short-term fixes (regardless of root cause)

5. **Add a lightweight `/livez` endpoint** — `app.get("/livez", (c) => c.text("ok"))` with zero computation. Point the Kubernetes liveness probe here. The current `/health` iterates all sessions, counts WebSockets, updates gauges, and serializes JSON — all unnecessary for liveness.

6. **Add explicit probe config to Porter YAML** — version-control the settings instead of relying on Porter defaults. Point liveness at `/livez`, increase timeout to 3s.

7. **Fix the two latent bugs from 055** — email case mismatch (`bun-websocket.ts:90`) and dispose identity check (`UserSession.ts:793`). One-liners, no risk.

8. **Enable `MEMORY_TELEMETRY_ENABLED=true`** in Porter env — zero code change, gives us historical session/memory data.

9. **Switch incident storage to compact JSON** — change `JSON.stringify(logs, null, 2)` to `JSON.stringify(logs)`. Pretty-printing a 1MB document costs 3–4× more than compact and there's no human reading R2 blobs directly.

### If SDK v3 is confirmed as the cause

10. **Revert or feature-flag the SDK v3 runtime** and verify crashes stop. Then reintroduce incrementally with event loop monitoring.

11. **Add event loop lag monitoring** — `setInterval` drift measurement, log when lag exceeds 100ms/500ms/1s. Deploy _before_ re-enabling SDK v3 so we can see the impact in real time.

### If root cause remains unclear

12. **Add per-operation timing to the hot paths** — wrap the top 5 most-called functions (audio processing, WS message dispatch, subscription evaluation, timer callbacks, transcription feed) with `performance.now()` and log aggregates every 30 seconds. This gives us a production flame graph without needing a profiler.

13. **Reproduce under load** — use the stress environment (`porter-stress.yaml`, 5 CPU / 4GB) to run 40+ simulated sessions and observe CPU behavior. Add the event loop lag monitor first so we can see exactly when and where the loop saturates.
