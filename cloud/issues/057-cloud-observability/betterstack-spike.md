# Spike: BetterStack — Full Platform Audit

## Overview

**What this doc covers:** Everything BetterStack offers as a platform, what we currently use, what we're paying for but not using, and what to enable to get full observability without adding any other tools.
**Why this doc exists:** We've been using BetterStack as "just a logging tool" while it's actually a complete observability platform — logs, metrics, tracing, error tracking, uptime, incident management, on-call, status pages, and AI-assisted debugging. We're leaving most of it on the table.
**Who should read this:** Cloud engineers, anyone setting up monitoring or debugging production issues.

---

## What BetterStack Actually Is

BetterStack is not one tool. It's six products under one roof:

| Product                    | What it does                                                       | Do we use it?                                                                                   |
| -------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| **Telemetry — Logs**       | Structured log ingestion, search, ClickHouse queries               | ✅ Yes — our primary logging pipeline via pino                                                  |
| **Telemetry — Metrics**    | Time-series metrics via OpenTelemetry or Prometheus scraping       | ⚠️ Just started — BetterStack Collector installed on US Central, metrics flowing                |
| **Telemetry — Tracing**    | Distributed traces via eBPF or OpenTelemetry SDK                   | ⚠️ Collector has eBPF tracing enabled, not yet verified                                         |
| **Telemetry — Dashboards** | ClickHouse-powered charts on metrics data, with alerting           | ⚠️ Tried, hit issues with log-based queries. Works with proper metrics data from the collector. |
| **Uptime**                 | URL monitoring, keyword checks, response time monitoring           | ✅ Yes — monitoring `prod.augmentos.cloud/health` since June 2025. 69 incidents in March.       |
| **Error Tracking**         | Sentry-compatible exception tracking with AI-generated fix prompts | ❌ Not set up                                                                                   |
| **Incident Management**    | Create/acknowledge/resolve incidents, escalation policies          | ⚠️ Auto-created from Uptime alerts, but we ignore them                                          |
| **On-Call Scheduling**     | Rotation schedules, escalation chains, phone/SMS/Slack alerts      | ❌ Not set up                                                                                   |
| **Status Pages**           | Public status page for users                                       | ❌ Not set up (or not actively used)                                                            |
| **AI SRE**                 | Claude-powered root cause analysis using your telemetry data       | ❌ Not set up                                                                                   |
| **MCP Server**             | Connect AI assistants (Claude Code, Cursor) to your telemetry      | ✅ Yes — we used it this entire investigation to query logs, build dashboards, manage monitors  |

---

## What We Currently Use

### Telemetry — Logs (source: AugmentOS, ID 1311181)

**How it works:** The cloud server uses pino logger → pino sends structured JSON to BetterStack's ingestion endpoint over HTTPS. Every log line from the server appears in BetterStack Live Tail and is queryable via ClickHouse.

**What's configured:**

- Source: `AugmentOS` (JavaScript platform)
- Ingesting host: `s1311181.eu-nbg-2.betterstackdata.com`
- Data region: `eu-nbg-2`
- Logs retention: default (likely 30 days on current plan)
- Data started flowing: March 18, 2026

**What's NOT configured:**

- `MEMORY_TELEMETRY_ENABLED=true` — already built in the code, logs per-session memory breakdowns every 10 minutes. Disabled in all environments since it was built. Three separate issues have recommended enabling it.

### Uptime (monitor ID 3355604)

**How it works:** BetterStack hits `https://prod.augmentos.cloud/health` every 60 seconds from US region. Checks for keyword `"status":"ok"`. If it fails → creates an incident.

**What's configured:**

- Check frequency: 60 seconds
- Request timeout: 15 seconds
- Confirmation period: 10 seconds (very sensitive — fires on brief interruptions including deploys)
- Recovery period: 180 seconds
- Required keyword: `"status":"ok"`

**What's NOT configured:**

- No response-time threshold monitor (would catch degradation before crash)
- No separate monitors for other regions/clusters
- No heartbeat monitors for background jobs
- Alerts go to email but we've learned to ignore them because deploys look identical to crashes

### Telemetry — Metrics (source: mentra-us-central, ID 2321796)

**How it works:** BetterStack Collector installed via Helm on the US Central Porter cluster. Uses eBPF to auto-instrument all containers. Sends metrics to BetterStack.

**What's flowing (as of today):**

- `container_resources_cpu_usage_seconds_total` — CPU per container
- `container_resources_memory_rss_bytes` — RSS memory per container
- `container_resources_memory_limit_bytes` — memory limits
- `container_restarts_total` — restart count per container
- `container_http_requests_total` — HTTP request count
- `container_http_requests_duration_seconds_total` — HTTP latency
- `container_net_tcp_*` — network metrics
- `node_cpu_seconds_total` — node-level CPU
- Plus ~40 other metric names

**What's enabled on the collector:**

- Kubernetes logs collection
- eBPF metrics (container-level)
- eBPF RED metrics (request rate, error rate, duration per service)
- Database metrics (auto-discovers MongoDB, Postgres, Redis)
- OpenTelemetry trace acceptance (ports 4317/4318)

**What's NOT done:**

- Collector only on US Central cluster (4689). Not on East Asia (4754), France (4696), US West (4965), or US East (4977).
- Prometheus scrape annotations not added to cloud-prod pods yet (would scrape our existing `/metrics` endpoint)
- No dashboards built from this metrics data yet

---

## What We're NOT Using But Should Be

### 1. Error Tracking — Sentry-compatible, AI-native

**What it is:** BetterStack has a full error tracking product that uses the standard Sentry SDK. You install `@sentry/bun` (or `@sentry/node`), point the DSN at BetterStack instead of Sentry, and get:

- Automatic unhandled exception capture with full stack traces
- Breadcrumbs (sequence of events leading to the error)
- Release tracking (which deploy introduced the error)
- Error grouping and deduplication
- AI-generated fix prompts — BetterStack summarizes the error context into a prompt you can paste into Claude Code or Cursor
- Sentry SDK compatibility — 100+ platforms supported

**Why we need it:** Right now our error tracking is:

- `logger.error()` calls scattered through the code
- grep through BetterStack logs to find errors
- The incident system we built (which files bug reports to R2/Linear)

Proper error tracking would:

- Capture every unhandled exception automatically (no manual `logger.error()` needed)
- Group duplicate errors so we see "this error happened 3,000 times" not 3,000 separate log lines
- Show the exact stack trace, breadcrumbs, and environment for each error
- Track which release introduced new errors
- Alert on new error patterns (not just "the server is down")

**Pricing:** ~$0.00005 per event. At our log volume, likely negligible compared to what we already pay for logs.

**Setup effort:** Install `@sentry/bun`, configure DSN to point at BetterStack, add to server initialization. ~30 minutes.

**How to set up:**

1. Create an error tracking application in BetterStack (platform: `bun_errors` or `node_errors`)
2. Get the DSN from BetterStack
3. Install `@sentry/bun` in the cloud package
4. Initialize in `index.ts`:

```ts
import * as Sentry from "@sentry/bun"
Sentry.init({
  dsn: "https://...@errors.betterstack.com/...",
  release: process.env.PORTER_IMAGE_TAG,
  environment: process.env.NODE_ENV,
})
```

### 2. Dashboard Alerts — threshold and anomaly detection

**What it is:** Any chart on a BetterStack dashboard can have an alert attached. Three types:

- **Threshold alerts:** "Alert when this metric crosses X" — e.g., CPU > 80%, error rate > 100/min, restart count > 2/hour
- **Relative alerts:** "Alert when this metric changes by X% compared to last hour/day/week"
- **Anomaly detection:** "Alert when this metric deviates significantly from its predicted value" — no threshold needed, BetterStack learns the pattern

Alerts integrate with BetterStack Uptime for escalation — so they can page, Slack, email, call.

**Why we need it:** We have zero proactive alerting on application metrics. We only find out about problems when users report them or the server crashes. With the collector now sending metrics, we can set up:

- Alert when `container_restarts_total` increases (crash detected)
- Alert when `container_resources_cpu_usage_seconds_total` exceeds 80% sustained
- Alert when `container_resources_memory_rss_bytes` exceeds 75% of limit
- Alert when HTTP error rate spikes
- Anomaly detection on request latency (catches degradation without needing a threshold)

**Setup effort:** Build a dashboard from collector metrics, click the alert icon on each chart, configure threshold. ~1-2 hours once metrics are flowing.

### 3. Response-Time Uptime Monitor

**What it is:** A second uptime monitor on the same URL, but configured to alert when response time exceeds a threshold (e.g., >3 seconds for 2 minutes). The existing monitor catches "down." This catches "slow."

**Why we need it:** The event loop degrades gradually before a crash: 50ms → 500ms → 2s → timeout. The current monitor only fires at the "timeout" stage. A response-time monitor fires at the "2 second" stage — minutes before the kill.

**Setup effort:** Create a new monitor in BetterStack Uptime UI or API. 5 minutes.

### 4. On-Call Scheduling

**What it is:** Define who gets alerted when, with rotation schedules and escalation policies. "If Isaiah doesn't acknowledge in 5 minutes, call Alex."

**Why we need it (eventually):** Right now there's no defined escalation path. Alerts fire, nobody is designated to respond. As the team grows, this becomes critical. Not urgent for a 2-person team, but the infrastructure is free in BetterStack.

### 5. AI SRE

**What it is:** BetterStack's AI assistant that has access to all your telemetry data. It can:

- Analyze incidents and suggest root causes
- Query logs and metrics on your behalf
- Correlate events across services
- Generate hypotheses based on your service map

**Why it's interesting:** It's essentially what we did manually during the 055/056 investigation — query BetterStack, look at crash patterns, correlate metrics — but automated. Worth evaluating once we have proper metrics flowing.

### 6. Collector on All Clusters

**What it is:** The BetterStack Collector we just installed on US Central needs to be on all 5 clusters.

| Cluster    | ID   | Collector installed?    |
| ---------- | ---- | ----------------------- |
| US Central | 4689 | ✅ Yes (just installed) |
| East Asia  | 4754 | ❌ No                   |
| France     | 4696 | ❌ No                   |
| US West    | 4965 | ❌ No                   |
| US East    | 4977 | ❌ No                   |

Each cluster needs its own collector instance (create in BetterStack, get secret, install via Porter Add-ons or `porter helm --`). Same process we just did for US Central.

### 7. Prometheus Scrape Annotations

**What it is:** The collector auto-discovers pods with `prometheus.io/scrape: "true"` annotations and scrapes their `/metrics` endpoint. Our cloud server already has a `/metrics` endpoint with Prometheus-format gauges (session count, message rates, etc.). Nobody scrapes it.

**What to do:** Add pod annotations to `porter.yaml`:

```yaml
podAnnotations:
  prometheus.io/scrape: "true"
  prometheus.io/path: "/metrics"
  prometheus.io/port: "80"
```

If Porter's YAML format doesn't support `podAnnotations`, configure via Porter dashboard.

Once annotated, the collector scrapes the endpoint automatically and the metrics appear in BetterStack dashboards.

---

## What We're Paying For

BetterStack pricing is usage-based. We're currently paying for:

- **Log ingestion** — ~20M lines/day from the AugmentOS source
- **Uptime monitoring** — 7 monitors (most are free tier)
- **Log retention** — default retention period

We're NOT paying for (because we're not using):

- Error tracking (per-event pricing, ~$0.00005/event)
- Additional metrics from the collector (metrics retention is included)
- Additional uptime monitors (included in plan)
- On-call seats (included in plan)
- Status pages (included in plan)

The collector, dashboards, alerts, and most features are included in the existing plan. We're paying for a platform and using 20% of it.

---

## The Full Vision: Everything Enabled

If we snapped our fingers and had everything set up:

```
BetterStack Telemetry
├── Logs (AugmentOS source) ← HAVE THIS
│   ├── Cloud server structured logs via pino
│   ├── Memory telemetry every 10 min ← NEED TO ENABLE ENV VAR
│   └── Event loop lag warnings ← NEED CODE CHANGE
│
├── Metrics (Collector sources × 5 clusters)
│   ├── Container CPU, memory, restarts ← HAVE ON US-CENTRAL
│   ├── HTTP request rate, error rate, latency (eBPF RED) ← HAVE ON US-CENTRAL
│   ├── MongoDB auto-discovered metrics ← HAVE ON US-CENTRAL
│   ├── Node-level CPU, memory, disk, network ← HAVE ON US-CENTRAL
│   ├── Prometheus scrape of /metrics endpoint ← NEED POD ANNOTATIONS
│   └── Application metrics (event loop lag, heap, sessions) ← NEED CODE (OTel SDK or Prometheus gauges)
│
├── Tracing (eBPF + OpenTelemetry)
│   ├── Auto-instrumented eBPF traces ← ENABLED ON COLLECTOR
│   └── Application-level spans (Soniox calls, webhook calls) ← FUTURE
│
├── Error Tracking
│   ├── Unhandled exceptions with stack traces ← NEED @sentry/bun SETUP
│   ├── Error grouping and deduplication ← COMES WITH SETUP
│   ├── Release tracking (by PORTER_IMAGE_TAG) ← COMES WITH SETUP
│   └── AI fix prompts for Claude Code ← COMES WITH SETUP
│
└── Dashboards + Alerts
    ├── Cloud-Prod Health dashboard (CPU, memory, restarts, latency) ← NEED TO BUILD FROM COLLECTOR METRICS
    ├── Threshold alerts (CPU > 80%, restarts > 2/hr, etc.) ← NEED TO CONFIGURE
    └── Anomaly detection on latency ← NEED TO CONFIGURE

BetterStack Uptime
├── Availability monitor (prod.augmentos.cloud/health) ← HAVE THIS
├── Response-time monitor (alert at >3s sustained) ← NEED TO CREATE
├── Monitors for other regions ← NICE TO HAVE
└── Heartbeat monitors for background jobs ← FUTURE

BetterStack Incident Management
├── Auto-incidents from uptime alerts ← HAVE THIS (IGNORED)
├── Deploy annotations (Slack from GitHub Actions) ← NEED TO BUILD
├── On-call scheduling ← FUTURE
└── Escalation policies ← FUTURE

BetterStack AI SRE
└── Evaluate once metrics + error tracking are flowing ← FUTURE
```

---

## Priority Order: What to Enable Now vs. Later

### Now (this hotfix cycle)

| #   | What                                                                                     | Effort  | Why now                                                                                                                     |
| --- | ---------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | Add application metrics to `/metrics` endpoint (event loop lag, heap, sessions, streams) | 4-6 hrs | The collector will scrape these automatically once we add pod annotations. This gives us the data we need to debug crashes. |
| 2   | Add Prometheus scrape annotations to porter.yaml                                         | 15 min  | Connects our existing `/metrics` to the collector already running.                                                          |
| 3   | Enable `MEMORY_TELEMETRY_ENABLED=true`                                                   | 5 min   | Built, disabled, recommended 3 times. Just flip the switch.                                                                 |
| 4   | Create response-time uptime monitor                                                      | 5 min   | Catches degradation before crash. Uses existing BetterStack Uptime.                                                         |
| 5   | Build dashboard from collector metrics                                                   | 1-2 hrs | Container CPU, memory, restarts, HTTP latency — all from data already flowing.                                              |
| 6   | Set up error tracking (`@sentry/bun` → BetterStack)                                      | 30 min  | Automatic exception capture. Replaces manual `logger.error()` for unhandled exceptions.                                     |

### Soon (next 2 weeks)

| #   | What                                                            | Effort  | Why soon                                                                             |
| --- | --------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------ |
| 7   | Install collector on remaining 4 clusters                       | 1 hr    | Same process as US Central, repeated per cluster.                                    |
| 8   | Configure dashboard alerts (CPU, memory, restarts, error rate)  | 1-2 hrs | Proactive alerting instead of reactive investigation.                                |
| 9   | Deploy annotations (Slack from GitHub Actions)                  | 1-2 hrs | Makes every uptime alert actionable.                                                 |
| 10  | Build dashboard from application metrics (once flowing from #1) | 1-2 hrs | Event loop lag, heap, sessions over time — the data that answers "why did it crash?" |

### Later (next month+)

| #   | What                                             | Why later                                                        |
| --- | ------------------------------------------------ | ---------------------------------------------------------------- |
| 11  | On-call scheduling                               | Small team — not urgent until team grows                         |
| 12  | Status page                                      | Customer-facing — important but not blocking crash investigation |
| 13  | AI SRE evaluation                                | Needs metrics + error tracking flowing first                     |
| 14  | OpenTelemetry SDK spans for Soniox/webhook calls | Distributed tracing — useful but not the current bottleneck      |

---

## Separate BetterStack Sources Per Environment

### The problem

All environments (cloud-prod, cloud-local, cloud-staging, cloud-dev) send logs to the same BetterStack source (AugmentOS, ID 1311181). On March 25:

| Server        | Logs/day  | % of total |
| ------------- | --------- | ---------- |
| cloud-prod    | 11.3M     | 53%        |
| cloud-local   | 7.6M      | 36%        |
| cloud-staging | 1.9M      | 9%         |
| cloud-dev     | 463K      | 2%         |
| **Total**     | **21.3M** |            |

Nearly half the logs are from non-prod. Every query needs `WHERE server = 'cloud-prod'` to filter. Prod and local data mix in Live Tail. We pay the same retention rate for local dev logs as for production.

**Local logs going to BetterStack is intentional and useful** — the server generates millions of logs locally and there's no local tool that can search them. BetterStack's search, Live Tail, and ClickHouse queries are the only practical way to debug locally. We need to keep this capability.

### The fix: separate sources

| Environment                 | BetterStack Source                      | Token                      | Status                          |
| --------------------------- | --------------------------------------- | -------------------------- | ------------------------------- |
| **cloud-prod**              | AugmentOS (ID 1311181)                  | *(in cloud/.env as BETTERSTACK_SOURCE_TOKEN)* | ✅ Existing — keep as prod-only |
| **cloud-local + cloud-dev** | MentraOS Cloud - Dev/Local (ID 2324210) | *(see cloud/.env)* | ✅ Just created                 |
| **cloud-staging**           | Create separately                       | TBD                        | ❌ Not yet created              |

**What to change:**

1. Local `.env` and dev Porter env: point `BETTERSTACK_SOURCE_TOKEN` at the dev/local source token (stored in cloud/.env)
2. Staging Porter env: create a staging source, point at its token
3. Prod stays unchanged
4. Optionally: add a VRL transformation on the prod source to drop any logs where `server` is not `cloud-prod` as a safety net

**What you keep:** Full BetterStack search, Live Tail, and ClickHouse queries for local dev — just in a separate source. Same features, separate data, cleaner prod queries, lower prod retention costs.

---

## Key Takeaway

We've been treating BetterStack like a log viewer. It's actually the only tool we need for full observability — logs, metrics, traces, error tracking, uptime, alerting, incident management, and AI-assisted debugging. The collector is already installed and sending data. Most of what's left is configuration and wiring, not new tools or infrastructure.
