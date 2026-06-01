# Spike: Event-Loop Cascade Investigation (Staging 2026-05-04, Multi-Cascade Analysis)

**Status:** Open — investigation; spec.md proposes the instrumentation needed to close the gap
**Date:** 2026-05-04
**Last updated:** 2026-05-05 — Phase 1.5 observability implemented on `cloud/issue-106`; cloud-debug smoke passed; soak ongoing
**Reporter:** Investigation conducted live during staging cascade event 17:02 UTC, then back-tested against three prior us-central prod cascades (04-30 15:40, 04-30 18:24, 05-01 11:38)
**Related:**

- [102-pod-loop-stall-cascade](../102-pod-loop-stall-cascade/) — Phase 1 instrumentation that produced the data this spike analyzes
- [055-cloud-prod-oom-crashes](../055-cloud-prod-oom-crashes/) — original 2026-03 framing of liveness-probe-failure cascade
- [061-crash-investigation](../061-crash-investigation/) — added GC + health-timing instrumentation
- [076-aks-node-maintenance-pod-evictions](../076-aks-node-maintenance-pod-evictions/) — distinguishes infrastructure events from cascades; rules out 05-01 12:01 cluster event from cascade analysis
- [104-soniox-eventqueue-leak](../104-soniox-eventqueue-leak/) — independently fixed memory leak; ruled out as a current cascade contributor
- [106-app-ws-storm-multi-app](../106-app-ws-storm-multi-app/) — sister issue investigating the multi-app simultaneous WS-disconnect pattern that this spike identifies as the proximate cascade trigger

---

## Plain-English Observability Model

This spike is trying to stop us from guessing. Production observability is just a way to leave enough breadcrumbs that, when the pod gets sick again, we can reconstruct what happened.

There are four kinds of clues:

| Clue type | Plain meaning | Example for this incident |
|---|---|---|
| Logs | "What happened?" | `slow-app-message` for `subscription_update` took 420 ms |
| Metrics | "How much/how often?" | 56 app WS 1006 closes in one minute |
| Traces/phase timings | "Where did one operation spend time?" | reconnect spent 310 ms in `refreshInstalledApps` |
| Profiling | "What code burned CPU?" | CPU samples point at layout/rendering/JSON parsing |

Better Stack is where we store, search, graph, and alert on these clues. But Better Stack cannot automatically know Mentra-specific concepts like `CONNECTION_INIT`, `RECONNECT`, `subscription_update`, `broadcastAppState`, or `com.mentra.captions.debug`. Our code has to emit those facts first.

The core question is:

```text
Did app-message time grow because code was blocking the event loop,
or because handlers were awaiting slow resources while the event loop stayed alive?
```

Those look similar in today's `op_appMessage_ms` number but require different fixes.

---

## Summary

The staging pod cascaded at 2026-05-04 17:02 UTC and the container restarted in place. Phase 1 obs (issue 102) was running, and the BetterStack S3 historical log tier preserved enough data to reconstruct the lead-up minute-by-minute. We also re-queried three earlier us-central prod cascades the same way.

The picture that emerges is **more nuanced than any single hypothesis**, and earlier first-pass conclusions in this investigation were wrong:

- **Wrong Hypothesis #1:** "It's an lc3Decode cascade" — caught by Phase 1's `slow-audio-stage` warnings. Wrong: lc3Decode time inflation was a **measurement artifact**. The Phase 1 substage timer brackets the entire `decodeAudioChunk` call, including allocs and GC pauses landing inside it. When other work on the loop pressured GC, decode times appeared to spike. The actual time-eater was elsewhere.
- **Wrong Hypothesis #2:** "It's heavy `op_appMessage_ms`" — confirmed at the gross level: every cascade across 4 events shows app_msg dominating opTotalMs at 95–98%. But high `op_appMessage_ms` alone doesn't trigger cascade — staging has spikes of 1500–2000 ms regularly without cascading.
- **Wrong Hypothesis #3:** "It's `com.mentra.captions` display request volume" — staging right now is doing **2.4× more captions display requests** than during the cascade window, while remaining healthy. Volume isn't the trigger.

What the data **does** show:

1. Cascades are **two-phase** events: a slow-build phase (occasional `op_appMessage_ms` spikes accumulating over minutes) followed by a sudden burst-trigger (multi-app WS disconnect storm) that pushes the loop fully blocked.
2. The proximate cascade trigger for staging 17:02 was a **104-event WebSocket close storm** in the minute immediately before the block: 49 distinct app WS connections from 5 different packages closed with code 1006 (abnormal closure) within ~60 seconds.
3. The same `op_appMessage_ms` dominance signature appears in all three prior us-central prod cascades. We have weaker evidence for the WS storm pattern in those (Phase 1 wasn't on prod).
4. Existing telemetry has reached its useful limit. Several questions can't be answered without instrumentation we don't have.

**2026-05-05 refinement:** an independent follow-up pass strengthened the app-message thesis but weakened the claim that the staging WS storm explains all prod cascades. The updated view is:

1. `op_appMessage_ms` dominance is still the common cross-cascade symptom.
2. The staging 17:02 event had a real, unusually large app+glasses WS storm and an actual event-loop silence window.
3. The three prior prod windows did **not** show a staging-scale simultaneous app 1006 storm. They may be related through the same app-message degradation path, but the proximate trigger appears different or weaker.
4. Local reproduction shows two separate mechanisms that existing telemetry currently conflates:
   - **Async wall-time amplification**: slow awaits can produce tens of seconds of aggregate `op_appMessage_ms` while the event loop remains responsive.
   - **Synchronous storm amplification**: tiny synchronous work per reconnect/subscription can multiply across dozens of simultaneous app sessions and produce multi-second heartbeat gaps.

---

## The Cascade Pattern (staging 2026-05-04 17:02)

### Timeline

```
Time     app_ms (30s)  WS 1006s  micActive  Notes
─────    ────────────  ────────  ─────────  ─────
16:30-39  87-131         0        17-22      Baseline (~0.3% of one core)
16:40       326           0        20         Small spike, recovers same minute
16:46     ★ 2142 ★         0        22         BIG spike (20× baseline), recovers
16:48-49  1245-1309        0        22         Sustained spike, recovers
16:51       331           0        24         Moderate
16:54-58  49-280           0        25-28      Intermittent
16:59     ★ 1425 ★         0        29         BIG spike
17:00         82           0        29         Recovers
17:01         72         ★104★+52   29         WS STORM (49 apps × 1006 in 60s)
17:02       (none)          0        ?          ← LOOP BLOCK (vitals didn't fire)
17:03         72           0        29         ← Container restart in place
17:04        1504          0        28         Spike STILL happens post-restart
17:05          74          0        29         Recovers
17:06        1884          0        29         Spike STILL happens
```

### What was true throughout

- Memory **flat** at 384–393 MB. Heap 70–95 MB. No memory cascade.
- `wsDisconnects`/`wsReconnects` counters at near-zero except 17:01 (the storm).
- Mongo blocking ms steady at ~150 ms per 30s. Not blocking.
- **Zero `event-loop-lag` warnings fired** (threshold >100 ms), across the whole cascade window AND across all four cascade days.
- Audio processing time (`op_audioProcessing_ms`) was steady 1000–1300 ms / 30s, scaling with mic-active count. Not anomalous.

### The smoking-gun signal: vitals didn't fire at 17:02

`SystemVitalsLogger` runs on a 30-second `setInterval`. Two consecutive emission slots produced no log (17:02:11 and 17:02:41 missing). The only way that happens is the event loop being blocked the entire interval. After the restart, the next vitals at 17:03:23 reported `opTotalMs: 41,836` with `op_appMessage_ms: 41,035` — that's the catch-up: the accumulator captured ~41s of app-message wall-time that elapsed during the block + recovery.

### The proximate trigger: WS storm at 17:01

In the 60-second window immediately preceding the loop block, **49 distinct app WS connections from 5 packages closed simultaneously**:

| Package | Closes (code 1006) |
|---|---|
| com.mentra.captions | 16 |
| com.mentra.ai | 10 |
| cloud.augmentos.notify | 9 |
| com.mentra.merge | 8 |
| com.mentra.notes | 6 |

Each close triggers cleanup work: close handler, grace-period timer, eventual reconnect (auth + session lookup + state sync + subscription re-establish + transcription re-attach), `mic state resync` (logged 20× in this minute), `app_state_change` broadcast to all glasses WSs.

**Code 1006 = abnormal WebSocket closure.** No clean close-frame handshake. This is TCP-level disruption, not app-side `ws.close(1000, ...)`.

49 simultaneous reconnect cycles is enough cleanup work to push the already-loaded loop over the liveness threshold (75 s of failed `/livez`).

---

## What's Consistent Across the Four Cascades

I queried `s3Cluster(primary, t373499_mentracloud_prod_s3)` (full historical retention) for the three prior us-central cascades. Phase 1 obs is NOT on prod (#2626 wasn't merged), so I can't see `slow-audio-*` events there — but `op_*_ms` op timers, `system-vitals`, and standard log lines are all preserved.

| Cascade | Peak op_appMessage_ms (30s) | % of opTotalMs | audio_ms during peak | Signature |
|---|---|---|---|---|
| Prod 04-30 15:40 | 2,901 ms | 97% | 92 ms | App-msg dominant |
| Prod 04-30 18:24 | 7,616 ms | 96% | 291 ms | App-msg dominant |
| Prod 05-01 11:38 | 4,686 ms | 99.9% | 0 ms (no mic) | App-msg dominant |
| **Staging 05-04 17:02** | 41,035 ms | 98% | 398 ms | **App-msg dominant + WS storm + loop block** |

**`op_appMessage_ms` dominates `opTotalMs` in all four.** `op_audioProcessing_ms` is normal-to-low in all four. Audio is consistently NOT the cascade time-eater.

**The 4× prod cascades did NOT show a 17:02-style vitals gap.** The pod stayed responsive enough to keep emitting vitals every 30 s, even while `op_appMessage_ms` was bursting. K8s probes timed out (visible as BetterStack uptime incidents) but the pod survived without container restart for the 04-30 cascades; 05-01 11:38 did restart.

So the prod cascades may have been **degraded responsiveness without full loop blockage**, while the staging cascade had **actual loop blockage**. Both have the same dominant signal (`op_appMessage_ms`) but different severity.

### 2026-05-05 W4 re-query: prod did not have a staging-scale app WS storm

The follow-up pass queried the S3 historical table for the three prior us-central prod windows at both minute and second granularity:

```sql
SELECT
  toStartOfSecond(dt) AS second,
  countIf(JSONExtractString(raw, 'service') = 'AppManager'
    AND positionCaseInsensitive(JSONExtractString(raw, 'message'), '1006') > 0) AS app_1006,
  countIf(positionCaseInsensitive(JSONExtractString(raw, 'message'), 'unexpectedly disconnected') > 0) AS unexpected,
  uniqIf(JSONExtractString(raw, 'packageName'),
    JSONExtractString(raw, 'service') = 'AppManager'
    AND positionCaseInsensitive(JSONExtractString(raw, 'message'), '1006') > 0) AS distinct_packages
FROM s3Cluster(primary, t373499_mentracloud_prod_s3)
WHERE _row_type = 1
  AND JSONExtractString(raw, 'region') = 'us-central'
  AND <cascade-window predicates>
GROUP BY second
HAVING app_1006 > 0 OR unexpected > 0
ORDER BY app_1006 DESC, unexpected DESC
```

Top results:

| Window | Largest app 1006 second | Distinct packages | Timing vs cascade | Interpretation |
|---|---:|---:|---|---|
| Prod 04-30 15:40 | 2 | 1 | scattered before/during window | Not a multi-app storm |
| Prod 04-30 18:24 | 2 | 1 | scattered before/during window | Not a multi-app storm |
| Prod 05-01 11:38 | 12 | 5 | 11:20:34 UTC, ~18 min before listed cascade | Small multi-app burst, not staging-scale |
| Staging 05-04 17:02 | 104 AppManager 1006 log lines, 52 unexpected app disconnects | 8 | 17:01:17 UTC, immediately before stall | Staging-scale storm |

This refines issue 106: the staging storm is real and likely important for that restart, but it is **not currently proven as the universal prod cascade trigger**.

### 2026-05-05 Porter/Kube confirmation of exit 137

`porter kubectl --cluster 4689 -- describe pod cloud-staging-cloud-c9986c855-zqr9k -n default` showed:

- Current staging pod last state: `Terminated`, `Reason: Error`, `Exit Code: 137`.
- Old container finished at `2026-05-04 17:02:51 UTC`.
- New container started at `2026-05-04 17:02:52 UTC`.
- Generated liveness probe: `GET /livez`, `timeout=3s`, `period=5s`, `failureThreshold=15`.
- Porter config sets `terminationGracePeriodSeconds: 10`.

There were no `shutdown-started`, `shutdown-complete`, `SIGTERM`, or `shutdown-watchdog-fired` logs in BetterStack for the staging window.

Interpretation: the code already has a fail-fast SIGTERM handler in `packages/cloud/src/index.ts`, including synchronous stderr logging. Exit 137 does **not** mean "we forgot graceful shutdown." It most likely means Kube sent SIGTERM after ~75s of failed liveness probes, but the JS event loop was not able to run the signal handler before the 10s grace expired, so Kube sent SIGKILL.

Operational implication: if we want faster restart, adjust liveness timing/failure policy. If we want clean exit code 0, the JS loop must be able to run the signal handler; a hard-pinned loop cannot.

### 2026-05-05 local harness findings

A local-only harness was added under `cloud/tools/ws-storm-local/` to avoid deploying while still exercising the real Mentra session paths. It uses `com.mentra.captions.debug` whenever captions is included in a package pool.

Two harnesses exist:

- `bun-ws-storm-harness.ts` — raw Bun native WebSocket server/client storm.
- `mentra-path-storm-harness.ts` — exercises real `AppManager`, `AppSession`, `SubscriptionManager`, and optionally `handleAppMessage`, with fake sockets and stubbed external services.

Key results:

| Scenario | Shape | Max heartbeat gap | Result |
|---|---|---:|---|
| Raw Bun WS, 112 simultaneous closes/reconnects | no artificial work | ~2ms | Bun WS close/reconnect alone did not reproduce stall |
| Raw Bun WS, async reconnect delay 3000ms | awaits only | ~3ms | Huge wall-time without loop stall |
| Real Mentra v3 reconnect, 56 apps × 10 rounds | `RECONNECT`, message handler on | 6ms | Clean |
| Real Mentra legacy init, clean DB/resources | `CONNECTION_INIT` during grace | 5ms | Clean |
| Legacy init + async 100ms DB-like delay, 56 apps × 3 rounds | fake async User/App queries | 12ms | Aggregate reconnect wall-time 69s, event loop responsive |
| Legacy init + async 100ms DB-like delay, 112 apps × 2 rounds | fake async User/App queries | 11ms | Aggregate reconnect wall-time 92s, event loop responsive |
| Legacy init + sync 5ms User/App DB-like work, 56 apps × 2 rounds | fake sync CPU around DB calls | 1120ms | Sync amplification visible |
| Legacy init + sync 20ms User/App DB-like work, 56 apps × 1 round | fake sync CPU around DB calls | 4481ms | Crosses current `/livez` timeout |
| v3 reconnect + subscription/transcription sync 20ms, 56 apps × 1 round | sync downstream manager work | 1119ms | Subscription fanout can amplify sync work |

Main takeaways:

1. A WS close/reconnect storm by itself is not enough to reproduce the 80s staging stall locally.
2. Large aggregate `op_appMessage_ms` can be entirely async wall-time. This matches prod windows where vitals kept firing.
3. The dangerous condition is many simultaneous app init/subscription paths plus small synchronous segments. The local harness shows how tens of milliseconds of sync work can become seconds of liveness-visible delay.
4. The real code path difference matters:
   - `handleReconnect()` for SDK v3 is relatively light.
   - legacy `handleAppInit()` calls `attachAppSocket()`, then `broadcastAppState()`, then `refreshInstalledApps()`.
   - `refreshInstalledApps()` calls `appService.getAllApps(userId)`, which does `User.findOne` and `App.find`.
   - Subscription updates call `SubscriptionManager.syncManagers()`, which awaits transcription/translation update and stream ensure work.

This makes `CONNECTION_INIT` during grace/reconnect and `subscription_update` fanout the most suspicious paths for Phase 1.5 instrumentation.

### 2026-05-05 Bun event-loop histogram local spike

Before committing `perf_hooks.monitorEventLoopDelay` to the instrumentation design, we tested it locally on Bun `1.3.13`.

Support check:

| API | Bun 1.3.13 local result | Decision |
|---|---|---|
| `perf_hooks.monitorEventLoopDelay` | Exists and reports useful delay histograms | Use it, with feature detection |
| `histogram.reset()` | Exists | Reset after each vitals window |
| `performance.eventLoopUtilization()` | Exists but returned all zeros during idle+busy test | Do not use yet |
| `PerformanceObserver.supportedEntryTypes` | `["mark","measure","resource"]`; still no `gc` | No natural-GC observer |

Controlled busy-loop results:

| Test | Result |
|---|---|
| 250ms sync busy loop, `resolution: 10` | histogram `maxMs ~= 241ms`, `p99Ms ~= 241ms`; independent timer gap also `~241ms` |
| 80ms sync busy loop, `resolution: 1` | histogram `maxMs ~= 79ms`, but p99 missed the isolated block |
| 80ms sync busy loop, `resolution: 10` | histogram `maxMs ~= 77ms`, `p99Ms ~= 77ms` in the short test window |
| 80ms sync busy loop, `resolution: 50` | histogram `maxMs ~= 77ms`, p95/p99 also caught it because sample count was small |

Takeaways for the spec:

- Include histogram `maxMs`; do not rely on p99 alone for isolated stalls.
- Use `resolution: 10` as the first production candidate.
- Reset the histogram each `system-vitals` window so the numbers describe the prior 30s.
- Keep the existing heartbeat/vitals gap detection, because no in-process histogram can emit the final sample if the process is pinned until SIGKILL.

---

## What We Cannot Conclude

### "op_appMessage_ms is sync CPU work"

It might not be. The timer wraps an `await`:

```ts
// bun-websocket.ts:807
const t0 = performance.now()
try {
  await userSession.handleAppMessage(ws as any, parsed)
} finally {
  operationTimers.addTiming("appMessage", performance.now() - t0)
}
```

`performance.now() - t0` is **wall-clock**. Includes all awaits inside `handleAppMessage`. If a handler does `await db.findOne(...)` for 200 ms, that 200 ms counts toward `op_appMessage_ms` even though the loop was free during the I/O.

Strong evidence that some of the time IS sync CPU:
- Staging 17:02 vitals didn't fire = loop genuinely blocked.

Strong counter-evidence that prod cascades were mostly NOT sync-CPU:
- Vitals fired throughout prod cascades (loop kept ticking).
- `op_audioProcessing_ms` (which IS sync work) stayed at normal levels — sync audio kept being scheduled.
- Zero `event-loop-lag` warnings across all 4 cascades.

So at minimum, prod cascades may be **async-bound degradation** (slow handlers awaiting on something) rather than CPU pinning. The staging cascade is the only one we have proof of actual loop blockage for, and that proof comes from a different signal (vitals gap), not from `op_appMessage_ms` itself.

### "Captions display requests are the cause"

Per-request analysis:

| Window | app_msg / 30s | Display req / 30s | ms per request |
|---|---|---|---|
| Cascade peak (16:59:41) | 1,425 ms | ~370 | ~3.9 ms |
| Cascade peak (17:00:11) | 1,467 ms | ~470 | ~3.1 ms |
| Now (22:17, healthy spike) | 1,347 ms | ~600 | ~2.2 ms |
| Now steady (22:21, healthy) | 177 ms | ~970 | ~0.18 ms |

Per-request handler time during the cascade was **~17× slower** than current healthy steady state. But staging right now has higher captions display volume than the cascade window had — and is healthy. Volume isn't the trigger; per-request slowness is.

We don't know what makes per-request handler time inflate from 0.18 ms to 3 ms. Could be GC pressure, app-server-side back-pressure, async resource contention, or a specific message type that's heavy.

### "The WS storm is caused by the load buildup"

The hypothesis is plausible: high `op_appMessage_ms` → loop busy → outbound WS pings delayed → multiple peers time out → cluster of 1006 closes. But:
- The 16:46 spike (`app_msg=2142 ms`) was larger than the 17:00:11 spike (`1467 ms`) and recovered cleanly with no WS storm.
- Spikes at 17:04 and 17:06 (post-restart) also didn't trigger storms.

So the storm doesn't follow simply from a single spike's magnitude. Either there's a cumulative threshold we can't see, or the storm is partly caused by an external network event we can't observe from inside the pod.

This is **the open question for [issue 106](../106-app-ws-storm-multi-app/)**.

---

## What Was Eliminated

| Hypothesis | Evidence against |
|---|---|
| Memory leak / OOM | Flat memory throughout. Container `Reason: Error`, not `OOMKilled`. Heap+external didn't grow during cascade lead-up. The 104 soniox fix is in production and continues to hold. |
| Wide audio fan-out | Zero `slow-audio-fanout` events in 30 min before staging cascade. Subscriber counts in normal range. |
| Single pathological audio call | Zero `slow-audio-call` events (50 ms threshold on the per-batch UDP handler). |
| MongoDB blocking | `mongoTotalBlockingMs` steady at ~150 ms per 30s. Not anomalous during cascades. |
| Reorder-buffer batch flush | `slow-audio-call` would have caught it. Didn't fire. |
| lc3Decode WASM execution | Caught by Phase 1 substage timer but the slowness is in the JS wrapper around the WASM call (alloc, GC interrupts), not the call itself. The WASM is fast. |
| AKS node maintenance / cluster event | All 4 cascades happened without a cluster-event signature (no simultaneous staging/dev/debug restart). The 2026-05-01 12:01 restart WAS a cluster event and is excluded from this analysis. |
| Raw Bun WS close/reconnect storm alone | Local Bun WS harness closed/reconnected 112–168 sockets simultaneously without meaningful heartbeat gaps. A storm needs additional sync work or another trigger to become fatal. |
| Large `op_appMessage_ms` as proof of sync CPU | Local Mentra-path harness produced 69–92s aggregate reconnect wall-time with async DB-like delays while heartbeat gaps stayed ~11–12ms. `op_appMessage_ms` is wall-clock, not CPU. |
| Exit 137 means shutdown handler is missing | Staging code already has a SIGTERM handler with synchronous stderr logs. Kube/Porter data plus absent shutdown logs instead suggests the loop was too pinned to run the handler before SIGKILL. |
| Staging WS storm as universal prod trigger | W4 prod back-test did not find staging-scale simultaneous 1006 storms in the three prior prod cascade windows. The storm is staging-proven, prod-unproven. |

---

## Why Existing Telemetry Has Reached Its Limit

To progress further on what's actually slow about app-message handlers during cascade conditions, the missing pieces are:

1. **Per-message-type op timer breakdown.** We currently have `op_appMessage_ms` as one bucket for all 20+ message types (subscription_update, display_request, dashboard_*, photo_request, audio_*, location_*, stream_*, etc.). The 7,616 ms peak could be 95% display_request or 95% subscription_update — we can't tell.
2. **Slow-handler outlier warnings**, same shape as `slow-audio-stage`. When a single `handleAppMessage` call exceeds N ms, log `{feature: "slow-app-message", messageType, packageName, userIdHash, durationMs}`. Catches the specific call that was slow, not just the aggregate window.
3. **Sync-vs-async time split per handler.** Bracket each `await` in the handler chain to measure pure sync segments. Definitively answers whether the cascade is CPU pinning or async wait pile-up.
4. **Always-emit event-loop-lag samples in every vitals.** Currently only emitted as a warning when >100 ms. If we always emit (current/avg/p99 from the rolling window), we can see if the loop is actually pinned during spikes that fall short of the warning threshold.
5. **WS close categorization.** Distinguish "we received a close frame from peer" (peer initiated), "TCP RST" (network), "ping timeout from our side" (we failed to keep the connection alive), and "we initiated close." Tells us whether 1006 closes are external (network/peer) or self-induced (our pod missing pings).

Items 1–4 are scoped in [spec.md](./spec.md).
Item 5 is the focus of [106](../106-app-ws-storm-multi-app/).

---

## Cloud-Debug Validation

Phase-1.5 is deployed to `cloud-debug` from branch `cloud/issue-106`.

What passed on 2026-05-05:

- Cloud package build passed.
- Cloud package test suite passed: 6 suites, 6 passed.
- GitHub Actions `porter-debug.yml` deployed commit `316e7db0a8c39631b801d779789b220e51dc3151`.
- Kubernetes rollout completed; `cloud-debug-cloud` is `1/1 Running` with zero restarts.
- `https://debug.augmentos.cloud/livez` returned `ok`.
- Pod logs and BetterStack show `process-lifecycle` startup and `event-loop-delay-histogram` startup.
- BetterStack hot table `remote(t373499_mentracloud_prod_logs)` shows new `system-vitals` fields: `eventLoopDelayMaxMs`, `eventLoopDelayP99Ms`, and `eventLoopDelayMeanMs`.
- Synthetic `/app-ws` reconnect smoke used `com.mentra.captions.debug`, not production captions.
- The smoke produced `feature: "app-ws-close"` with `packageName`, `userIdHash`, close code/reason, inferred close source, and send counters.
- The same smoke produced the expected vitals counter: `appProtocol_reconnect_count = 1` and `op_appProtocol_reconnect_ms = 17`.
- A pre-existing raw API-key debug log was removed; BetterStack confirmed the synthetic key was not present in the new log row.

Soak is still ongoing. The next useful signal is either a natural cloud-debug/staging cascade or a controlled reconnect/subscription storm against cloud-debug.

## Open Follow-Ups

- [x] Ship Phase-1.5 instrumentation on `cloud/issue-106`.
- [x] Deploy to cloud-debug and smoke-test BetterStack ingestion.
- [ ] Soak on cloud-debug before staging.
- [ ] After staging deploy, wait for next staging cascade (rate is ~daily). Re-analyze with new data.
- [ ] Investigate 106 in parallel: does the multi-app simultaneous-1006 pattern correlate with anything observable from the pod side, or is it a network/Cloudflare/k8s-service-mesh signal?
- [ ] Set up BetterStack alert on `feature: "slow-app-message"` (once it exists) with reasonable threshold to capture cascades in real time. The `s3Cluster(...)` historical table preserves data anyway, but a real-time alert lets us pull live diagnostics (heap snapshot, per-session state) before restart.

## Where to use the runbook insight

A self-criticism I want to capture for next time: my early queries against the cascade window used `remote(t373499_mentracloud_prod_logs)` (hot tier, ~1h retention) and concluded that pre-cascade diagnostic events had aged out. The runbook ([cloud/tools/bstack/runbooks/weekly-error-audit.md](../../tools/bstack/runbooks/weekly-error-audit.md)) explicitly documents that the historical table `s3Cluster(primary, t373499_mentracloud_prod_s3) WHERE _row_type = 1` has full retention. Using the right table from the start would have surfaced the data hours earlier.

**Going forward: any cascade investigation more than ~30 minutes old should use the s3Cluster historical table.**
