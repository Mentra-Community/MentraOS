# Spike Addendum: Independent Investigation of us-central Loop Starvation

## Overview

This is a second, independent spike for issue 102. It was written after re-running
the investigation directly against Porter and BetterStack instead of relying on the
previous AI SRE narrative or the first `spike.md`.

The short version:

- The newest us-central restart was a liveness-probe kill, not OOM.
- `/livez` timed out, so the HTTP/timer side of the process was starved.
- BetterStack recorded an 80.7s event-loop gap.
- The corresponding `system-vitals` row attributed almost all blocked operation
  time to `op_audioProcessing_ms`.
- MongoDB slow-query spikes are mostly recovery artifacts, not the initiating cause.
- The process was not frozen solid: UDP/audio logs continued while HTTP logs
  disappeared. The better model is "UDP/audio callbacks monopolized the event
  loop enough to starve HTTP probes and timers."

This addendum corrects one important overstatement in the first spike: the event
loop was not completely unable to execute JavaScript for 80 seconds. It was unable
to schedule the liveness/readiness HTTP handlers and timer callbacks in time,
while the UDP/audio path continued to run.

## Tools Used

All queries were read-only.

- Porter CLI for Kubernetes pod state and events:

```bash
porter kubectl --cluster 4689 -- describe pod -n default cloud-prod-cloud-7b9847b4d9-npg5d
```

- Repo BetterStack CLI with credentials supplied by Doppler:

```bash
doppler run --project mentra-sre --config dev -- bun cloud/tools/bstack/bstack.ts ...
```

- `bstack sql` raw ClickHouse queries against:

```sql
s3Cluster(primary, t373499_mentracloud_prod_s3)
```

Region filter:

```sql
JSONExtract(raw,'region','Nullable(String)')='us-central'
```

## Incident Re-Checked

The investigation focused on the freshest restart visible at the time:

| Field              | Value                               |
| ------------------ | ----------------------------------- |
| Pod                | `cloud-prod-cloud-7b9847b4d9-npg5d` |
| Region             | `us-central`                        |
| Container finished | `2026-04-23 23:34:29 UTC`           |
| Restart count      | `5`                                 |
| Exit code          | `137`                               |
| Container reason   | `Error`                             |
| Memory limit       | `4096M`                             |
| RSS before kill    | about `704MB`                       |

Porter events for the same pod showed both probes failing:

- `Readiness probe failed: Get "http://10.78.0.170:80/health": context deadline exceeded`
- `Liveness probe failed: Get "http://10.78.0.170:80/livez": context deadline exceeded`
- `Container cloud-prod-cloud failed liveness probe, will be restarted`

This proves the immediate Kubernetes mechanism: the pod was killed because
`/livez` did not respond within the liveness threshold. Since `/livez` is a
literal `c.text("ok")`, a timeout there means the HTTP handler could not get
scheduled promptly. It does not implicate MongoDB or `/health` work.

## Proof 1: Event-Loop Gap at the Kill

Query:

```bash
doppler run --project mentra-sre --config dev -- bun cloud/tools/bstack/bstack.ts sql "
SELECT
  dt,
  JSONExtract(raw,'gapMs','Nullable(Float64)') AS gap_ms,
  JSONExtract(raw,'actualMs','Nullable(Float64)') AS actual_ms,
  JSONExtract(raw,'rssMB','Nullable(Float64)') AS rss_mb,
  JSONExtract(raw,'activeSessions','Nullable(Int32)') AS sessions
FROM s3Cluster(primary, t373499_mentracloud_prod_s3)
WHERE _row_type=1
  AND dt >= '2026-04-23 23:20:00'
  AND dt <= '2026-04-23 23:36:00'
  AND JSONExtract(raw,'region','Nullable(String)')='us-central'
  AND JSONExtract(raw,'feature','Nullable(String)')='event-loop-gap'
ORDER BY dt"
```

Result:

| dt                           |  gap_ms | actual_ms | rss_mb | sessions |
| ---------------------------- | ------: | --------: | -----: | -------: |
| `2026-04-23 23:34:26.882000` | `79739` |   `80739` |  `704` |     `71` |

This proves a timer callback expected every 1s ran about 80.7s after its previous
tick. The pod was not killed because memory hit the container limit: RSS was only
about 704MB against a 4096MB limit.

## Proof 2: Vitals Attribute the Starved Window to Audio Processing

Query:

```bash
doppler run --project mentra-sre --config dev -- bun cloud/tools/bstack/bstack.ts sql "
SELECT
  dt,
  JSONExtract(raw,'rssMB','Nullable(Float64)') AS rss,
  JSONExtract(raw,'heapUsedMB','Nullable(Float64)') AS heap,
  JSONExtract(raw,'activeSessions','Nullable(Int32)') AS sessions,
  JSONExtract(raw,'op_audioProcessing_ms','Nullable(Float64)') AS audio_ms,
  JSONExtract(raw,'op_appMessage_ms','Nullable(Float64)') AS app_ms,
  JSONExtract(raw,'opTotalMs','Nullable(Float64)') AS total_ms,
  JSONExtract(raw,'opBudgetUsedPct','Nullable(Float64)') AS budget_pct
FROM s3Cluster(primary, t373499_mentracloud_prod_s3)
WHERE _row_type=1
  AND dt >= '2026-04-23 23:20:00'
  AND dt <= '2026-04-23 23:36:00'
  AND JSONExtract(raw,'region','Nullable(String)')='us-central'
  AND JSONExtract(raw,'feature','Nullable(String)')='system-vitals'
ORDER BY dt"
```

Key rows:

| dt                        | sessions | audio_ms | app_ms | total_ms | budget_pct |
| ------------------------- | -------: | -------: | -----: | -------: | ---------: |
| `2026-04-23 23:32:24.908` |     `71` |    `345` |   `35` |    `414` |        `1` |
| `2026-04-23 23:32:54.920` |     `71` |    `319` |  `429` |    `781` |        `3` |
| `2026-04-23 23:34:27.109` |     `71` |  `80118` |   `20` |  `80153` |      `267` |
| `2026-04-23 23:35:01.462` |      `1` |     null |   `12` |     `13` |        `0` |

The `23:34:27.109` row is the first vitals row after the delayed timer fires.
Nearly all accumulated measured operation time in that interval is
`op_audioProcessing_ms`.

This does not yet prove which substage inside audio is slow. The current code
wraps the `UdpAudioServer` call into `session.audioManager.processAudioData(...)`.
That includes, depending on session state:

- LC3 decode
- app audio fan-out
- transcription `feedAudio`
- translation `feedAudio`
- microphone activity update

The existing cumulative timer cannot distinguish those substages.

## Proof 3: MongoDB Was Not the Initiating Cause

Slow-query counts before the starved window were ordinary for this pod. The huge
MongoDB durations appear only at recovery time, when delayed callbacks all flush
after the loop becomes schedulable again.

Query shape:

```bash
doppler run --project mentra-sre --config dev -- bun cloud/tools/bstack/bstack.ts sql "
SELECT
  toStartOfInterval(dt, INTERVAL 30 SECOND) AS bucket,
  count() AS logs,
  countIf(JSONExtract(raw,'feature','Nullable(String)')='slow-query') AS slow_queries,
  max(JSONExtract(raw,'durationMs','Nullable(Float64)')) AS max_slow_ms
FROM s3Cluster(primary, t373499_mentracloud_prod_s3)
WHERE _row_type=1
  AND dt >= '2026-04-23 23:20:00'
  AND dt <= '2026-04-23 23:36:00'
  AND JSONExtract(raw,'region','Nullable(String)')='us-central'
GROUP BY bucket
ORDER BY bucket"
```

Key rows:

| bucket                |   logs | slow_queries | max_slow_ms |
| --------------------- | -----: | -----------: | ----------: |
| `2026-04-23 23:32:30` | `1768` |          `5` |     `162.8` |
| `2026-04-23 23:33:00` |  `636` |          `2` |     `110.5` |
| `2026-04-23 23:33:30` |   `57` |          `0` |        null |
| `2026-04-23 23:34:00` | `3575` |         `31` |   `81560.8` |
| `2026-04-23 23:34:30` |  `259` |         `10` |     `355.7` |

The 81.5s slow-query max in the `23:34:00` bucket aligns with the event-loop gap.
That is consistent with query callbacks being delayed behind the event-loop
starvation, not with Atlas suddenly taking 81.5s and causing `/livez` to time out.

## Proof 4: UDP/Audio Continued While HTTP Disappeared

This is the key refinement over the first spike.

Per-second log counts around the incident:

| second                        |              logs |       udp_server |        audio_mgr | http | vitals |
| ----------------------------- | ----------------: | ---------------: | ---------------: | ---: | -----: |
| `23:33:00`                    |              `59` |              `1` |              `2` |  `9` |    `0` |
| `23:33:01`                    |             `110` |              `1` |              `2` |  `3` |    `0` |
| `23:33:02`                    |             `110` |              `4` |              `4` | `10` |    `0` |
| `23:33:06`                    |              `25` |              `4` |              `5` |  `3` |    `0` |
| `23:33:07`                    |               `8` |              `5` |              `1` |  `0` |    `0` |
| `23:33:08` through `23:34:25` | usually `1-4`/sec | mostly UDP/audio | mostly UDP/audio |  `0` |    `0` |
| `23:34:26`                    |              `34` |              `3` |              `4` |  `0` |    `1` |
| `23:34:27`                    |            `3087` |             `10` |              `7` | `64` |    `3` |

Interpretation:

- HTTP request logs vanish after about `23:33:06`.
- UDP/audio logs continue throughout the starvation window.
- Timer-based vitals and event-loop-gap logs only appear at recovery.
- HTTP logs burst again after recovery.

So the event loop was not literally executing no JavaScript. It was spending its
schedulable time in UDP/audio work, starving timers and HTTP long enough for K8s
liveness to kill the container.

## Proof 5: UDP Packet Counters Advanced During Starvation

UDP server stats log every 100 received packets. During the HTTP-starved window,
the pod-level UDP packet counter continued increasing.

Selected rows:

| dt                        | packetsReceived | activeSessions |
| ------------------------- | --------------: | -------------: |
| `2026-04-23 23:33:06.007` |       `1237300` |           `69` |
| `2026-04-23 23:33:20.111` |       `1238500` |           `69` |
| `2026-04-23 23:33:40.707` |       `1240600` |           `69` |
| `2026-04-23 23:34:00.077` |       `1242400` |           `69` |
| `2026-04-23 23:34:20.007` |       `1244200` |           `69` |
| `2026-04-23 23:34:26.875` |       `1245000` |           `69` |

This is about 7,700 UDP packets processed between `23:33:06` and `23:34:26`.
That is roughly 96 packets/sec pod-wide.

Per-user audio manager stats show no single user owns the entire incident. Around
ten users each logged 100-packet increments every roughly 8-11 seconds. The
pattern looks like aggregate audio load across many mic-active sessions, not one
obvious single-user storm.

## Proof 6: GC Probe Does Not Explain the 80s Stall

GC probe rows before the kill were around 110-140ms, not seconds:

| dt                        |   gc_ms | rss_mb | sessions |
| ------------------------- | ------: | -----: | -------: |
| `2026-04-23 23:31:54.640` | `139.9` |  `700` |     `72` |
| `2026-04-23 23:32:54.623` | `120.6` |  `697` |     `71` |
| `2026-04-23 23:34:27.230` | `117.4` |  `704` |     `71` |

This does not rule out every possible natural JSC GC behavior, but it makes the
forced full-GC probe an unlikely direct explanation for an 80s liveness failure.

Also, local Bun did not appear to emit `PerformanceObserver` `gc` entries:

```bash
bun -e 'import { PerformanceObserver } from "node:perf_hooks"; console.log(JSON.stringify(PerformanceObserver.supportedEntryTypes))'
```

Returned:

```json
["mark", "measure", "resource"]
```

And a forced `Bun.gc(true)` with a `PerformanceObserver` for `entryTypes: ["gc"]`
emitted zero entries. That means the proposed `natural-gc` instrumentation in
the first design probably will not provide useful data in this runtime.

## What This Proves

High confidence:

1. The immediate K8s failure mode is liveness timeout on `/livez`, followed by
   exit 137.
2. The pod was not OOMKilled and was far below the 4GB memory limit.
3. The stall aligns with an 80.7s event-loop/timer gap.
4. The measured operation bucket for the starved interval is almost entirely
   audio processing.
5. MongoDB slow-query spikes during the incident are recovery symptoms, not the
   cause of `/livez` timing out.
6. UDP/audio processing continued while HTTP request handling stopped, so the
   failure is better described as event-loop starvation/monopolization than a
   complete runtime freeze.

Medium confidence:

1. The trigger is aggregate audio load across many active mic sessions, not one
   single user's reconnect storm.
2. The dangerous threshold is around 70-90 active sessions with 30+ mic-active
   sessions and about 100 UDP packets/sec pod-wide.
3. The audio path likely needs explicit yielding/backpressure/drop behavior so
   HTTP and timers cannot be starved by UDP receive callbacks.

Not yet proven:

1. Which exact audio substage burns the time:
   - LC3 decode
   - app audio fan-out
   - transcription stream writes
   - translation stream writes
   - some combination of the above
2. Whether a rare pathological packet/buffer state contributes.
3. Whether Bun's UDP callback scheduling can starve HTTP independently of per
   packet CPU cost.

## Corrections to the Existing Phase 1 Plan

The current Phase 1 direction is mostly right, but it should be adjusted.

Keep:

- per-invocation UDP audio timing
- packet batch size in the slow-call log
- heartbeat/gap timing, with analysis adjusted for delayed emission
- vitals self-timing

Change:

- Replace or remove `PerformanceObserver` natural-GC instrumentation unless a
  Bun/JSC-specific working mechanism is found.
- Do not only instrument `relayAudioToApps`; that misses transcription and
  translation sends.
- Split `AudioManager.processAudioData(...)` into substage timings:
  - `audio_lc3Decode_ms`
  - `audio_appFanout_ms`
  - `audio_transcriptionFeed_ms`
  - `audio_translationFeed_ms`
  - `audio_microphoneUpdate_ms`
- Add `userIdHash` or a privacy-preserving session key to fan-out/substage logs
  so they can be correlated with `slow-audio-call` without logging raw user IDs.
- Consider a pod-level UDP receive rate metric per vitals interval:
  `udpPacketsReceivedDelta`, `udpPacketsDroppedDelta`, and active UDP sessions.

## Working Hypothesis

The most likely root cause is not MongoDB, readiness, GC, or reconnect storm.

The most likely root cause is:

> Under us-central load, Bun's UDP receive path plus synchronous audio processing
> can monopolize the single JS event loop for long enough that HTTP handlers and
> timers are starved. K8s liveness probes to `/livez` then time out for enough
> consecutive probes that kubelet kills the container. MongoDB "slow" queries and
> reconnect storms are downstream recovery artifacts.

The next fix should be designed around protecting the event loop from UDP/audio
starvation:

- introduce bounded audio work per tick
- yield between chunks/batches
- drop or coalesce audio packets when behind
- separate UDP/audio processing from probe-serving where possible
- measure per-audio-substage cost before choosing the exact intervention

## Evidence Index

Current pod state:

```bash
porter kubectl --cluster 4689 -- describe pod -n default cloud-prod-cloud-7b9847b4d9-npg5d
```

Event-loop gap:

```sql
SELECT dt,
       JSONExtract(raw,'gapMs','Nullable(Float64)') AS gap_ms,
       JSONExtract(raw,'actualMs','Nullable(Float64)') AS actual_ms,
       JSONExtract(raw,'rssMB','Nullable(Float64)') AS rss_mb,
       JSONExtract(raw,'activeSessions','Nullable(Int32)') AS sessions
FROM s3Cluster(primary, t373499_mentracloud_prod_s3)
WHERE _row_type=1
  AND dt >= '2026-04-23 23:20:00'
  AND dt <= '2026-04-23 23:36:00'
  AND JSONExtract(raw,'region','Nullable(String)')='us-central'
  AND JSONExtract(raw,'feature','Nullable(String)')='event-loop-gap'
ORDER BY dt;
```

System vitals operation budget:

```sql
SELECT dt,
       JSONExtract(raw,'activeSessions','Nullable(Int32)') AS sessions,
       JSONExtract(raw,'op_audioProcessing_ms','Nullable(Float64)') AS audio_ms,
       JSONExtract(raw,'op_appMessage_ms','Nullable(Float64)') AS app_ms,
       JSONExtract(raw,'opTotalMs','Nullable(Float64)') AS total_ms,
       JSONExtract(raw,'opBudgetUsedPct','Nullable(Float64)') AS budget_pct
FROM s3Cluster(primary, t373499_mentracloud_prod_s3)
WHERE _row_type=1
  AND dt >= '2026-04-23 23:20:00'
  AND dt <= '2026-04-23 23:36:00'
  AND JSONExtract(raw,'region','Nullable(String)')='us-central'
  AND JSONExtract(raw,'feature','Nullable(String)')='system-vitals'
ORDER BY dt;
```

Per-second service mix:

```sql
SELECT toStartOfInterval(dt, INTERVAL 1 SECOND) AS sec,
       count() AS logs,
       countIf(JSONExtractString(raw,'service')='UdpAudioServer') AS udp_server,
       countIf(JSONExtractString(raw,'service')='AudioManager') AS audio_mgr,
       countIf(JSONExtractString(raw,'service')='hono-http') AS http,
       countIf(JSONExtractString(raw,'service')='SystemVitalsLogger') AS vitals
FROM s3Cluster(primary, t373499_mentracloud_prod_s3)
WHERE _row_type=1
  AND dt >= '2026-04-23 23:33:00'
  AND dt <= '2026-04-23 23:34:30'
  AND JSONExtract(raw,'region','Nullable(String)')='us-central'
GROUP BY sec
ORDER BY sec;
```

UDP stats during starvation:

```sql
SELECT dt,
       JSONExtractString(raw,'service') AS service,
       JSONExtractString(raw,'message') AS message,
       JSONExtract(raw,'packetsReceived','Nullable(Int32)') AS pod_udp_count,
       JSONExtract(raw,'lastSequence','Nullable(Int32)') AS seq,
       JSONExtract(raw,'lastAudioBytes','Nullable(Int32)') AS last_bytes,
       JSONExtract(raw,'activeSessions','Nullable(Int32)') AS sessions
FROM s3Cluster(primary, t373499_mentracloud_prod_s3)
WHERE _row_type=1
  AND dt >= '2026-04-23 23:33:00'
  AND dt <= '2026-04-23 23:34:27'
  AND JSONExtract(raw,'region','Nullable(String)')='us-central'
  AND JSONExtract(raw,'feature','Nullable(String)')='udp-audio'
ORDER BY dt;
```
