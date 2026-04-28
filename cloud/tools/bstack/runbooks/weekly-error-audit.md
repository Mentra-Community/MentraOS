# Weekly Error Audit

## Trigger

Every Monday morning, or after every major deploy. Takes 15-30 minutes.

## Prerequisites

SRE credentials are in Doppler project `mentra-sre` (NOT `mentraos-cloud`):

```bash
# Run any bstack command with credentials injected
doppler run --project mentra-sre --config dev -- bstack health
doppler run --project mentra-sre --config dev -- bstack incidents --limit 10
doppler run --project mentra-sre --config dev -- bstack sql "SELECT ..."
```

**Important**: The hot storage table (`remote(t373499_mentracloud_prod_logs)`) only holds the last few minutes of data. For weekly audits, use the historical/S3 table: `s3Cluster(primary, t373499_mentracloud_prod_s3)` with `WHERE _row_type = 1`. Queries are slower (~3-5s) but have full history.

## Step 0: Quick health check (30 seconds)

```bash
bstack health
```

Check all regions at a glance. Note which regions are up, session counts, RSS, and uptime. If a region has low uptime (recently restarted), investigate further with `bstack crash-timeline --region <REGION>`.

## Quick Check (30 seconds)

```bash
bstack sql "SELECT count() as total FROM s3Cluster(primary, t373499_mentracloud_prod_s3) WHERE _row_type = 1 AND dt >= now() - INTERVAL 7 DAY AND JSONExtractString(raw, 'feature') = 'unhandled-rejection'"
```

Any results = a bug that would have crashed the server. File an issue immediately.

## Diagnose (15-30 minutes)

### Step 1: Unhandled Rejections (30 seconds)

```bash
bstack sql "SELECT dt, JSONExtractString(raw, 'message') as message, JSONExtractString(raw, 'region') as region FROM s3Cluster(primary, t373499_mentracloud_prod_s3) WHERE _row_type = 1 AND dt >= now() - INTERVAL 7 DAY AND JSONExtractString(raw, 'feature') = 'unhandled-rejection' ORDER BY dt DESC LIMIT 20"
```

**Zero results = good.** Any result = a code bug where a promise rejected without a `.catch()`. The global handler (issue 070) kept the server alive, but the root cause needs fixing.

### Step 2: Top Errors by Count (2 minutes)

```bash
bstack sql "SELECT JSONExtractString(raw, 'service') as service, substring(JSONExtractString(raw, 'message'), 1, 80) as message, count() as total FROM s3Cluster(primary, t373499_mentracloud_prod_s3) WHERE _row_type = 1 AND dt >= now() - INTERVAL 7 DAY AND JSONExtractString(raw, 'level') IN ('error', 'fatal') AND JSONExtractString(raw, 'region') = 'us-central' GROUP BY service, message ORDER BY total DESC LIMIT 20"
```

For each entry, ask:

| Question                                            | Action                                                               |
| --------------------------------------------------- | -------------------------------------------------------------------- |
| Is this a real error (unexpected, indicates a bug)? | File an issue if there isn't one already.                            |
| Is this an expected edge case (handled gracefully)? | Downgrade to `warn` level in the code. File a PR.                    |
| Is this new since last week?                        | Investigate — new errors after a deploy often indicate a regression. |
| Is this > 10,000 occurrences?                       | It's noise. Rate-limit, sample, or downgrade to `debug`.             |

### Step 2b: Memory Leak Check (1 minute)

```bash
bstack sql "SELECT toStartOfHour(dt) as hour, avg(JSONExtractInt(raw, 'disposedSessionsPendingGC')) as avg_leaked, avg(JSONExtractFloat(raw, 'rssMB')) as rss, avg(JSONExtractInt(raw, 'activeSessions')) as sessions FROM s3Cluster(primary, t373499_mentracloud_prod_s3) WHERE _row_type = 1 AND JSONExtractString(raw, 'feature') = 'system-vitals' AND JSONExtractString(raw, 'region') = 'us-central' AND dt >= now() - INTERVAL 24 HOUR GROUP BY hour ORDER BY hour ASC"
```

If `disposedSessionsPendingGC` climbs above 0 and stays there, sessions are leaking. Check the timer audit section in the pod-crash runbook.

For per-region peak heap/RSS over the last week:

```bash
bstack sql "SELECT JSONExtract(raw, 'region', 'Nullable(String)') as region, max(JSONExtract(raw, 'heapUsedMB', 'Nullable(Float64)')) as peak_heap, max(JSONExtract(raw, 'rssMB', 'Nullable(Float64)')) as peak_rss FROM s3Cluster(primary, t373499_mentracloud_prod_s3) WHERE _row_type = 1 AND dt >= now() - INTERVAL 7 DAY AND JSONExtract(raw, 'feature', 'Nullable(String)') = 'system-vitals' GROUP BY region ORDER BY peak_heap DESC"
```

For a detailed memory breakdown by owner:

```bash
bstack memory-owners --region us-central
```

This shows which subsystems are consuming memory and which are growing. If a specific owner (e.g., `calendar.events`, `transcription.vad-audio-buffer`) is growing, that is your leak. Note: `transcription.history.*` owners were removed in issue 098.

### Step 3: Top Warnings by Count (2 minutes)

```bash
bstack sql "SELECT JSONExtractString(raw, 'service') as service, substring(JSONExtractString(raw, 'message'), 1, 80) as message, count() as total FROM s3Cluster(primary, t373499_mentracloud_prod_s3) WHERE _row_type = 1 AND dt >= now() - INTERVAL 7 DAY AND JSONExtractString(raw, 'level') = 'warn' AND JSONExtractString(raw, 'region') = 'us-central' GROUP BY service, message ORDER BY total DESC LIMIT 20"
```

Warnings > 10,000/week are noise candidates. Each one is a hint at an architectural gap — the code handles it, but something upstream could be improved to prevent it.

### Step 4: Log Volume by Service (2 minutes)

```bash
bstack sql "SELECT JSONExtractString(raw, 'service') as service, count() as total, round(count() / 7 / 24 / 60, 0) as per_minute FROM s3Cluster(primary, t373499_mentracloud_prod_s3) WHERE _row_type = 1 AND dt >= now() - INTERVAL 7 DAY AND JSONExtractString(raw, 'region') = 'us-central' GROUP BY service ORDER BY total DESC LIMIT 20"
```

The top 3 services probably account for 80% of log volume. For each:

- Is every log line useful? Or is it logging the same thing thousands of times?
- Can it be rate-limited (once per session per minute instead of every event)?
- Can it be moved to `debug` level (only enabled when investigating)?

Target: reduce total log volume by 50% without losing diagnostic capability.

### Step 5: Crash Frequency (1 minute)

```bash
bstack incidents --limit 20
```

For any crash you want to investigate further:

```bash
bstack crash-timeline --region <REGION>
```

This shows the timeline of diagnostic events leading up to the crash — GC probes, event loop gaps, slow queries, and health timing.

Compare to last week:

| Trend                        | What it means                                           |
| ---------------------------- | ------------------------------------------------------- |
| Fewer crashes than last week | Fixes are working.                                      |
| Same number of crashes       | Investigate — are they the same root cause or new ones? |
| More crashes                 | Something regressed. Check what deployed this week.     |

### Step 6: Connection Churn (1 minute)

```bash
bstack sql "SELECT toStartOfHour(dt) as hour, sum(JSONExtractInt(raw, 'wsDisconnects')) as disconnects, sum(JSONExtractInt(raw, 'wsReconnects')) as reconnects, max(JSONExtractInt(raw, 'activeSessions')) as peak_sessions FROM s3Cluster(primary, t373499_mentracloud_prod_s3) WHERE _row_type = 1 AND dt >= now() - INTERVAL 7 DAY AND JSONExtractString(raw, 'feature') = 'system-vitals' AND JSONExtractString(raw, 'region') = 'us-central' GROUP BY hour ORDER BY hour DESC LIMIT 48"
```

Is churn getting better or worse? Does it correlate with time of day (peak hours)?

### Step 7: Memory Health (1 minute)

```bash
bstack memory --region us-central --duration 1h
```

For per-owner breakdown:

```bash
bstack memory-owners --region us-central
```

Check the "Top owners by growth" section. If any owner is growing between snapshots, that's where the leak is.

Is the heap stable (sawtooth pattern) or climbing (leak)? RSS should stay under 500MB with 80 sessions after the logging transport fix (issue 067).

> **Note:** The queries above are scoped to `us-central`. Repeat Steps 1-7 for each active region: `france`, `east-asia`, `us-west`, `us-east`. Or use `bstack diagnostics --region <REGION>` for a quick all-in-one check per region.

## Fix

| Finding                        | Action                                                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Unhandled rejection found      | File a bug. Add `.catch()` to the specific call site.                                                            |
| Error that should be warn      | File a PR to downgrade the log level.                                                                            |
| New error pattern after deploy | Investigate the deploy diff. Is it a regression?                                                                 |
| Service producing >1M logs/day | Review what it's logging. Rate-limit or move to debug.                                                           |
| Crash rate increasing          | Check exit codes. Run the pod-crash runbook.                                                                     |
| Churn rate increasing          | Check `ws-close` events for `timeSinceLastClientMessage`. Is it client-side (>10s silence) or server-side (<2s)? |
| Heap climbing                  | Check if the logging transport changed. Run `analyze-heap.ts live`.                                              |

## Verify

After making changes (downgrading log levels, fixing bugs):

1. Deploy to cloud-debug first
2. Run the relevant queries again — counts should decrease
3. Deploy to prod
4. Confirm in next week's audit

## Output Template

Post this summary in Slack after each audit:

```
Weekly Error Audit — [DATE]

Unhandled rejections: [COUNT] [✅ or 🔴 + link to issue]
Top error: "[MESSAGE]" — [COUNT]/week
  → [Expected edge case / Real bug / New since last week]
  → [Action: downgrade to warn / file issue / investigating]
New errors since last deploy: [Yes/No]
Log volume: [X]M logs/day from US Central
  → Top: [Service1] ([X]M), [Service2] ([X]M), [Service3] ([X]M)
  → [Any rate-limit candidates?]
Crashes: [COUNT] this week (was [COUNT] last week) [trend ↑↓→]
Churn: ~[X] disconnects/min, [X]% code 1006 (client-side)
Heap: [stable/climbing] at [X]MB with [X] sessions
```

## Prevent

- **Log level discipline**: `error` = unexpected and actionable. `warn` = expected edge case. `info` = normal. `debug` = troubleshooting only.
- **Every new log line**: Ask "will this help me debug a production incident at 2am?" If no, make it `debug`.
- **Every new feature**: Check log volume before and after deploying to prod. Did it add significant noise?
- **Rate-limit noisy logs**: If a condition fires 100 times per second per session, log it once per minute per session.

## History

| Date         | Key findings                                                      | Actions taken                                                      |
| ------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| Mar 29, 2026 | `@logtail/pino` producing 6K-10K logs/min, causing heap growth    | Switched to Vector (067). Reduced in-process log overhead to zero. |
| Mar 29, 2026 | DashboardManager "not ready" warnings: 645K/day                   | Identified as rate-limit candidate (071).                          |
| Mar 29, 2026 | HTTP 503 logged at `error` level but is expected during reconnect | Identified for downgrade to `warn` (071).                          |

## References

- [071 Observability Hygiene Spike](../../issues/071-observability-hygiene/spike.md) — full analysis of the log noise problem
- [067 Heap Growth Investigation](../../issues/067-heap-growth-investigation/spike.md) — how log volume crashed the server
- [069 WS Disconnect Observability](../../issues/069-ws-disconnect-observability/spike.md) — how to prove client-side disconnects
- [074 SDK v3 Merge & Ship](../../issues/074-sdk-v3-merge-and-ship/spike.md) — France OOM investigation, timer audit

## Tips & Tricks

### JSONExtract syntax

Use `JSONExtractString(raw, 'field')`, `JSONExtractInt(raw, 'field')`, `JSONExtractFloat(raw, 'field')` — NOT `json.field` dot notation (doesn't work) or `JSONExtract(raw, 'field', 'Nullable(String)')` (verbose).

### Hot vs historical storage

| Table                                             | Data range                    | Speed       | Use for                       |
| ------------------------------------------------- | ----------------------------- | ----------- | ----------------------------- |
| `remote(t373499_mentracloud_prod_logs)`           | Last ~2-5 minutes             | Fast (<1s)  | Real-time debugging           |
| `s3Cluster(primary, t373499_mentracloud_prod_s3)` | Full history                  | Slow (3-5s) | Weekly audits, investigations |
| `remote(t373499_augmentos_logs)`                  | Last ~2-5 minutes (dev/debug) | Fast        | Dev/debug real-time           |
| `s3Cluster(primary, t373499_augmentos_s3)`        | Full history (dev/debug)      | Slow        | Dev/debug investigations      |

Always add `WHERE _row_type = 1` when querying S3 tables (filters to log rows, excludes metrics).

### Maintain this runbook

After every audit, update:

- New error patterns discovered
- Query patterns that worked well
- Thresholds that need adjusting
- Tools or credentials that were hard to find
