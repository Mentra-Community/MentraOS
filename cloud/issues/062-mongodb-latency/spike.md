# Spike: MongoDB Latency — Event Loop Blocking from Cross-Region Queries

## Overview

**What this doc covers:** Investigation into MongoDB query latency as a contributor to cloud-prod crashes. Covers what we found, what we proved, what we haven't proved, and a concrete plan to prove whether MongoDB is a primary crash cause or just a symptom.
**Why this doc exists:** The crash diagnostics hotfix (061) revealed that `apps.find` and `apps.findOne` queries take 200-750ms from international regions. Each of these calls blocks the single-threaded Bun event loop. We suspect this is a major contributor to health check timeouts, but we have NOT proven causation — only correlation.
**Who should read this:** Anyone working on cloud stability, database performance, or crash investigation.

**Depends on:**

- [061-crash-investigation](../061-crash-investigation/) — crash diagnostics that surfaced the slow-query data
- [057-cloud-observability](../057-cloud-observability/) — observability infrastructure

---

## Background

The cloud server runs on Bun's single-threaded event loop. Any synchronous or awaited operation that takes >50ms blocks everything else — WebSocket messages, audio processing, HTTP responses, health check probes. The Kubernetes liveness probe hits `/health` every 5 seconds with a 1-second timeout. If the event loop is blocked when the probe arrives, the probe fails. 15 consecutive failures (75 seconds of unresponsiveness) = SIGKILL.

MongoDB queries are `await`ed — they're async I/O, but the event loop can only process the response when it's not busy with something else. More importantly, Mongoose model hydration (turning the BSON response into a JS object with change tracking) happens synchronously on the event loop after the network response arrives.

---

## What We Found

### Slow query logs (from 061 diagnostics)

The `MONGOOSE_SLOW_QUERY_MS=100` env var enabled slow query logging on all prod regions. Within minutes:

| Region    | Collection | Operation | Latency | Sessions |
| --------- | ---------- | --------- | ------- | -------- |
| East Asia | apps       | find      | 750ms   | 1        |
| East Asia | apps       | findOne   | 370ms   | 1        |
| France    | apps       | findOne   | 215ms   | 15       |

These are queries against the `apps` collection using an indexed `packageName` field.

### Direct MongoDB investigation

Connected via `mongosh` and confirmed:

| Finding                          | Value                                                                                            |
| -------------------------------- | ------------------------------------------------------------------------------------------------ |
| `packageName` index exists       | Yes — unique, background. `EXPRESS_IXSCAN`, 1 doc examined, 0ms server execution.                |
| Collection size                  | 1,314 documents, 2 MB total, avg 1.5 KB per doc                                                  |
| Largest documents                | 97 KB (`com.augmentos.livecaptions`), 58 KB (`cloud.augmentos.mira`), 54 KB (`com.mentra.merge`) |
| Ping from SF                     | 153ms                                                                                            |
| `findOne` by packageName from SF | 63-80ms (almost entirely network RTT)                                                            |
| `find()` all 1314 docs from SF   | 639ms                                                                                            |

### The latency is network RTT, not query execution

The MongoDB `explain()` shows 0ms execution time — the index works perfectly. The 200-750ms is round-trip network time between the pod and the MongoDB cluster. The DB is hosted in one region (likely US East via Atlas). Every query from every region pays this penalty.

### Where `apps` queries happen in the codebase

At least 20+ call sites across the server do `App.findOne({ packageName })` or `App.find(...)`:

- Session connection (load pre-installed apps)
- App start/stop (verify app exists, check permissions)
- Developer console (list apps, publish, approve)
- Onboarding flows
- Permission checks
- API key validation
- Store listings

Many of these are in hot paths that run on every session connect.

---

## What We Have NOT Proven

### 1. We haven't proven MongoDB latency causes crashes

We know queries are slow. We know pods crash. We have NOT shown that a specific crash was directly caused by MongoDB queries blocking the health check. The correlation is suggestive but not causal.

**To prove it, we need:** A timeline showing that in the minutes before a crash, MongoDB query latency spiked AND the event loop was blocked for the duration of those queries AND the health check couldn't respond because of that blocking.

### 2. We haven't measured cumulative event loop blocking from MongoDB

A single 80ms query (US Central) isn't fatal. But if 65 sessions each trigger 3-5 `findOne` calls during a reconnect burst (after a partial outage or deploy), that's 195-325 queries × 80ms = 15-26 seconds of cumulative blocking. We don't know if this actually happens in practice.

**To prove it, we need:** A count of MongoDB queries per minute correlated with event loop lag. If query volume spikes → lag spikes → crash, that's causation.

### 3. We haven't compared MongoDB latency across regions at crash time

France crashes every ~3 hours with 22 sessions. US Central crashes with 65 sessions. If MongoDB latency is the cause, France should crash with FEWER sessions because each query takes 3x longer (215ms vs ~80ms). But France could also be crashing for a completely different reason.

**To prove it, we need:** Slow query frequency and total blocking time per region, correlated with crash timing.

### 4. We haven't ruled out other event loop blockers

GC probes show 10-27ms pauses — probably not the main cause. But we haven't measured Soniox send latency on prod yet (US Central hasn't redeployed). Audio processing, display rendering, and app message relay are also unmeasured.

---

## How to Prove It

### Step 1: Add cumulative MongoDB blocking metric to system vitals

**What:** In the 30-second vitals tick, report:

- `mongoQueryCount`: total MongoDB queries in the last 30 seconds
- `mongoTotalBlockingMs`: sum of all query durations in the last 30 seconds
- `mongoMaxQueryMs`: slowest single query in the last 30 seconds

The slow-query plugin already times every query. Extend it to accumulate these counters and expose them to SystemVitalsLogger.

**Why this proves it:** If `mongoTotalBlockingMs` is 5,000ms in a 30-second window, that means MongoDB blocked the event loop for 5 of 30 seconds (17%). Correlate this with event loop lag — if they track together, MongoDB is the cause. If lag is high but MongoDB blocking is low, something else is blocking.

### Step 2: Correlate slow queries with event loop lag

**What:** Query BetterStack for time windows where:

1. `feature: slow-query` count is high AND
2. `feature: event-loop-lag` warnings appear AND
3. A crash follows within minutes

If all three align consistently across multiple crashes, that's strong evidence.

If slow queries are frequent but event loop lag doesn't correlate, MongoDB isn't the bottleneck — something else is consuming the event loop time.

### Step 3: Measure query volume during session connect bursts

**What:** After a pod restart, all disconnected users reconnect simultaneously. Each reconnect triggers app loading queries. Log the query count and total blocking time during the first 60 seconds after a restart.

**Why this proves it:** If the reconnect storm generates hundreds of queries that block the event loop for 10+ seconds, and the pod immediately starts degrading, the reconnect-after-crash pattern is a self-reinforcing crash loop: crash → restart → reconnect storm → MongoDB blocking → event loop saturated → health check fails → crash again.

### Step 4: Test with in-memory app cache (on debug)

**What:** Implement a simple in-memory cache of the `apps` collection on `cloud-debug`. Load all 1,314 docs at boot (~2MB), serve all `findOne({ packageName })` calls from cache. Refresh every 5 minutes.

**Why this proves it:** If the cache eliminates MongoDB latency and the debug server's event loop lag drops significantly under the same session count, that's definitive proof. If it doesn't change anything, MongoDB wasn't the bottleneck.

---

## What Good Observability Looks Like for This

After implementing the above, we should be able to answer these questions from BetterStack alone:

| Question                                                                   | How to answer                                                                                                  |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| "How much time did MongoDB block the event loop in the last 30 seconds?"   | `mongoTotalBlockingMs` in system-vitals                                                                        |
| "Did MongoDB blocking spike before this crash?"                            | Query: slow-query count + mongoTotalBlockingMs in the 10 minutes before crash timestamp                        |
| "Is MongoDB the primary event loop blocker, or is it GC / Soniox / audio?" | Compare: `mongoTotalBlockingMs` vs `gcDurationMs` vs `soniox-timing` warnings. Whichever is largest wins.      |
| "Does the reconnect storm after a crash cause the next crash?"             | Query: mongoQueryCount in first 60s after restart. If it's 500+ queries at 80ms each = 40 seconds of blocking. |
| "Would an app cache fix the crashes?"                                      | Compare debug (with cache) vs prod (without) at similar session counts.                                        |

---

## Quick Wins (no code changes)

1. **Raise `MONGOOSE_SLOW_QUERY_MS` from 100 to 200** — 100ms threshold generates too many logs from normal US Central latency. 200ms catches the actually problematic queries while reducing noise.
2. **Check if MongoDB Atlas has a closer region** — if the DB is in US East and most users are US Central, moving to US Central would halve the RTT for the busiest region.
3. **Check Atlas Performance Advisor** — may have additional index or query plan recommendations we haven't seen.

## Potential Fixes (need spec after proving causation)

| Fix                                | Effort                  | Impact                                         | Risk                                                         |
| ---------------------------------- | ----------------------- | ---------------------------------------------- | ------------------------------------------------------------ |
| In-memory app cache                | Small (50-100 lines)    | Eliminates all `apps` collection RTT           | Cache staleness — new apps take up to 5 min to appear        |
| `.lean()` on all read-only queries | Small (find/replace)    | Reduces Mongoose hydration CPU ~50%            | Can't call `.save()` on lean docs — need to audit call sites |
| MongoDB read replicas per region   | Medium (Atlas config)   | Reduces RTT for all collections, not just apps | Cost increase, replication lag                               |
| Connection pooling tuning          | Small (Mongoose config) | May reduce connection setup overhead           | Unlikely to help — queries are already fast, it's RTT        |
| Move DB to US Central              | Small (Atlas migration) | Halves RTT for busiest region                  | Migration downtime risk, increases RTT for East Asia         |

---

## Key Numbers

| Metric                             | Value                                |
| ---------------------------------- | ------------------------------------ |
| `apps` collection size             | 1,314 docs, 2 MB                     |
| Largest app document               | 97 KB                                |
| Average app document               | 1.5 KB                               |
| `packageName` index                | Exists, unique, 0ms server execution |
| Network ping to DB (from SF)       | 153ms                                |
| `findOne` latency (from SF)        | 63-80ms                              |
| `findOne` latency (from East Asia) | 370ms                                |
| `findOne` latency (from France)    | 215ms                                |
| `find()` all docs (from SF)        | 639ms                                |
| Query call sites in codebase       | 20+ files                            |

---

## Next Steps

1. Add `mongoQueryCount`, `mongoTotalBlockingMs`, `mongoMaxQueryMs` to system vitals (code change, extend slow-query plugin)
2. Redeploy US Central with the 061 diagnostics to get GC probe + slow query data from the busiest region
3. Wait for one crash cycle (~2-3 hours) and correlate all the diagnostic data
4. If MongoDB blocking correlates with crashes → write spec for in-memory app cache
5. If it doesn't → move to next suspect (check Soniox timing, audio processing, etc.)
