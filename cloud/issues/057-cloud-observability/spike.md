# Spike: Cloud Observability — Full SRE Plan

## Overview

**What this doc covers:** A complete plan to close the observability gaps in cloud-prod. Covers what we have today, what's broken about it, what to build, how to handle deploy alert noise, and how to use BetterStack (which we already pay for) before adding any new tools.
**Why this doc exists:** We spent ~16 hours across issues 055/056 investigating 75 pod restarts. We found memory leaks, ruled out WASM, audited every crash — and still can't definitively prove what blocks the event loop. An SRE with proper tooling would have answered that in 30 minutes. This doc is the plan to make sure the next incident takes 30 minutes, not 16 hours.
**Who should read this:** Cloud engineers, anyone deploying or operating cloud-prod.

**Depends on:**

- [055-cloud-prod-oom-crashes/spike.md](../055-cloud-prod-oom-crashes/spike.md) — liveness probe failure confirmed
- [056-cpu-spike-before-kill/spike.md](../056-cpu-spike-before-kill/spike.md) — WASM ruled out, memory leaks found
- [056-cpu-spike-before-kill/memory-leak-spike.md](../056-cpu-spike-before-kill/memory-leak-spike.md) — crash audit, two crash patterns, three confirmed leaks

---

## What We Have Today

### The good

| Tool                             | What it gives us                                          | Working?                                            |
| -------------------------------- | --------------------------------------------------------- | --------------------------------------------------- |
| **BetterStack Telemetry** (logs) | Structured JSON logs, ClickHouse queries, dashboards      | ✅ Yes — data starts March 18                       |
| **BetterStack Uptime**           | URL monitoring of `prod.augmentos.cloud/health` every 60s | ✅ Yes — has been catching every crash since Feb 18 |
| **Porter dashboard**             | CPU/memory charts, deploy history                         | ✅ Yes                                              |
| **`kubectl` via Porter CLI**     | Pod describe, events, real-time logs                      | ✅ Yes (events expire after ~1 hour)                |
| **`/health` endpoint**           | Returns session count + metrics JSON                      | ✅ Yes — Kubernetes probes hit this                 |
| **`/metrics` endpoint**          | Prometheus-format gauges (sessions, messages)             | ⚠️ Exists but **nothing scrapes it**                |
| **`MemoryLeakDetector`**         | Warns when disposed UserSessions aren't GC'd after 60s    | ✅ Yes — flagged 245 leaked sessions on March 25    |
| **`MemoryTelemetryService`**     | Per-session memory snapshots every 10min to BetterStack   | ❌ Built but **disabled in all envs**               |
| **`MetricsService`**             | Event loop lag sampling every 2s (internal gauge)         | ⚠️ Samples but **never logs or exposes the data**   |

### The bad

**We learned to ignore the alerts.** BetterStack Uptime has been detecting every single crash since February 18 — **69 incidents in March alone**. But because deploys also cause the health endpoint to go down for a few minutes, the alerts felt like false positives. They weren't. Every single one was a real crash or a real deploy disruption. We just couldn't tell which was which.

**We have instrumentation that doesn't go anywhere.** The `/metrics` endpoint emits Prometheus gauges. Nothing scrapes them. `MetricsService` samples event loop lag every 2 seconds. It updates an internal variable that nobody reads. `MemoryTelemetryService` would log detailed per-session memory breakdowns. It's been disabled since it was built. Two separate issues (032, 055) recommended enabling it.

**We have no degradation detection.** We can detect "server is down" (BetterStack Uptime) but not "server is getting slow." The event loop could be lagging 2 seconds on every tick, response times could be 10x normal, heap could be at 90% — and nobody knows until users file bug reports or the pod gets killed.

---

## What We Found During the Investigation

### BetterStack Uptime has the crash history we thought we didn't have

The `prod.augmentos.cloud/health` monitor (ID: 3355604) has been running since June 2025. It caught:

| Period                 | Incidents | Image in prod                        |
| ---------------------- | --------- | ------------------------------------ |
| Feb 18–28              | ~12       | Pre-v2.7 (`0eed4623`)                |
| Mar 1–8                | ~8        | v2.7 (`fb50674a`)                    |
| Mar 9–18               | ~12       | v2.7, frequency increasing           |
| Mar 19–25              | ~37       | v2.8 (`dcbc9662`), frequency doubled |
| **Total since Feb 18** | **~69**   |                                      |

**The crashes predate both v2.7 and v2.8.** The `ManagedStreamingExtension` interval leak has existed since the class was created. Frequency has been increasing as session counts grow.

Two types of failure cause from BetterStack:

- **"Timeout (no headers received)"** — event loop is completely blocked, can't respond at all
- **"Status 503"** — server is responding but sessions are gone (post-crash, during restart)

Average incident duration: **~4 minutes** (pod restarts, health comes back). Longest: ~5m 50s.

### The deploy alert noise problem

Deploys also cause ~4 minutes of downtime (old pod killed, new pod starting, health check passes). The BetterStack monitor can't tell the difference between:

- A deploy restart (expected, ~4 min, happens a few times a week)
- A crash restart (unexpected, ~4 min, happens 5-10 times a day)

Both produce identical alerts. So the alerts got ignored. The fix isn't to make monitoring less sensitive — it's to annotate deploy-caused downtime so every remaining alert is actionable.

### BetterStack dashboard already built

During this investigation, we built a dashboard using the BetterStack MCP tools:

**[Cloud-Prod Health & Crash Investigation](https://telemetry.betterstack.com/team/t329093/dashboards/971353)** (ID: 971353)

Sections:

1. **Crash Overview** — restart count bar chart, total restarts, high memory warnings count
2. **Memory & Leak Signals** — memory + leak warnings over time, leaked session count, DashboardManager spam rate
3. **Error Breakdown** — errors by service (stacked bar), HTTP 503 rate
4. **Transcription & Soniox** — Soniox stream errors, top warning sources (pie)
5. **Crash Audit** — restart timeline table, error/warn breakdown by service

This dashboard is built from BetterStack log data via ClickHouse queries. It works today. It needs to be expanded with application-level metrics (heap, event loop lag) once those are logged.

---

## The Plan

### Phase 0: Fix the known bugs (before any observability work)

These are confirmed bugs from the 056 investigation. Fix them first so we're measuring a healthier system.

| #   | Fix                                         | What                                                                                                                                       | Effort      | Files                                                         |
| --- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------- | ------------------------------------------------------------- |
| 0a  | **ManagedStreamingExtension interval leak** | `setInterval` return value is never stored, interval never cleared in `dispose()`. Every disposed UserSession is pinned in memory forever. | 15 min      | `services/streaming/ManagedStreamingExtension.ts`             |
| 0b  | **SonioxSdkStream listener leak**           | 7 `.on()` event listeners registered in `initialize()`, none `.off()`'d in `close()`. Pins stream + TranscriptionManager + UserSession.    | 15 min      | `services/session/transcription/providers/SonioxSdkStream.ts` |
| 0c  | **4 managers never disposed**               | `calendarManager`, `deviceManager`, `userSettingsManager`, `streamRegistry` missing from `UserSession.dispose()`.                          | 10 min      | `services/session/UserSession.ts`                             |
| 0d  | **dispose() identity-blind map delete**     | `UserSession.sessions.delete(this.userId)` without checking `sessions.get(this.userId) === this`. Can orphan a newer session.              | 5 min       | `services/session/UserSession.ts`                             |
| 0e  | **Email case mismatch**                     | WebSocket init uses `payload.email` (raw), REST uses `.toLowerCase()`. Mixed-case JWT = invisible session.                                 | 1 min       | `services/websocket/bun-websocket.ts` L90                     |
| 0f  | **Deploy DashboardManager fix**             | Already pending on separate branch. Eliminates 645K warn logs/day.                                                                         | Deploy only | (separate branch)                                             |

**After deploying Phase 0:** Wait 24–48 hours. Monitor crash frequency on the BetterStack dashboard. If crashes drop from ~8/day to ~0, the memory leaks were the primary cause.

### Phase 1: Application-level metrics (make the server tell us how it's doing)

These are code changes in the cloud server. No external tools needed — everything logs to BetterStack which we already have.

| #   | Change                                                                                  | What it gives us                                                                                                                                                                                                                                                                                                                                        | Effort |
| --- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1a  | **Log event loop lag to BetterStack**                                                   | Wire up existing `MetricsService` 2-second sampling to emit a structured log when lag exceeds 50ms. Fields: `lagMs`, `heapUsedMB`, `rssMB`, `activeSessions`. This is the single most important metric — it answers "how sick is the event loop right now?"                                                                                             | 30 min |
| 1b  | **Add `heapUsedMB`, `rssMB`, `eventLoopLagMs`, `activeSessions` to `/health` response** | Every Kubernetes probe (every 5s) and every BetterStack check (every 60s) becomes a data point. The degradation curve becomes visible.                                                                                                                                                                                                                  | 15 min |
| 1c  | **Enable `MEMORY_TELEMETRY_ENABLED=true`** in all Porter env blocks                     | Per-session memory breakdown every 10 min. Logs to BetterStack. Zero code change.                                                                                                                                                                                                                                                                       | 5 min  |
| 1d  | **Add a lightweight `/livez` endpoint**                                                 | `app.get("/livez", (c) => c.text("ok"))` — zero computation. This becomes the liveness probe target. `/health` stays as the readiness probe and observability endpoint (with the new fields from 1b). The current `/health` iterates all sessions, counts WebSockets, updates gauges, and serializes JSON — too much work for a "are you alive?" check. | 10 min |
| 1e  | **Add explicit probe config to `porter.yaml`**                                          | Version-control the liveness/readiness probe settings instead of relying on Porter defaults. Liveness → `/livez` with 3s timeout. Readiness → `/health` with 5s timeout.                                                                                                                                                                                | 15 min |

**After deploying Phase 1:** The BetterStack dashboard can be expanded with charts for:

- Event loop lag over time (from 1a logs)
- Heap usage over time (from 1a/1b logs)
- Session count over time (from 1b)
- Degradation curve leading up to each crash (visible for the first time)

### Phase 2: Monitoring & alerting (know about problems before users do)

All of this uses BetterStack — no new tools.

| #   | Change                                                         | What it gives us                                                                                                                                                                                                                                                                                                                                                                                    | Effort                                                         |
| --- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 2a  | **Add BetterStack dashboard charts for Phase 1 metrics**       | Line charts for event loop lag, heap size, session count. Number cards for current lag, current heap. Table for recent crashes with gap between them.                                                                                                                                                                                                                                               | 1–2 hours (via MCP tools, same as the dashboard already built) |
| 2b  | **Solve the deploy alert noise** (see dedicated section below) | Alerts you can trust — every alert is either a real crash or real degradation, never a deploy.                                                                                                                                                                                                                                                                                                      | 1–2 hours                                                      |
| 2c  | **Add degradation alerting**                                   | Alert when the APPLICATION is degrading, not just when the URL is down. This is the key missing piece. Options detailed below.                                                                                                                                                                                                                                                                      | 1–2 hours                                                      |
| 2d  | **Add a second BetterStack Uptime monitor for response time**  | Monitor `prod.augmentos.cloud/health` with a response time threshold (e.g., alert if >3 seconds). This catches event loop degradation BEFORE the crash — the `/health` endpoint starts responding slowly (500ms → 1s → 2s → timeout) in the minutes before the pod is killed. This signal doesn't fire during deploys because the pod isn't responding at all (different from "responding slowly"). | 30 min                                                         |

### Phase 3: Deploy alert noise — the right approach

The problem: deploys and crashes both cause ~4 minutes of `/health` downtime. We need to distinguish them without reducing monitoring sensitivity.

**Principle: Don't make the monitor less sensitive. Make the alerts smarter.**

**Approach: Deploy annotation via GitHub Actions**

When a deploy starts, post to a Slack channel (or a BetterStack annotation). Don't suppress any alerts. When an alert fires, the context is immediately visible:

- Alert fires + deploy message in Slack within 5 min → deploy, expected
- Alert fires + no deploy message → crash, investigate

Implementation in `.github/workflows/porter-prod.yml`:

```yaml
# Before porter apply
- name: Notify deploy started
  run: |
    curl -X POST "$SLACK_DEPLOY_WEBHOOK" \
      -d '{"text":"🚀 cloud-prod deploy started (commit: ${{ steps.vars.outputs.sha_short }}). Health endpoint will be unavailable for ~5 min."}'

# After porter apply
- name: Wait for healthy pod, then notify
  run: |
    for i in $(seq 1 60); do
      if curl -sf --max-time 5 "https://prod.augmentos.cloud/health" | grep -q '"status":"ok"'; then
        curl -X POST "$SLACK_DEPLOY_WEBHOOK" \
          -d '{"text":"✅ cloud-prod deploy complete. Health restored after ~$((i * 10))s."}'
        exit 0
      fi
      sleep 10
    done
    curl -X POST "$SLACK_DEPLOY_WEBHOOK" \
      -d '{"text":"⚠️ cloud-prod deploy: health not restored after 10 min. Check Porter."}'
    exit 1
```

This gives you:

- Every BetterStack alert still fires at full sensitivity (10-second confirmation)
- Deploy-caused alerts have a matching Slack message with the commit hash
- Crash-caused alerts have NO matching deploy message — immediately actionable
- If a deploy fails to become healthy, you get a warning after 10 minutes
- No monitoring gaps — the system is never paused

**Why not pause the monitor?** Because you want to know if the deploy itself breaks the health endpoint permanently. If you pause during deploy and the new version has a bug that makes `/health` return 500, you won't know until you unpause.

**Why not increase confirmation period?** Because we want to detect event loop degradation (seconds of slowness), not just multi-minute outages. A longer confirmation period hides the exact signal we're trying to capture.

### Phase 4: Deep diagnostics (for the next hard investigation)

Only pursue these if Phase 0–2 don't resolve the crash investigation.

| #   | Change                                          | What it gives us                                                                                                                                                                                                                                                                               | Effort              |
| --- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| 4a  | **`Bun.generateHeapSnapshot()` admin endpoint** | On-demand heap analysis via `GET /api/admin/heap-snapshot`. Trigger when heap passes a threshold or manually during investigation. Upload to R2.                                                                                                                                               | 1–2 hours           |
| 4b  | **Evaluate continuous profiler**                | Options: Pyroscope (Node.js SDK, may work with Bun's compat layer), `perf` + flame graphs (OS level, needs privileged container), Bun `--inspect` (Chrome DevTools, not for always-on). Even on-demand profiling that we can activate when lag alerts fire would answer root cause in minutes. | 1–2 days evaluation |
| 4c  | **Persistent K8s events**                       | Export K8s events to BetterStack before they expire (1-hour default). CronJob or sidecar. Gives historical crash metadata across weeks.                                                                                                                                                        | 2–4 hours           |
| 4d  | **Runbook: "cloud-prod is crash-looping"**      | Document: check BetterStack dashboard → check event loop lag → check heap → check MemoryLeakDetector → check recent deploys → escalation path. So the next person doesn't start from zero.                                                                                                     | 2–4 hours           |

---

## Using BetterStack for Everything We Can

We pay for BetterStack Telemetry (logs) and Uptime. Before adding any new tools, we should maximize what we get from them.

### What BetterStack already gives us (that we're underusing)

| Feature                                | Status                                                                                          | Action needed                                               |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **Log-based dashboards**               | ✅ Built — [dashboard 971353](https://telemetry.betterstack.com/team/t329093/dashboards/971353) | Expand with Phase 1 metrics                                 |
| **ClickHouse queries on logs**         | ✅ Using (via MCP tools)                                                                        | Keep using for ad-hoc investigation                         |
| **Uptime monitoring**                  | ✅ Running since June 2025                                                                      | Stop ignoring the alerts + add deploy annotations           |
| **Uptime incident history**            | ✅ 69 incidents since Feb 18 — this IS our crash history                                        | Use for tracking crash frequency over time                  |
| **Uptime response time monitoring**    | ❌ Not configured                                                                               | Add a response-time monitor (Phase 2d) to catch degradation |
| **MCP tools for dashboard management** | ✅ Available — we used them to build the dashboard                                              | Use for all future dashboard/chart changes                  |

### What BetterStack does NOT give us (would need another tool)

| Need                             | Why BetterStack can't do it                                                                                              | Options                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| **CPU profiling / flame graphs** | BetterStack is logs + uptime, not APM. No code-level profiling.                                                          | Pyroscope, Datadog APM, `perf` + manual flame graphs             |
| **Heap snapshots**               | BetterStack can store the snapshot as a log, but can't analyze object retention graphs.                                  | `Bun.generateHeapSnapshot()` → R2 → Chrome DevTools for analysis |
| **GC pause metrics**             | Bun/JSC doesn't expose GC pause duration via standard APIs. BetterStack can't instrument the runtime.                    | Bun `--inspect`, or infer from event loop lag patterns           |
| **Distributed tracing**          | BetterStack supports spans/traces, but we don't emit them. Would need OpenTelemetry instrumentation in the cloud server. | Future work — not needed for current crash investigation         |

---

## How We Know This Is Working

### Success criteria for each phase

**Phase 0 (bug fixes):**

- Crash frequency drops from ~8/day to <2/day within 48 hours
- MemoryLeakDetector "Potential leak" warnings drop to near-zero
- "High memory usage detected" warnings drop significantly
- If crashes DON'T decrease: the leaks weren't the primary cause, and Phase 1 metrics become critical for identifying what is

**Phase 1 (metrics):**

- Event loop lag data is visible in BetterStack logs and queryable
- The BetterStack dashboard shows heap and lag trends over time
- When a crash happens, we can see the degradation curve in the dashboard (lag climbing from 10ms → 100ms → 500ms → timeout)
- We can answer "what was the event loop lag 5 minutes before the crash?" without grepping raw logs

**Phase 2 (alerting):**

- Deploy-caused alerts have matching Slack messages — no false-positive confusion
- Crash-caused alerts have no matching deploy message — immediately actionable
- Response time alerts fire BEFORE the pod is killed — we see degradation, not just death
- Nobody ignores alerts because every alert means something

**Phase 3 (deploy noise):**

- Zero monitoring sensitivity is lost — 10-second confirmation period stays
- Every deploy has a corresponding Slack annotation
- When the alert fires, the first thing you see in Slack tells you whether to investigate or ignore

---

## Summary: What to Do in What Order

```
Phase 0: Fix the bugs (1-2 hours of code, then deploy and observe 24-48h)
  ↓
  If crashes stop → Phase 1 + 2 for future prevention
  If crashes continue → Phase 1 is URGENT (need the metrics to find what else is wrong)
  ↓
Phase 1: Add metrics to the server (2-3 hours of code)
  ↓
Phase 2: Dashboards + alerting + deploy noise fix (3-5 hours)
  ↓
Phase 4: Deep diagnostics (only if needed — 2-3 days)
```

**Total effort to Phase 2: ~1-2 days of work.** After that, the next crash investigation takes 30 minutes.

---

## Open Questions (for review)

1. **Phase 0 first, or Phase 1 first?** Deploying bug fixes first means we might fix the crashes but learn nothing about why. Deploying metrics first means we suffer through more crashes but get data. Recommendation: Phase 0 first (stop the bleeding), but deploy Phase 1a (event loop lag logging) at the same time so we capture data from the remaining crashes if any.

2. **Liveness probe: `/livez` vs keeping `/health`?** The proposal separates them. Argument for: `/health` does too much work for a liveness check. Argument against: adds complexity, one more endpoint to maintain. If we keep `/health` as the liveness target, we should at least increase the timeout from 1s to 3s.

3. **Porter YAML probe config:** Porter may not support separate liveness/readiness probe configuration in the YAML format. Need to verify. If not, we may need to use a custom Helm values override or accept the combined probe.

4. **BetterStack response time monitor:** The existing monitor checks for keyword `"status":"ok"`. Adding a separate response-time monitor means two monitors for the same endpoint. Is that fine, or should we reconfigure the existing one?

5. **Slack deploy annotations:** Which Slack channel? Does the team already have a `#deploys` channel, or should alerts go to a general engineering channel?

6. **How long to observe after Phase 0 before moving to Phase 1?** 24 hours? 48 hours? A week? If crashes drop to zero, there's less urgency on metrics, but they're still worth having.
