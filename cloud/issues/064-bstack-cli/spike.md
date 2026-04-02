# Spike: BetterStack CLI Tool, Inventory & Runbooks

## Overview

**What this doc covers:** Design for `bstack` — a CLI tool that wraps BetterStack's SQL API with pre-built SRE queries, plus an inventory of all BetterStack resources and runbooks for common incidents.
**Why this doc exists:** The crash investigation (issues 057-063) took days instead of minutes because we had no reliable way to query observability data. The BetterStack MCP tools break frequently, constructing raw ClickHouse SQL via curl is error-prone, and there's no documentation of what resources exist in BetterStack or how to use them. This tool enables any engineer (or AI agent) to diagnose production issues in minutes.
**Who should read this:** Anyone working on cloud infrastructure, on-call, or investigating incidents.

**Depends on:**

- [057-cloud-observability](../057-cloud-observability/) — observability infrastructure
- [061-crash-investigation](../061-crash-investigation/) — crash diagnostics
- [062-mongodb-latency](../062-mongodb-latency/) — app cache, operation timing, gap detector

---

## Background

### The problem we hit repeatedly

During the March 27-28 crash investigation:

1. BetterStack MCP tools were unavailable for large portions of the investigation
2. We had to construct ClickHouse SQL from scratch every time, remembering table names, source IDs, JSON field paths
3. We didn't know which BetterStack source had which data (old vs new, logs vs collector metrics)
4. There was no way to quickly answer "what happened before this crash?"
5. Multiple engineers had set up resources in BetterStack without documenting them
6. When things broke, there was no step-by-step guide for what to check

### What exists today

| Resource                                                                                 | Status                                                                 | Documented?         |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------- |
| AugmentOS log source (ID 1311181)                                                        | Active — receives dev/local + France/East Asia prod (until redeployed) | Only in CONTEXT.md  |
| MentraCloud-Prod log source (ID 2324289)                                                 | Active — receives US Central/West/East prod + staging                  | Only in CONTEXT.md  |
| Collectors on 5 clusters                                                                 | Running — container metrics                                            | Only in CONTEXT.md  |
| SRE Dashboard (ID 973977)                                                                | Built — US Central collector metrics                                   | Not documented      |
| Uptime monitors (7 total)                                                                | Active                                                                 | Not documented      |
| ClickHouse SQL API credentials                                                           | In Doppler                                                             | Not documented      |
| Diagnostic log features (gc-probe, event-loop-gap, system-vitals, slow-query, app-cache) | Shipping to prod                                                       | Only in issue specs |

None of this is accessible via a simple CLI command.

---

## Design: `bstack` CLI

### Location

```
cloud/tools/bstack/
├── bstack.ts              # Main CLI entry point
├── README.md              # Installation, configuration, usage
├── config.ts              # Source IDs, table names, credentials
├── queries/               # Pre-built SQL query templates
│   ├── crash-timeline.sql
│   ├── memory-trend.sql
│   ├── slow-queries.sql
│   ├── operation-budget.sql
│   ├── region-health.sql
│   ├── gc-probes.sql
│   ├── event-loop-gaps.sql
│   └── diagnostics.sql
├── runbooks/              # Step-by-step incident response
│   ├── pod-crash.md
│   ├── high-memory.md
│   ├── deploy-issues.md
│   ├── region-down.md
│   └── new-region-setup.md
├── inventory.md           # Complete BetterStack resource inventory
└── manual-operations.md   # Things that require the UI or API directly
```

### Commands

```bash
# Quick health check across all regions
bstack health

# What happened before the last crash?
bstack crash-timeline --region us-central

# Memory trend over time
bstack memory --region us-central --duration 1h

# Full diagnostics (GC, MongoDB, operation budget, gaps)
bstack diagnostics --region france

# Slow MongoDB queries
bstack slow-queries --region us-central --duration 30m

# Recent incidents from uptime monitoring
bstack incidents --limit 10

# GC probe analysis
bstack gc --region us-central --duration 1h

# Event loop gap analysis
bstack gaps --region us-central --duration 1h

# Operation budget (what's consuming CPU)
bstack budget --region us-central --duration 30m

# App cache status
bstack cache --region us-central

# List all sources and their status
bstack sources

# Raw SQL query
bstack sql "SELECT count() FROM remote(t373499_mentracloud_prod_logs) WHERE dt >= now() - INTERVAL 5 MINUTE"

# Open a runbook
bstack runbook pod-crash
```

### Configuration

The tool reads credentials from environment variables (which come from Doppler or `.env`):

```
BETTERSTACK_SQL_USERNAME    # ClickHouse HTTP API username
BETTERSTACK_SQL_PASSWORD    # ClickHouse HTTP API password
BETTERSTACK_API_TOKEN       # Management API token (for uptime, sources)
```

Source IDs and table names are hardcoded in `config.ts`:

```typescript
export const SOURCES = {
  prod: {
    id: 2324289,
    name: "MentraCloud - Prod",
    logsTable: "remote(t373499_mentracloud_prod_logs)",
    historicalTable: "s3Cluster(primary, t373499_mentracloud_prod_s3)",
    metricsTable: "remote(t373499_mentracloud_prod_metrics)",
  },
  dev: {
    id: 1311181,
    name: "AugmentOS (dev/local)",
    logsTable: "remote(t373499_augmentos_logs)",
    historicalTable: "s3Cluster(primary, t373499_augmentos_s3)",
    metricsTable: "remote(t373499_augmentos_metrics)",
  },
  collectors: {
    usCentral: {id: 2321796, table: "remote(t373499_mentra_us_central_metrics)"},
    france: {id: 2326580, table: "remote(t373499_mentra_france_metrics)"},
    eastAsia: {id: 2326583, table: "remote(t373499_mentra_east_asia_metrics)"},
    usWest: {id: 2326586, table: "remote(t373499_mentra_us_west_metrics)"},
    usEast: {id: 2326589, table: "remote(t373499_mentra_us_east_metrics)"},
  },
}

export const UPTIME_MONITORS = {
  prod: 3355604,
  global: 3355611,
}

export const SQL_ENDPOINT = "https://eu-nbg-2-connect.betterstackdata.com"
```

### Query Templates

Each `.sql` file is a parameterized template. The CLI substitutes `{{region}}`, `{{duration}}`, `{{source}}` at runtime.

Example — `crash-timeline.sql`:

```sql
-- Shows what happened in the minutes before a crash
-- Parameters: {{region}}, {{duration}} (default: 10 MINUTE)
SELECT
  dt,
  JSONExtract(raw, 'feature', 'Nullable(String)') AS feature,
  JSONExtract(raw, 'message', 'Nullable(String)') AS message,
  JSONExtract(raw, 'gcDurationMs', 'Nullable(Float64)') AS gc_ms,
  JSONExtract(raw, 'gapMs', 'Nullable(Float64)') AS gap_ms,
  JSONExtract(raw, 'mongoTotalBlockingMs', 'Nullable(Float64)') AS mongo_ms,
  JSONExtract(raw, 'opBudgetUsedPct', 'Nullable(Float64)') AS budget_pct,
  JSONExtract(raw, 'rssMB', 'Nullable(Float64)') AS rss_mb,
  JSONExtract(raw, 'activeSessions', 'Nullable(Int32)') AS sessions
FROM {{source}}
WHERE dt >= now() - INTERVAL {{duration}}
  AND JSONExtract(raw, 'region', 'Nullable(String)') = '{{region}}'
  AND JSONExtract(raw, 'server', 'Nullable(String)') = 'cloud-prod'
  AND JSONExtract(raw, 'feature', 'Nullable(String)') IN (
    'gc-probe', 'event-loop-gap', 'system-vitals', 'slow-query',
    'app-cache', 'gc-after-disconnect', 'health-timing', 'soniox-timing'
  )
ORDER BY dt DESC
LIMIT 100
```

### Implementation

Simple Bun script. No dependencies beyond what's already in the monorepo.

```typescript
// Pseudocode
const args = parseArgs(process.argv)
const command = args[0] // "health", "crash-timeline", "diagnostics", etc.

// Load credentials from env
const username = process.env.BETTERSTACK_SQL_USERNAME
const password = process.env.BETTERSTACK_SQL_PASSWORD

// Load and parameterize the query template
const sql = loadQuery(command, args)

// Execute against BetterStack SQL API
const result = await fetch(SQL_ENDPOINT, {
  method: "POST",
  headers: {"Content-type": "plain/text", "Authorization": basicAuth(username, password)},
  body: sql + " FORMAT JSON",
})

// Format and display
const data = await result.json()
formatTable(data)
```

---

## Design: Inventory

`inventory.md` documents every BetterStack resource with:

- **What it is** — name, ID, type
- **What it's for** — why it exists, what data it holds
- **How it was created** — CLI command, UI steps, or API call
- **How to recreate** — if it gets deleted or we need to replicate

This is the "if I joined the team today, what do I need to know about our observability stack?" document.

---

## Design: Runbooks

Each runbook follows a standard template:

```markdown
# [Incident Type]

## Trigger

What alert or symptom brought you here.

## Quick Check (30 seconds)

One or two bstack commands to confirm the problem.

## Diagnose (2-5 minutes)

Step-by-step commands to narrow down the cause.
Each step has expected output and what it means.

## Fix

For each possible cause, what to do.
Include the exact commands.

## Verify

How to confirm the fix worked.

## Prevent

What to change so this doesn't happen again.
Link to the relevant issue if a fix is in progress.

## History

Previous occurrences and what we learned.
```

### Initial runbooks to write (based on incidents we've already handled):

| Runbook               | Trigger                                   | Based on                                              |
| --------------------- | ----------------------------------------- | ----------------------------------------------------- |
| `pod-crash.md`        | Uptime alert: 503 or timeout              | Issues 055-063, the entire crash investigation        |
| `high-memory.md`      | RSS > 800MB alert (when we set it up)     | Issue 061 findings — memory growth chain              |
| `deploy-issues.md`    | 503 errors during/after deploy            | Issue 063 — graceful shutdown                         |
| `region-down.md`      | A region's health endpoint is unreachable | East Asia issues during this investigation            |
| `new-region-setup.md` | Adding US West/East — full checklist      | Issue 058 — Doppler, Cloudflare, collectors, Porter   |
| `doppler-env-sync.md` | Env vars out of sync or stale             | Issue 058 — the Doppler migration, manual var cleanup |

---

## Gaps This Fills

| Before                                               | After                                                     |
| ---------------------------------------------------- | --------------------------------------------------------- |
| BetterStack MCP breaks → can't query anything        | `bstack` CLI works every time via curl                    |
| Don't know which source to query                     | `bstack` knows — config.ts maps sources                   |
| Construct SQL from scratch every time                | Pre-built queries with parameter substitution             |
| No documentation of what exists in BetterStack       | inventory.md — complete resource catalog                  |
| No step-by-step incident response                    | Runbooks for every incident type we've hit                |
| AI agent needs to rediscover everything each session | CONTEXT.md + inventory.md + runbooks = instant context    |
| New engineer can't investigate prod                  | `bstack health` + `bstack runbook pod-crash` = self-serve |

---

## Effort Estimate

| Component                                                                | Effort    | Priority                                            |
| ------------------------------------------------------------------------ | --------- | --------------------------------------------------- |
| `bstack.ts` CLI with core commands (health, diagnostics, sql, incidents) | 2-3 hours | 🔴 High — unblocks everything                       |
| Pre-built query templates (8 queries)                                    | 1 hour    | 🔴 High — the value of the CLI                      |
| `config.ts` with all source IDs and tables                               | 30 min    | 🔴 High — required for CLI                          |
| `inventory.md`                                                           | 1 hour    | 🟡 Medium — captures today's knowledge              |
| `README.md`                                                              | 30 min    | 🟡 Medium — usage docs                              |
| Runbooks (6 initial)                                                     | 2-3 hours | 🟡 Medium — based on incidents we've already solved |
| `manual-operations.md`                                                   | 30 min    | 🟢 Low — reference doc                              |

**Total: ~8-10 hours.** The CLI itself is ~3 hours. The rest is documentation that captures knowledge we already have but haven't written down.

---

## Next Steps

1. Build `bstack.ts` with core commands
2. Write `config.ts` with all source/collector IDs
3. Create query templates for the 8 most common SRE queries
4. Write `inventory.md` from CONTEXT.md + what we learned today
5. Write `README.md` with installation and usage
6. Write initial runbooks from the incidents we've already handled
7. Use `bstack` to do a thorough prod investigation
8. Write a report
