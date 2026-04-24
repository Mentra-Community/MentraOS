# Spec: Cloud Pod Event-Loop Stall Cascade — Phase 1 Observability (Revised)

## Overview

**What this doc covers:** The exact behavior changes that ship in the first PR for issue 102. Phase 1 is **observability only** — no behavior changes, no fixes. The goal is to land enough instrumentation that one more crash cycle gives us definitive answers about the trigger and the specific audio substage that monopolizes the loop. Phase 2 (the actual fix) will be specified in a separate PR after Phase 1 data lands.

**Why this doc exists:** Three prior diagnoses of these crashes were confidently wrong (see [spike.md](./spike.md)). The fourth would likely also be wrong without disambiguating data. Spending one cycle on instrumentation before designing the fix is strictly faster than shipping a guess that turns out to address nothing.

**What you need to know first:**

- [spike.md](./spike.md) — original investigation and evidence
- [spike-independent-2026-04-23.md](./spike-independent-2026-04-23.md) — second independent investigation that found UDP/audio continued running while HTTP/timers were starved (the failure is event-loop _monopolization_, not freeze)
- [implementation-review-2026-04-23.md](./implementation-review-2026-04-23.md) — Codex's review of the original Phase 1 draft. This spec incorporates all of its blocking and non-blocking points.

**Who should read this:** PR reviewers. Cloud engineers who will analyze the next crash with the new logs.

---

## The Problem in 30 Seconds

us-central is crashing daily. The most recent crash (2026-04-23 23:34 UTC, restart #5) had:

- An 80.7s `event-loop-gap` log (timer expected at 1s, fired 80.7s late)
- Almost all op_total during that window in `op_audioProcessing_ms`
- HTTP request logs went silent for ~80s while UDP/audio logs continued
- ~96 UDP packets/sec processed pod-wide during the starved window
- ~10 mic-active sessions; no single-user storm

This is event-loop _monopolization_ by UDP/audio, not a complete freeze. K8s liveness on `/livez` times out (because HTTP can't be scheduled), pod is killed.

The existing telemetry cannot answer:

- Which audio substage burns the time (LC3 decode, app fan-out, transcription feed, translation feed, microphone update)?
- What pod-level UDP load corresponds to the dangerous regime?
- When did the cascade _start_ (the gap log timestamp is the recovery moment)?

Phase 1 instruments to answer all three.

---

## Spec

### S1. Slow UDP audio handler / batch duration log

**File:** `cloud/packages/cloud/src/services/udp/UdpAudioServer.ts`

**Before:** `handleAudioPacket` wraps its for-loop with `operationTimers.addTiming("audioProcessing", ...)` which only records cumulative wall-time across all calls in a 30s vitals window. Individual call durations are not visible.

**After:** Same outer cumulative timer (preserved for vitals), plus an inline check: when one **handler invocation** (which processes a batch of 1+ packets from the reorder buffer) takes longer than `SLOW_AUDIO_CALL_MS` (default 50ms), log a structured warning.

```
{
  feature: "slow-audio-call",
  durationMs: <number>,
  packetsToProcess: <length>,    // batch size; 1 in normal operation, larger after reorder-buffer flush
  userIdHash: <number>,
  activeSessions: <count>,
  rssMB: <number>,
}
```

Note: the timer brackets one handler invocation (the for-loop over the reorder buffer's flushed packets), **not one packet**. `packetsToProcess` is the batch size so investigators can distinguish "one expensive packet" from "many ordinary packets in a flushed batch."

50ms threshold rationale: steady-state op_audioProcessing is ~400ms / 30s ÷ ~3500 calls ≈ 115μs per call. 50ms is ~400× normal — clear outlier without being so tight that it floods logs in steady state.

**Net effect:** answers questions like "is one packet pathologically slow?" (high duration, low packetsToProcess) vs "is the reorder buffer flushing big batches?" (high duration, high packetsToProcess).

### S2. Audio substage timings inside `processAudioData`

**File:** `cloud/packages/cloud/src/services/session/AudioManager.ts`

**Before:** `processAudioData` is one black box. We know the cumulative time but not which of LC3 decode, fan-out, transcription feed, translation feed, or microphone update consumes it.

**After:** Insert per-substage timers inside `processAudioData`. Two outputs per substage:

1. **Cumulative timer** added to `operationTimers` so vitals emits `op_audio_<stage>_ms` per 30s window:
   - `op_audio_lc3Decode_ms` (only emits when audioFormat=lc3)
   - `op_audio_appFanout_ms`
   - `op_audio_transcriptionFeed_ms`
   - `op_audio_translationFeed_ms`
   - `op_audio_microphoneUpdate_ms`

2. **Outlier warning**: when any single substage call exceeds `SLOW_AUDIO_STAGE_MS` (default 10ms), log:
   ```
   {
     feature: "slow-audio-stage",
     stage: "lc3Decode" | "appFanout" | "transcriptionFeed" | "translationFeed" | "microphoneUpdate",
     durationMs: <number>,
     userIdHash: <number>,    // privacy-preserving correlation key
     bytes: <buffer length>,
   }
   ```

The 10ms per-substage threshold is conservative: each substage is sub-millisecond in steady state. A 10ms substage call is ~10× normal — caught early, not so tight as to flood.

**Net effect:** the next crash answers "which substage burns the time" by reading op*audio*\*\_ms in vitals, and "which calls were the worst" by reading slow-audio-stage warnings. This is the highest-value addition — it directly determines what Phase 2 fixes.

### S3. Slow audio fan-out warning (with correlation key)

**File:** `cloud/packages/cloud/src/services/session/AudioManager.ts`

**Before:** No fan-out instrumentation.

**After:** Wrap `relayAudioToApps` with a timer; warn when slow OR fan-out is high:

```
{
  feature: "slow-audio-fanout",
  durationMs: <number>,
  subscribers: <length>,
  bytes: <buffer length>,
  userIdHash: <number>,    // matches S1 and S2 keys for cross-log correlation
}
```

Thresholds: `SLOW_RELAY_MS = 20`, `FANOUT_WARN = 10` subscribers.

**Net effect:** distinguishes "fan-out blowup" hypothesis (many subs per session OR slow per-sub `connection.send()`). Includes the correlation key explicitly demanded by Codex's review (the original implementation omitted it).

### S4. Heartbeat tick at 500ms with `gapStartedAtMs`

**File:** `cloud/packages/cloud/src/services/metrics/SystemVitalsLogger.ts`

**Before:** Loop-liveness is monitored via the existing 1s/2s gap detector. That misses sub-2s hiccups (which may be the leading edge of a cascade) and its log timestamp is when the timer callback eventually fires — i.e., the _recovery_ moment, not the _trigger_ moment.

**After:** Add a 500ms `setInterval` that records the tick time. When the next tick fires more than `HEARTBEAT_GAP_THRESHOLD_MS` (default 1000ms) late, log:

```
{
  feature: "heartbeat-gap",
  gapMs: <elapsed - HEARTBEAT_INTERVAL_MS>,
  expectedMs: 500,
  actualMs: <elapsed>,
  gapStartedAtMs: <Date.now() - elapsed>,    // approximate trigger time, not log time
  rssMB: <number>,
  activeSessions: <count>,
}
```

`gapStartedAtMs` is critical: without it, investigators reading the heartbeat-gap entry will look at logs immediately preceding the **log timestamp** (which are recovery flush logs), not logs preceding the **trigger** (which are what caused the cascade). With `gapStartedAtMs`, the query for "what was happening at trigger time" is correct.

**Net effect:** finer trigger-moment resolution + investigators can find the actual leading cause without reading the wrong log window.

### S5. logVitals self-timing

**File:** `cloud/packages/cloud/src/services/metrics/SystemVitalsLogger.ts`

**Before:** `logVitals()` itself isn't timed. If the per-session memory census takes seconds, that IS the trigger and we wouldn't know.

**After:** Wrap `logVitals` body in `performance.now()` brackets. Always log `{feature: "vitals-self-timing", durationMs}` at info level. Warn if duration > `VITALS_SELF_SLOW_MS` (default 500ms).

**Important** (per Codex review): use the session count already captured at the top of `logVitals` for the log payload — do **not** call `UserSession.getAllSessions()` a second time in the finally block. The whole point is to measure logVitals' real cost; adding a second session scan in the measurement path itself adds noise.

**Net effect:** rules vitals-as-trigger in or out without polluting its own measurement.

### S6. Pod-level UDP counters in vitals

**File:** `cloud/packages/cloud/src/services/metrics/SystemVitalsLogger.ts` (read), `cloud/packages/cloud/src/services/udp/UdpAudioServer.ts` (expose)

**Before:** UdpAudioServer's packet counters (`packetsReceived`, `packetsDropped`, etc.) only appear in the periodic "UDP audio stats" log every 100 packets. Hard to correlate with vitals windows.

**After:** Each 30s vitals row includes:

- `udpPacketsReceivedDelta` — packets received this 30s window
- `udpPacketsDroppedDelta` — packets dropped this window
- `udpPacketsDecryptedDelta` — packets decrypted this window
- `udpDecryptionFailuresDelta` — decryption failures this window
- `udpRegisteredSessions` — current count of UDP-registered sessions

Implementation: `UdpAudioServer` exposes `getStatsSnapshot()` returning current counter values + active session count. `SystemVitalsLogger` keeps the previous snapshot and computes the delta each window.

**Net effect:** quantifies the regime where the cascade fires. Per the independent spike, dangerous load was ~96 pkt/s pod-wide with ~70 sessions; Phase 1 confirms or refines that threshold.

### S7. Natural GC observer — REMOVED from Phase 1

**Status:** Cut. Codex tested locally and confirmed Bun's `PerformanceObserver.supportedEntryTypes` returns `["mark","measure","resource"]` — `"gc"` is **not** supported. A Node-style observer would silently emit nothing, which is worse than not having it: post-deploy silence would look like "no natural GC pauses" when it really means "instrumentation is broken in this runtime."

**If we keep an observer at all** (optional): gate it behind a runtime check. If `gc` is not in `supportedEntryTypes`, log `{feature: "natural-gc-unsupported"}` once at startup and don't install. Otherwise install normally. This way the absence of natural-gc data is itself an explicit signal.

**For real natural-GC visibility**, a follow-up needs a Bun/JSC-specific mechanism (e.g., periodic `bun:jsc.heapStats()` snapshots and inferring GC from heap deltas). Out of scope for Phase 1.

### S8. K8s probe widening — separate change, with documented tradeoffs

**File:** Helm/Porter probe configuration (handled outside this PR).

Per Codex's review: probe widening is **not a harmless band-aid**; it changes the user-visible failure mode. Specifically:

- **Liveness** widening (`failureThreshold 15 → 30`, `timeoutSeconds 3 → 10`): pod takes longer to be killed/restarted. Reasonable tradeoff for Phase 1 — gives us survivable window for the cascades we observe today.
- **Readiness** widening: keeps a stalled pod in the LB rotation longer. On single-pod us-central, when readiness fails the user sees a brief nginx 503 (which currently fires the BetterStack incident). When readiness succeeds despite the pod being stalled, the user sees **hung HTTP requests** instead. Both are bad on single-pod; **only multi-pod actually fixes this**.

Recommended approach for Phase 1: **widen liveness only, leave readiness tight.** Then a stalled pod still gets removed from the LB quickly (visible as a 503 burst, monitorable), but doesn't get restarted on every 80s gap (fewer churn cycles to investigate per day).

This change is applied via Porter UI separately from the code PR. Operator should:

1. Land code PR (S1-S6)
2. Verify logs in one quiet region
3. Apply liveness widening to us-central
4. Document explicitly: "we are accepting longer 503 bursts in exchange for fewer restarts; resolve permanently via Phase 2 + multi-pod."

### S9. No actual fix in Phase 1

Explicitly out of scope for this PR:

- UDP backpressure (might be the right fix; we don't know yet)
- `setImmediate` yield in audio drain (same)
- Capping subscribers per session (same)
- Any other behavioral change

Adding any of these without the data could mask the real cause and make Phase 2 diagnosis harder.

---

## Non-Goals

- **Identifying the trigger in this PR.** That happens after Phase 1 lands and one more crash cycle gives us logs.
- **Multi-pod deployment.** Eventual fix via the cloud scaling plan; blocked today by single-pod assumptions in the architecture (see spike.md). This issue stabilizes single-pod _until_ the scaling plan lands.
- **Vertical scaling.** Tactical option that buys headroom without addressing the cascade mechanism. Worth doing in parallel; not a substitute.
- **Replacing pino with sync logger.** Async buffering loses logs near death; nice to fix but not required for this investigation since S4 (heartbeat) gives us the trigger timestamp via `gapStartedAtMs`.
- **Fixing PR #2592's mobile reconnect storm.** Separate workstream (issue 101). Reduces _background_ load but is not a per-crash trigger per spike.md.
- **Working natural-GC observer.** Cut from Phase 1; needs Bun-specific mechanism in a follow-up.

---

## Decision Log

| Decision                                                         | Alternatives considered                               | Why we chose this                                                                                                                                                                                        |
| ---------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ship instrumentation only in Phase 1                             | Ship UDP backpressure / yielding / subscriber cap now | Three prior diagnoses were wrong. Without disambiguating data, the fourth is also a guess. Cost of one extra deploy cycle is < cost of shipping wrong fix and re-investigating.                          |
| Add per-substage audio timing (S2)                               | Keep just the cumulative `op_audioProcessing_ms`      | Without substage breakdown, the next crash returns "audio = 80s" again and we still can't choose Phase 2. This is the highest-value addition per Codex's review.                                         |
| 10ms per-substage threshold                                      | 5ms, 50ms                                             | Substages are sub-millisecond in steady state. 10ms = 10× normal — caught early without being so tight it floods steady-state logs.                                                                      |
| Per-call audio at 50ms                                           | 10ms, 200ms                                           | 50ms is ~400× the steady-state per-call duration. Catches all real anomalies, doesn't flood.                                                                                                             |
| Heartbeat at 500ms with `gapStartedAtMs`                         | Match existing 1s/2s gap detector                     | The existing detector misses 1-2s hiccups AND its timestamp is recovery time, not trigger time. 500ms catches the leading edge; `gapStartedAtMs` makes the log self-explain when the cascade started.    |
| `logVitals` self-timing always logged at info                    | Only log on slow                                      | Want a baseline distribution; if it stays under 50ms in days of logs we can rule out vitals as trigger.                                                                                                  |
| Reuse session count in vitals self-timing finally block          | Re-call `getAllSessions()`                            | Per Codex: the whole point of S5 is to measure logVitals' real cost. Adding a second `getAllSessions()` in the measurement path itself adds noise.                                                       |
| Cut natural-GC observer (S7)                                     | Ship it as written; ship behind support check         | Codex confirmed Bun doesn't support the `gc` entryType. Shipping silently-broken instrumentation is worse than not shipping it; investigators would misread silence as "no GC pauses."                   |
| Widen liveness only, not readiness                               | Widen both                                            | Per Codex: readiness widening keeps a stalled pod in LB rotation, surfacing as user-visible hangs instead of 503 bursts. On single-pod that's strictly worse. Only widen liveness until multi-pod lands. |
| K8s probe widening as a separate change                          | Bundle with code                                      | Probe config is platform-level (Helm/Porter), different review path, different rollback. Bundling risks making the observability hard to roll out cleanly.                                               |
| Add UDP delta counters to vitals (S6)                            | Read from existing periodic UDP audio stats logs      | Vitals already aggregates per 30s and is the natural correlation point. Periodic UDP stats fire every 100 packets, not on a wall-clock interval — hard to align with vitals windows.                     |
| Privacy-preserving `userIdHash` (not raw `userId`) on audio logs | Raw userId                                            | Existing UDP path already uses userIdHash; matching that key avoids logging raw user IDs in slow-call/stage/fanout entries.                                                                              |

---

## Testing

### Local

1. `bun run lint` passes
2. `bun run typecheck` passes
3. `bun run test` passes (no behavior changes; existing tests should be unaffected)
4. `bun run dev` boots the cloud locally; verify on startup logs:
   - `vitals-self-timing` (info) appears every ~30s
   - Either "Natural GC observer started" OR "natural-gc-unsupported" (depending on runtime)
   - No `heartbeat-gap` warnings under idle dev (would indicate spurious detection)
   - No `slow-audio-call` / `slow-audio-stage` / `slow-audio-fanout` under idle dev

### Smoke (one quiet region first)

Deploy to us-east (currently 0 sessions). After 30 minutes:

```sql
SELECT JSONExtract(raw,'feature','Nullable(String)') as f, count() as n
FROM remote(t373499_mentracloud_prod_logs)
WHERE dt >= now() - INTERVAL 30 MINUTE
  AND JSONExtract(raw,'region','Nullable(String)')='us-east'
  AND JSONExtract(raw,'feature','Nullable(String)') IN
    ('vitals-self-timing','heartbeat-gap','slow-audio-call','slow-audio-stage',
     'slow-audio-fanout','natural-gc','natural-gc-unsupported')
GROUP BY f ORDER BY n DESC
```

Expected:

- `vitals-self-timing` ≈ 60 entries (one per 30s, 30 min)
- `heartbeat-gap` ≈ 0
- `slow-audio-call` / `slow-audio-stage` / `slow-audio-fanout` ≈ 0
- Either `natural-gc` (if Bun version supports) OR `natural-gc-unsupported` (one entry at startup)

If anything spurious fires under steady state, tune thresholds in a follow-up before rolling to us-central.

### Acceptance after one us-central crash

Query the 90 seconds before the trigger time (`gapStartedAtMs` from the heartbeat log):

```sql
-- Replace <TRIGGER_TIME> with the gapStartedAtMs from the heartbeat-gap log
SELECT dt, JSONExtract(raw,'feature','Nullable(String)') AS feat,
            JSONExtract(raw,'stage','Nullable(String)') AS stage,
            JSONExtract(raw,'durationMs','Nullable(Float64)') AS ms,
            JSONExtract(raw,'gapMs','Nullable(Float64)') AS gap,
            JSONExtract(raw,'gapStartedAtMs','Nullable(Int64)') AS gap_start,
            JSONExtract(raw,'packetsToProcess','Nullable(Int32)') AS pkts,
            JSONExtract(raw,'subscribers','Nullable(Int32)') AS subs,
            JSONExtract(raw,'userIdHash','Nullable(Int64)') AS uid_hash
FROM remote(t373499_mentracloud_prod_logs)
WHERE dt >= '<TRIGGER_TIME-90s>' AND dt <= '<TRIGGER_TIME+5s>'
  AND JSONExtract(raw,'region','Nullable(String)')='us-central'
  AND JSONExtract(raw,'feature','Nullable(String)') IN
    ('heartbeat-gap','slow-audio-call','slow-audio-stage','slow-audio-fanout',
     'vitals-self-timing','event-loop-gap')
ORDER BY dt
```

Use the results to answer:

1. **Trigger moment** (S4): the first `heartbeat-gap` entry's `gapStartedAtMs` tells us when. What was logged in the 5-10s before that timestamp?
2. **Which substage** (S2): what does `slow-audio-stage` show? Are entries dominated by one stage (`lc3Decode`, `appFanout`, `transcriptionFeed`, etc.)? What does op*audio*\*\_ms show in the post-recovery vitals row?
3. **Cascade vs pathological** (S1): many `slow-audio-call` entries with low `packetsToProcess` and moderate durations? Or one with multi-second duration? Or any with very high `packetsToProcess` (reorder-buffer flush)?
4. **Fan-out** (S3): any `slow-audio-fanout` entries with `subscribers > 10` near the trigger? Same `userIdHash` as a `slow-audio-call`?
5. **UDP load** (S6): what was `udpPacketsReceivedDelta` and `udpRegisteredSessions` in the vitals window before the cascade?
6. **Vitals as trigger** (S5): any `vitals-self-timing` entries > 500ms in the 60s before the trigger?

Each answered question narrows Phase 2's scope. After one crash cycle, we should be able to point to a specific substage + load condition and design the actual fix.

---

## Rollout

1. Branch `cloud/pod-loop-stall-cascade` off `dev`. Done.
2. PR S1-S6 to `dev`.
3. Deploy to us-east. Validate baselines per Smoke section above.
4. Deploy to us-central with S8 (liveness widening only) applied separately via Porter dashboard.
5. Wait for next us-central crash (typically <12 hours).
6. Analyze logs per Acceptance section.
7. Open Phase 2 PR with the actual fix, scoped by the data.

---

## Key Numbers

| Metric                                  | Today                                             | After Phase 1 (expected)                                                        |
| --------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------- |
| Visibility into trigger moment          | Gap detector log timestamps recovery, not trigger | 500ms-resolution `gapStartedAtMs` in heartbeat log                              |
| Visibility into per-call audio duration | 0 (only cumulative)                               | All handler invocations > 50ms logged with batch size + userIdHash              |
| Visibility into audio substages         | 0 (one black box)                                 | Per-substage cumulative timers in vitals + outliers > 10ms warned               |
| Visibility into fan-out impact          | 0                                                 | All fan-outs > 20ms or > 10 subs logged with userIdHash for correlation         |
| Visibility into pod-level UDP load      | Only periodic 100-packet stats                    | Per-vitals-window deltas (received, dropped, decrypted, fail) + active sessions |
| Visibility into natural GC              | 0 (only forced)                                   | Either real `natural-gc` logs OR explicit `natural-gc-unsupported` startup log  |
| K8s liveness threshold                  | 75s blockage                                      | ~300s blockage (only after S8 applied)                                          |
| Crash frequency on us-central           | Daily                                             | Should decrease (S8 band-aid only); root cause still pending Phase 2            |
