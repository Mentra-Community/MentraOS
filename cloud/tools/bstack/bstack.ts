#!/usr/bin/env bun
/**
 * bstack — BetterStack CLI for MentraCloud SRE
 *
 * A CLI tool that wraps BetterStack's SQL API with pre-built SRE queries.
 * Enables instant production diagnostics without constructing ClickHouse SQL by hand.
 *
 * Usage:
 *   bstack health                          # Quick health check across all regions
 *   bstack diagnostics --region us-central # Full diagnostics for a region
 *   bstack crash-timeline --region france  # What happened before the last crash
 *   bstack memory --region us-central      # Memory trend over time
 *   bstack gc --region us-central          # GC probe analysis
 *   bstack gaps --region us-central        # Event loop gap analysis
 *   bstack budget --region us-central      # Operation budget (CPU consumers)
 *   bstack slow-queries --region france    # MongoDB slow query analysis
 *   bstack cache --region us-central       # App cache status
 *   bstack incidents --limit 10            # Recent uptime incidents
 *   bstack sources                         # List all BetterStack sources
 *   bstack sql "SELECT ..."                # Raw SQL query
 *   bstack runbook pod-crash               # Open a runbook
 *
 * Environment:
 *   BETTERSTACK_USERNAME / BETTERSTACK_SQL_USERNAME  — ClickHouse HTTP API username
 *   BETTERSTACK_PASSWORD / BETTERSTACK_SQL_PASSWORD  — ClickHouse HTTP API password
 *   BETTERSTACK_API_TOKEN                            — Management API token (for uptime)
 *
 * See: cloud/issues/064-bstack-cli/spike.md
 * See: cloud/tools/bstack/inventory.md
 */

export {}

import {
  SQL_ENDPOINT,
  SQL_USERNAME,
  SQL_PASSWORD,
  API_TOKEN,
  UPTIME_API,
  LOG_SOURCES,
  COLLECTORS,
  UPTIME_MONITORS,
  DASHBOARDS,
  REGIONS,
  DIAGNOSTIC_FEATURES,
  validateSqlCredentials,
  validateApiToken,
  getLogsTable,
  getCollectorTable,
  getAllRegions,
} from "./config"

// ---------------------------------------------------------------------------
// Doppler auto-load for SRE credentials
// ---------------------------------------------------------------------------
// If BETTERSTACK_USERNAME isn't set, try loading from Doppler mentra-sre project.
// This means you can just run `bstack health` without wrapping in `doppler run`.

function tryDopplerLoad(): void {
  if (SQL_USERNAME && SQL_PASSWORD) return // Already set

  try {
    const {execSync} = require("child_process")
    const get = (key: string): string =>
      execSync(`doppler secrets get ${key} --project mentra-sre --config dev --plain 2>/dev/null`, {
        encoding: "utf-8",
        timeout: 5000,
      }).trim()

    if (!process.env.BETTERSTACK_USERNAME && !process.env.BETTERSTACK_SQL_USERNAME) {
      process.env.BETTERSTACK_USERNAME = get("BETTERSTACK_USERNAME")
    }
    if (!process.env.BETTERSTACK_PASSWORD && !process.env.BETTERSTACK_SQL_PASSWORD) {
      process.env.BETTERSTACK_PASSWORD = get("BETTERSTACK_PASSWORD")
    }
    if (!process.env.BETTERSTACK_API_TOKEN) {
      try {
        process.env.BETTERSTACK_API_TOKEN = get("BETTERSTACK_API_TOKEN")
      } catch {}
    }
    if (!process.env.MENTRA_ADMIN_JWT) {
      try {
        process.env.MENTRA_ADMIN_JWT = get("MENTRA_ADMIN_JWT")
      } catch {}
    }
  } catch {
    // Doppler not installed or not configured — fall back to env vars
  }
}

tryDopplerLoad()

// Re-read after Doppler load (config.ts reads at import time, so we re-read here)
const _SQL_USERNAME = process.env.BETTERSTACK_SQL_USERNAME || process.env.BETTERSTACK_USERNAME || ""
const _SQL_PASSWORD = process.env.BETTERSTACK_SQL_PASSWORD || process.env.BETTERSTACK_PASSWORD || ""
const _API_TOKEN = process.env.BETTERSTACK_API_TOKEN || ""
const _ADMIN_JWT = process.env.MENTRA_ADMIN_JWT || ""

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length)
}

function rpad(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s
}

function parseArgs(): {command: string; flags: Record<string, string>; positional: string[]} {
  const args = process.argv.slice(2)
  const command = args[0] ?? "help"
  const flags: Record<string, string> = {}
  const positional: string[] = []

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith("--")) {
      const [key, ...val] = arg.slice(2).split("=")
      flags[key] = val.length > 0 ? val.join("=") : (args[++i] ?? "true")
    } else {
      positional.push(arg)
    }
  }

  return {command, flags, positional}
}

function getFlag(flags: Record<string, string>, name: string, defaultVal: string): string {
  return flags[name] ?? defaultVal
}

/**
 * Normalize a human-friendly duration string into ClickHouse INTERVAL syntax.
 * Accepts: "30m", "1h", "2d", "30 MINUTE", "1 HOUR", etc.
 * Returns: "30 MINUTE", "1 HOUR", "2 DAY", etc.
 */
function normalizeDuration(input: string): string {
  const match = input.match(/^(\d+)\s*(m|min|minute|h|hr|hour|d|day|s|sec|second)s?$/i)
  if (match) {
    const num = match[1]
    const unit = match[2].toLowerCase()
    if (unit.startsWith("m")) return `${num} MINUTE`
    if (unit.startsWith("h")) return `${num} HOUR`
    if (unit.startsWith("d")) return `${num} DAY`
    if (unit.startsWith("s")) return `${num} SECOND`
  }
  // Already in ClickHouse format (e.g. "30 MINUTE") or raw — pass through
  return input
}

/**
 * Pick the correct BetterStack log source table for a region.
 * France and East Asia may still be on the legacy AugmentOS source.
 */
function getSourceForRegion(region: string): string {
  if (region === "france" || region === "east-asia") {
    // These regions may still send to the legacy source until redeployed
    // with the new BETTERSTACK_SOURCE_TOKEN. Check both — prefer prod.
    return getLogsTable("prod")
  }
  return getLogsTable("prod")
}

// ---------------------------------------------------------------------------
// SQL Query Engine
// ---------------------------------------------------------------------------

interface QueryResult {
  data: Record<string, any>[]
  rows: number
  statistics?: {elapsed: number; rows_read: number; bytes_read: number}
}

/**
 * Pick the right table based on duration — hot storage for recent (<5min),
 * historical/S3 for anything older. The user never needs to think about this.
 */
function getTableForDuration(env: "prod" | "dev", duration: string): string {
  const match = duration.match(/^(\d+)\s*(MINUTE|HOUR|DAY|SECOND)/i)
  if (!match) return getLogsTable(env)

  const num = parseInt(match[1])
  const unit = match[2].toUpperCase()
  const minutes = unit === "SECOND" ? num / 60 : unit === "MINUTE" ? num : unit === "HOUR" ? num * 60 : num * 1440

  // Hot storage only reliably has the last ~5 minutes
  if (minutes <= 5) {
    return getLogsTable(env)
  }

  // Historical S3 for anything older
  return env === "prod" ? LOG_SOURCES.prod.historicalTable : LOG_SOURCES.dev.historicalTable
}

/**
 * Wrap a query with the right WHERE clause for historical tables.
 * S3 tables need `_row_type = 1` to filter to log rows.
 */
function isHistoricalTable(table: string): boolean {
  return table.includes("s3Cluster")
}

async function runSql(sql: string): Promise<QueryResult> {
  // Use Doppler-loaded creds if available
  const username = _SQL_USERNAME || SQL_USERNAME
  const password = _SQL_PASSWORD || SQL_PASSWORD

  if (!username || !password) {
    console.error("❌ BetterStack SQL credentials not set.")
    console.error("   Run: doppler run --project mentra-sre --config dev -- bstack <command>")
    console.error("   Or set BETTERSTACK_USERNAME and BETTERSTACK_PASSWORD env vars.")
    process.exit(1)
  }

  const auth = Buffer.from(`${username}:${password}`).toString("base64")
  const res = await fetch(SQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "plain/text",
      "Authorization": `Basic ${auth}`,
    },
    body: sql + " FORMAT JSON",
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`BetterStack SQL error (${res.status}): ${body.slice(0, 500)}`)
  }

  const json = (await res.json()) as any
  return {
    data: json.data ?? [],
    rows: json.rows ?? 0,
    statistics: json.statistics,
  }
}

function printTable(data: Record<string, any>[], columns?: string[]): void {
  if (data.length === 0) {
    console.log("  (no data)")
    return
  }

  const cols = columns ?? Object.keys(data[0])
  const widths = cols.map((col) => {
    const maxData = data.reduce((max, row) => {
      const val = String(row[col] ?? "")
      return val.length > max ? val.length : max
    }, 0)
    return Math.max(col.length, maxData, 4)
  })

  // Header
  console.log(cols.map((c, i) => pad(c, widths[i])).join(" │ "))
  console.log(widths.map((w) => "─".repeat(w)).join("─┼─"))

  // Rows
  for (const row of data) {
    console.log(cols.map((c, i) => pad(String(row[c] ?? ""), widths[i])).join(" │ "))
  }
}

// ---------------------------------------------------------------------------
// Uptime API
// ---------------------------------------------------------------------------

async function fetchUptime(path: string): Promise<any> {
  validateApiToken()
  const res = await fetch(`${UPTIME_API}${path}`, {
    headers: {Authorization: `Bearer ${API_TOKEN}`},
  })
  if (!res.ok) {
    throw new Error(`Uptime API error (${res.status}): ${await res.text()}`)
  }
  return res.json()
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

// ── health ──────────────────────────────────────────────────────────────────

async function cmdHealth() {
  console.log("🏥 Health Check — All Regions\n")

  const results: Record<string, any>[] = []

  for (const [regionId, region] of Object.entries(REGIONS)) {
    try {
      const res = await fetch(region.healthUrl, {signal: AbortSignal.timeout(15000)})
      if (!res.ok) {
        results.push({
          region: regionId,
          status: `HTTP ${res.status}`,
          sessions: "?",
          uptime: "?",
          rss: "?",
          lag: "?",
        })
        continue
      }
      const d = (await res.json()) as any

      // The /health response has nested fields:
      //   sessions.userSessions, eventLoop.lagMs, uptimeSeconds, rssMB, heapUsedMB
      // Also support flat fields for backward compatibility.
      const sessions = d.sessions?.userSessions ?? d.activeSessions ?? "?"
      const uptime = d.uptimeSeconds ?? "?"
      const rss = d.rssMB ?? "?"
      const lag = d.eventLoop?.lagMs ?? d.eventLoopLagMs ?? "?"
      const heap = d.heapUsedMB ?? "?"

      results.push({
        region: regionId,
        status: d.status ?? "?",
        sessions,
        uptime: `${uptime}s`,
        rss: `${rss}MB`,
        heap: `${heap}MB`,
        lag: `${typeof lag === "number" ? lag.toFixed(1) : lag}ms`,
      })
    } catch (err: any) {
      results.push({
        region: regionId,
        status: "UNREACHABLE",
        sessions: "-",
        uptime: "-",
        rss: "-",
        heap: "-",
        lag: "-",
      })
    }
  }

  printTable(results)

  // Also check uptime monitors (don't exit if token is missing)
  if (!API_TOKEN) {
    console.log("\n  (Skipping uptime monitors — BETTERSTACK_API_TOKEN not set)")
    return
  }
  try {
    const monitors = await fetchUptime("/monitors")
    console.log("\n📡 Uptime Monitors:\n")
    const monitorRows = monitors.data.map((m: any) => ({
      name: m.attributes.pronounceable_name,
      status: m.attributes.status === "up" ? "🟢 Up" : "🔴 Down",
      checked: m.attributes.last_checked_at?.slice(0, 19) ?? "?",
    }))
    printTable(monitorRows)
  } catch {
    console.log("\n  (Could not fetch uptime monitors)")
  }
}

// ── diagnostics ─────────────────────────────────────────────────────────────

async function cmdDiagnostics(flags: Record<string, string>) {
  const region = getFlag(flags, "region", "us-central")
  const duration = normalizeDuration(getFlag(flags, "duration", "30 MINUTE"))
  const source = getSourceForRegion(region)

  console.log(`🔍 Diagnostics — ${region} (last ${duration})\n`)

  // GC probes
  console.log("── GC Probes ──")
  const gc = await runSql(`
    SELECT
      round(avg(JSONExtract(raw, 'gcDurationMs', 'Nullable(Float64)')), 1) AS avg_gc_ms,
      max(JSONExtract(raw, 'gcDurationMs', 'Nullable(Float64)')) AS max_gc_ms,
      round(avg(JSONExtract(raw, 'freedMB', 'Nullable(Float64)')), 1) AS avg_freed_mb,
      round(avg(JSONExtract(raw, 'rssMB', 'Nullable(Float64)')), 0) AS avg_rss_mb,
      round(avg(JSONExtract(raw, 'activeSessions', 'Nullable(Float64)')), 0) AS avg_sessions,
      count() AS probes
    FROM ${source}
    WHERE dt >= now() - INTERVAL ${duration}
      AND JSONExtract(raw, 'region', 'Nullable(String)') = '${region}'
      AND JSONExtract(raw, 'server', 'Nullable(String)') = 'cloud-prod'
      AND JSONExtract(raw, 'feature', 'Nullable(String)') = 'gc-probe'
  `)
  printTable(gc.data)

  // Event loop gaps
  console.log("\n── Event Loop Gaps ──")
  const gaps = await runSql(`
    SELECT count() AS gap_count,
      round(avg(JSONExtract(raw, 'gapMs', 'Nullable(Float64)')), 0) AS avg_gap_ms,
      max(JSONExtract(raw, 'gapMs', 'Nullable(Float64)')) AS max_gap_ms
    FROM ${source}
    WHERE dt >= now() - INTERVAL ${duration}
      AND JSONExtract(raw, 'region', 'Nullable(String)') = '${region}'
      AND JSONExtract(raw, 'server', 'Nullable(String)') = 'cloud-prod'
      AND JSONExtract(raw, 'feature', 'Nullable(String)') = 'event-loop-gap'
  `)
  if (gaps.data[0]?.gap_count === 0 || gaps.data[0]?.gap_count === "0") {
    console.log("  ✅ No event loop gaps detected (event loop was never blocked >1s)")
  } else {
    printTable(gaps.data)
  }

  // MongoDB slow queries
  console.log("\n── MongoDB Slow Queries ──")
  const mongo = await runSql(`
    SELECT
      count() AS slow_queries,
      round(avg(JSONExtract(raw, 'durationMs', 'Nullable(Float64)')), 0) AS avg_ms,
      max(JSONExtract(raw, 'durationMs', 'Nullable(Float64)')) AS max_ms,
      round(sum(JSONExtract(raw, 'durationMs', 'Nullable(Float64)')), 0) AS total_wall_ms
    FROM ${source}
    WHERE dt >= now() - INTERVAL ${duration}
      AND JSONExtract(raw, 'region', 'Nullable(String)') = '${region}'
      AND JSONExtract(raw, 'server', 'Nullable(String)') = 'cloud-prod'
      AND JSONExtract(raw, 'feature', 'Nullable(String)') = 'slow-query'
  `)
  printTable(mongo.data)

  // Operation budget
  console.log("\n── Operation Budget (avg per 30s window) ──")
  const budget = await runSql(`
    SELECT
      round(avg(JSONExtract(raw, 'op_audioProcessing_ms', 'Nullable(Float64)')), 0) AS audio_ms,
      round(avg(JSONExtract(raw, 'op_glassesMessage_ms', 'Nullable(Float64)')), 0) AS glasses_ms,
      round(avg(JSONExtract(raw, 'op_appMessage_ms', 'Nullable(Float64)')), 0) AS app_msg_ms,
      round(avg(JSONExtract(raw, 'op_displayRendering_ms', 'Nullable(Float64)')), 0) AS display_ms,
      round(avg(JSONExtract(raw, 'opTotalMs', 'Nullable(Float64)')), 0) AS total_ms,
      round(avg(JSONExtract(raw, 'opBudgetUsedPct', 'Nullable(Float64)')), 1) AS budget_pct,
      round(avg(JSONExtract(raw, 'mongoTotalBlockingMs', 'Nullable(Float64)')), 0) AS mongo_blocking_ms,
      round(avg(JSONExtract(raw, 'totalConnections', 'Nullable(Float64)')), 0) AS connections,
      round(avg(JSONExtract(raw, 'activeSessions', 'Nullable(Float64)')), 0) AS sessions,
      round(avg(JSONExtract(raw, 'rssMB', 'Nullable(Float64)')), 0) AS rss_mb
    FROM ${source}
    WHERE dt >= now() - INTERVAL ${duration}
      AND JSONExtract(raw, 'region', 'Nullable(String)') = '${region}'
      AND JSONExtract(raw, 'server', 'Nullable(String)') = 'cloud-prod'
      AND JSONExtract(raw, 'feature', 'Nullable(String)') = 'system-vitals'
  `)
  printTable(budget.data)

  // App cache
  console.log("\n── App Cache ──")
  const cache = await runSql(`
    SELECT
      JSONExtract(raw, 'count', 'Nullable(Int32)') AS apps_cached,
      JSONExtract(raw, 'refreshMs', 'Nullable(Float64)') AS refresh_ms,
      JSONExtract(raw, 'refreshCount', 'Nullable(Int32)') AS refresh_count,
      dt
    FROM ${source}
    WHERE dt >= now() - INTERVAL ${duration}
      AND JSONExtract(raw, 'region', 'Nullable(String)') = '${region}'
      AND JSONExtract(raw, 'server', 'Nullable(String)') = 'cloud-prod'
      AND JSONExtract(raw, 'feature', 'Nullable(String)') = 'app-cache'
    ORDER BY dt DESC
    LIMIT 3
  `)
  printTable(cache.data)
}

// ── crash-timeline ──────────────────────────────────────────────────────────

async function cmdCrashTimeline(flags: Record<string, string>) {
  const region = getFlag(flags, "region", "us-central")
  const duration = normalizeDuration(getFlag(flags, "duration", "10 MINUTE"))
  const source = getSourceForRegion(region)

  console.log(`💥 Crash Timeline — ${region} (last ${duration})\n`)

  const result = await runSql(`
    SELECT
      dt,
      JSONExtract(raw, 'feature', 'Nullable(String)') AS feature,
      substring(JSONExtract(raw, 'message', 'Nullable(String)'), 1, 80) AS message,
      JSONExtract(raw, 'gcDurationMs', 'Nullable(Float64)') AS gc_ms,
      JSONExtract(raw, 'gapMs', 'Nullable(Float64)') AS gap_ms,
      JSONExtract(raw, 'mongoTotalBlockingMs', 'Nullable(Float64)') AS mongo_ms,
      JSONExtract(raw, 'opBudgetUsedPct', 'Nullable(Float64)') AS budget_pct,
      JSONExtract(raw, 'rssMB', 'Nullable(Float64)') AS rss_mb,
      JSONExtract(raw, 'activeSessions', 'Nullable(Int32)') AS sessions,
      JSONExtract(raw, 'durationMs', 'Nullable(Float64)') AS duration_ms
    FROM ${source}
    WHERE dt >= now() - INTERVAL ${duration}
      AND JSONExtract(raw, 'region', 'Nullable(String)') = '${region}'
      AND JSONExtract(raw, 'server', 'Nullable(String)') = 'cloud-prod'
      AND JSONExtract(raw, 'feature', 'Nullable(String)') IN (
        'gc-probe', 'event-loop-gap', 'system-vitals', 'slow-query',
        'app-cache', 'gc-after-disconnect', 'health-timing', 'soniox-timing'
      )
    ORDER BY dt DESC
    LIMIT 100
  `)

  printTable(result.data, ["dt", "feature", "message", "gc_ms", "gap_ms", "rss_mb", "sessions", "budget_pct"])
}

// ── memory ──────────────────────────────────────────────────────────────────

async function cmdMemory(flags: Record<string, string>) {
  const region = getFlag(flags, "region", "us-central")
  const duration = normalizeDuration(getFlag(flags, "duration", "1 HOUR"))
  const source = getSourceForRegion(region)

  console.log(`📈 Memory Trend — ${region} (last ${duration})\n`)

  const result = await runSql(`
    SELECT
      toStartOfInterval(dt, INTERVAL 5 MINUTE) AS time,
      round(avg(JSONExtract(raw, 'rssMB', 'Nullable(Float64)')), 0) AS rss_mb,
      round(avg(JSONExtract(raw, 'heapUsedMB', 'Nullable(Float64)')), 0) AS heap_mb,
      round(avg(JSONExtract(raw, 'externalMB', 'Nullable(Float64)')), 0) AS external_mb,
      round(avg(JSONExtract(raw, 'arrayBuffersMB', 'Nullable(Float64)')), 0) AS arraybuf_mb,
      round(avg(JSONExtract(raw, 'activeSessions', 'Nullable(Float64)')), 0) AS sessions
    FROM ${source}
    WHERE dt >= now() - INTERVAL ${duration}
      AND JSONExtract(raw, 'region', 'Nullable(String)') = '${region}'
      AND JSONExtract(raw, 'server', 'Nullable(String)') = 'cloud-prod'
      AND JSONExtract(raw, 'feature', 'Nullable(String)') = 'system-vitals'
    GROUP BY time
    ORDER BY time
  `)

  printTable(result.data)

  if (result.data.length >= 2) {
    const first = result.data[0]
    const last = result.data[result.data.length - 1]
    const rssGrowth = Number(last.rss_mb) - Number(first.rss_mb)
    const minutes = result.data.length * 5
    const rate = rssGrowth / minutes
    console.log(
      `\n  RSS growth: ${first.rss_mb}MB → ${last.rss_mb}MB (${rssGrowth > 0 ? "+" : ""}${rssGrowth}MB over ~${minutes}min)`,
    )
    console.log(`  Rate: ~${rate.toFixed(1)} MB/min`)
    if (rate > 0) {
      const toGb = (1024 - Number(last.rss_mb)) / rate
      console.log(`  Est. time to 1GB: ${toGb.toFixed(0)} min (${(toGb / 60).toFixed(1)} hrs)`)
    }
  }
}

// ── gc ───────────────────────────────────────────────────────────────────────

async function cmdGc(flags: Record<string, string>) {
  const region = getFlag(flags, "region", "us-central")
  const duration = normalizeDuration(getFlag(flags, "duration", "1 HOUR"))
  const source = getSourceForRegion(region)

  console.log(`🗑️ GC Probe Analysis — ${region} (last ${duration})\n`)

  const result = await runSql(`
    SELECT
      dt,
      JSONExtract(raw, 'gcDurationMs', 'Nullable(Float64)') AS gc_ms,
      JSONExtract(raw, 'freedMB', 'Nullable(Int32)') AS freed_mb,
      JSONExtract(raw, 'heapBeforeMB', 'Nullable(Int32)') AS heap_before,
      JSONExtract(raw, 'heapAfterMB', 'Nullable(Int32)') AS heap_after,
      JSONExtract(raw, 'rssMB', 'Nullable(Int32)') AS rss_mb,
      JSONExtract(raw, 'activeSessions', 'Nullable(Int32)') AS sessions
    FROM ${source}
    WHERE dt >= now() - INTERVAL ${duration}
      AND JSONExtract(raw, 'region', 'Nullable(String)') = '${region}'
      AND JSONExtract(raw, 'server', 'Nullable(String)') = 'cloud-prod'
      AND JSONExtract(raw, 'feature', 'Nullable(String)') = 'gc-probe'
    ORDER BY dt
  `)

  printTable(result.data)

  if (result.data.length > 0) {
    const avgGc = result.data.reduce((sum, r) => sum + Number(r.gc_ms || 0), 0) / result.data.length
    const maxGc = Math.max(...result.data.map((r) => Number(r.gc_ms || 0)))
    console.log(`\n  Average GC: ${avgGc.toFixed(1)}ms | Max GC: ${maxGc.toFixed(1)}ms | Probes: ${result.data.length}`)
    if (maxGc > 100) {
      console.log(`  ⚠️ Max GC > 100ms — GC is contributing to event loop blocking`)
    } else {
      console.log(`  ✅ GC pauses are within acceptable range`)
    }
  }
}

// ── gaps ─────────────────────────────────────────────────────────────────────

async function cmdGaps(flags: Record<string, string>) {
  const region = getFlag(flags, "region", "us-central")
  const duration = normalizeDuration(getFlag(flags, "duration", "6 HOUR"))
  const source = getSourceForRegion(region)

  console.log(`⏱️ Event Loop Gaps — ${region} (last ${duration})\n`)

  const result = await runSql(`
    SELECT
      dt,
      JSONExtract(raw, 'gapMs', 'Nullable(Float64)') AS gap_ms,
      JSONExtract(raw, 'actualMs', 'Nullable(Float64)') AS actual_ms,
      JSONExtract(raw, 'rssMB', 'Nullable(Int32)') AS rss_mb,
      JSONExtract(raw, 'activeSessions', 'Nullable(Int32)') AS sessions
    FROM ${source}
    WHERE dt >= now() - INTERVAL ${duration}
      AND JSONExtract(raw, 'region', 'Nullable(String)') = '${region}'
      AND JSONExtract(raw, 'server', 'Nullable(String)') = 'cloud-prod'
      AND JSONExtract(raw, 'feature', 'Nullable(String)') = 'event-loop-gap'
    ORDER BY dt DESC
    LIMIT 50
  `)

  if (result.data.length === 0) {
    console.log("  ✅ No event loop gaps detected — the event loop was never blocked >1 second.")
  } else {
    printTable(result.data)
    console.log(`\n  ⚠️ ${result.data.length} gaps detected — something is blocking the event loop.`)
    console.log("  Cross-reference with slow-queries and gc-probes at the same timestamps.")
  }
}

// ── budget ───────────────────────────────────────────────────────────────────

async function cmdBudget(flags: Record<string, string>) {
  const region = getFlag(flags, "region", "us-central")
  const duration = normalizeDuration(getFlag(flags, "duration", "30 MINUTE"))
  const source = getSourceForRegion(region)

  console.log(`📊 Operation Budget — ${region} (last ${duration})\n`)

  const result = await runSql(`
    SELECT
      dt,
      JSONExtract(raw, 'op_audioProcessing_ms', 'Nullable(Float64)') AS audio_ms,
      JSONExtract(raw, 'op_glassesMessage_ms', 'Nullable(Float64)') AS glasses_ms,
      JSONExtract(raw, 'op_appMessage_ms', 'Nullable(Float64)') AS app_msg_ms,
      JSONExtract(raw, 'op_displayRendering_ms', 'Nullable(Float64)') AS display_ms,
      JSONExtract(raw, 'opTotalMs', 'Nullable(Float64)') AS total_ms,
      JSONExtract(raw, 'opBudgetUsedPct', 'Nullable(Float64)') AS budget_pct,
      JSONExtract(raw, 'mongoTotalBlockingMs', 'Nullable(Float64)') AS mongo_ms,
      JSONExtract(raw, 'activeSessions', 'Nullable(Int32)') AS sessions,
      JSONExtract(raw, 'rssMB', 'Nullable(Int32)') AS rss_mb
    FROM ${source}
    WHERE dt >= now() - INTERVAL ${duration}
      AND JSONExtract(raw, 'region', 'Nullable(String)') = '${region}'
      AND JSONExtract(raw, 'server', 'Nullable(String)') = 'cloud-prod'
      AND JSONExtract(raw, 'feature', 'Nullable(String)') = 'system-vitals'
    ORDER BY dt
  `)

  printTable(result.data, [
    "dt",
    "sessions",
    "audio_ms",
    "glasses_ms",
    "app_msg_ms",
    "display_ms",
    "total_ms",
    "budget_pct",
    "mongo_ms",
    "rss_mb",
  ])

  if (result.data.length > 0) {
    const avgBudget = result.data.reduce((s, r) => s + Number(r.budget_pct || 0), 0) / result.data.length
    const maxBudget = Math.max(...result.data.map((r) => Number(r.budget_pct || 0)))
    console.log(`\n  Average budget: ${avgBudget.toFixed(1)}% | Max: ${maxBudget.toFixed(1)}%`)
    if (maxBudget > 50) {
      console.log("  🔴 Budget > 50% — application CPU work is consuming most of the event loop")
    } else if (maxBudget > 20) {
      console.log("  🟡 Budget 20-50% — moderate, watch for growth")
    } else {
      console.log("  ✅ Budget < 20% — healthy event loop headroom")
    }
  }
}

// ── slow-queries ────────────────────────────────────────────────────────────

async function cmdSlowQueries(flags: Record<string, string>) {
  const region = getFlag(flags, "region", "us-central")
  const duration = normalizeDuration(getFlag(flags, "duration", "30 MINUTE"))
  const source = getSourceForRegion(region)

  console.log(`🐢 Slow MongoDB Queries — ${region} (last ${duration})\n`)

  const summary = await runSql(`
    SELECT
      JSONExtract(raw, 'collection', 'Nullable(String)') AS collection,
      JSONExtract(raw, 'operation', 'Nullable(String)') AS operation,
      count() AS count,
      round(avg(JSONExtract(raw, 'durationMs', 'Nullable(Float64)')), 0) AS avg_ms,
      max(JSONExtract(raw, 'durationMs', 'Nullable(Float64)')) AS max_ms,
      round(sum(JSONExtract(raw, 'durationMs', 'Nullable(Float64)')), 0) AS total_ms
    FROM ${source}
    WHERE dt >= now() - INTERVAL ${duration}
      AND JSONExtract(raw, 'region', 'Nullable(String)') = '${region}'
      AND JSONExtract(raw, 'server', 'Nullable(String)') = 'cloud-prod'
      AND JSONExtract(raw, 'feature', 'Nullable(String)') = 'slow-query'
    GROUP BY collection, operation
    ORDER BY total_ms DESC
    LIMIT 20
  `)

  printTable(summary.data)
}

// ── cache ───────────────────────────────────────────────────────────────────

async function cmdCache(flags: Record<string, string>) {
  const region = getFlag(flags, "region", "us-central")
  const source = getSourceForRegion(region)

  console.log(`📦 App Cache Status — ${region}\n`)

  const result = await runSql(`
    SELECT
      dt,
      JSONExtract(raw, 'count', 'Nullable(Int32)') AS apps_cached,
      JSONExtract(raw, 'refreshMs', 'Nullable(Float64)') AS refresh_ms,
      JSONExtract(raw, 'refreshCount', 'Nullable(Int32)') AS refresh_count
    FROM ${source}
    WHERE dt >= now() - INTERVAL 10 MINUTE
      AND JSONExtract(raw, 'region', 'Nullable(String)') = '${region}'
      AND JSONExtract(raw, 'server', 'Nullable(String)') = 'cloud-prod'
      AND JSONExtract(raw, 'feature', 'Nullable(String)') = 'app-cache'
    ORDER BY dt DESC
    LIMIT 10
  `)

  printTable(result.data)
}

// ── incidents ───────────────────────────────────────────────────────────────

async function cmdIncidents(flags: Record<string, string>) {
  const limit = parseInt(getFlag(flags, "limit", "10"), 10)

  console.log(`🚨 Recent Incidents (last ${limit})\n`)

  const data = await fetchUptime(`/incidents?per_page=${limit}`)

  const rows = data.data.map((inc: any) => {
    const a = inc.attributes
    const resolved = a.resolved_at ? a.resolved_at.slice(0, 19) : "ONGOING"
    return {
      started: a.started_at?.slice(0, 19) ?? "?",
      name: a.name ?? "?",
      cause: (a.cause ?? "?").slice(0, 40),
      status: a.resolved_at ? "✅" : "🔴",
      resolved,
    }
  })

  printTable(rows)
}

// ── sources ─────────────────────────────────────────────────────────────────

async function cmdSources() {
  console.log("📡 BetterStack Sources & Collectors\n")

  console.log("── Log Sources ──")
  const logRows = Object.entries(LOG_SOURCES).map(([key, s]) => ({
    key,
    id: s.id,
    name: s.name,
    table: s.logsTable,
  }))
  printTable(logRows)

  console.log("\n── Collectors (Infrastructure Metrics) ──")
  const collectorRows = Object.entries(COLLECTORS).map(([key, c]) => ({
    region: key,
    collector_id: c.collectorId,
    source_id: c.sourceId,
    name: c.name,
    cluster: c.clusterId,
  }))
  printTable(collectorRows)

  console.log("\n── Dashboards ──")
  const dashRows = Object.entries(DASHBOARDS).map(([key, d]) => ({
    key,
    id: d.id,
    name: d.name,
    url: d.url,
  }))
  printTable(dashRows)

  console.log("\n── Uptime Monitors ──")
  const monitorRows = Object.entries(UPTIME_MONITORS).map(([key, m]) => ({
    key,
    id: m.id,
    name: m.name,
  }))
  printTable(monitorRows)
}

// ── sql ─────────────────────────────────────────────────────────────────────

// ── logs — search logs for a user/keyword ────────────────────────────────────

async function cmdLogs(flags: Record<string, string>, positional: string[]) {
  const query = positional.join(" ")
  if (!query) {
    console.error(
      "Usage: bstack logs <userId or keyword> [--level error] [--duration 15m] [--region us-central] [--env prod]",
    )
    console.error("\nExamples:")
    console.error("  bstack logs isaiahballah@gmail.com")
    console.error("  bstack logs isaiahballah@gmail.com --level error")
    console.error("  bstack logs isaiahballah@gmail.com --duration 1h --env dev")
    console.error("  bstack logs captions --level warn --region france")
    process.exit(1)
  }

  const duration = normalizeDuration(getFlag(flags, "duration", "15m"))
  const level = getFlag(flags, "level", "")
  const region = getFlag(flags, "region", "")
  const env = getFlag(flags, "env", "prod") as "prod" | "dev"
  const limit = getFlag(flags, "limit", "30")
  const service = getFlag(flags, "service", "")

  const table = getTableForDuration(env, duration)
  const historical = isHistoricalTable(table)

  let where = `raw LIKE '%${query}%' AND dt > now() - INTERVAL ${duration}`
  if (historical) where = `_row_type = 1 AND ${where}`
  if (level)
    where += ` AND JSONExtractString(raw, 'level') IN (${level
      .split(",")
      .map((l) => `'${l.trim()}'`)
      .join(",")})`
  if (region) where += ` AND JSONExtractString(raw, 'region') = '${region}'`
  if (service) where += ` AND JSONExtractString(raw, 'service') = '${service}'`

  const sql = `SELECT dt, JSONExtractString(raw, 'level') as level, JSONExtractString(raw, 'message') as message, JSONExtractString(raw, 'service') as service FROM ${table} WHERE ${where} ORDER BY dt DESC LIMIT ${limit}`

  console.log(
    `🔍 Logs matching "${query}" (last ${duration}, ${env}${region ? `, ${region}` : ""}${level ? `, level=${level}` : ""})\n`,
  )

  const result = await runSql(sql)
  printTable(result.data)

  if (result.statistics) {
    console.log(
      `\n  ${result.rows} rows | ${result.statistics.elapsed.toFixed(3)}s | ${(result.statistics.bytes_read / 1024 / 1024).toFixed(1)}MB scanned`,
    )
  }

  if (result.rows === 0) {
    console.log(`\n  💡 No results? Try:`)
    console.log(`     --duration 1h  (search further back)`)
    console.log(`     --env dev      (search dev/debug source instead of prod)`)
    console.log(`     --level ""     (remove level filter)`)
  }
}

// ── errors — top errors by count ─────────────────────────────────────────────

async function cmdErrors(flags: Record<string, string>) {
  const region = getFlag(flags, "region", "us-central")
  const duration = normalizeDuration(getFlag(flags, "duration", "4h"))
  const top = getFlag(flags, "limit", "20")
  const env = getFlag(flags, "env", "prod") as "prod" | "dev"

  const table = getTableForDuration(env, duration)
  const historical = isHistoricalTable(table)
  const rowFilter = historical ? "_row_type = 1 AND " : ""

  const sql = `SELECT JSONExtractString(raw, 'service') as service, substring(JSONExtractString(raw, 'message'), 1, 100) as message, count() as total FROM ${table} WHERE ${rowFilter}dt >= now() - INTERVAL ${duration} AND JSONExtractString(raw, 'level') IN ('error', 'fatal') AND JSONExtractString(raw, 'region') = '${region}' GROUP BY service, message ORDER BY total DESC LIMIT ${top}`

  console.log(`🔴 Top Errors — ${region} (last ${duration})\n`)

  const result = await runSql(sql)
  printTable(result.data)

  if (result.statistics) {
    console.log(
      `\n  ${result.rows} rows | ${result.statistics.elapsed.toFixed(3)}s | ${(result.statistics.bytes_read / 1024 / 1024).toFixed(1)}MB scanned`,
    )
  }
}

// ── leaks — memory leak detection ────────────────────────────────────────────

async function cmdLeaks(flags: Record<string, string>) {
  const region = getFlag(flags, "region", "us-central")
  const duration = normalizeDuration(getFlag(flags, "duration", "12h"))
  const env = getFlag(flags, "env", "prod") as "prod" | "dev"

  const table = getTableForDuration(env, duration)
  const historical = isHistoricalTable(table)
  const rowFilter = historical ? "_row_type = 1 AND " : ""

  console.log(`🔍 Memory Leak Check — ${region} (last ${duration})\n`)

  // 1. disposedSessionsPendingGC trend
  const leakSql = `SELECT toStartOfHour(dt) as hour, avg(JSONExtractInt(raw, 'disposedSessionsPendingGC')) as avg_leaked, avg(JSONExtractFloat(raw, 'rssMB')) as avg_rss, avg(JSONExtractFloat(raw, 'heapUsedMB')) as avg_heap, avg(JSONExtractInt(raw, 'activeSessions')) as sessions FROM ${table} WHERE ${rowFilter}JSONExtractString(raw, 'feature') = 'system-vitals' AND JSONExtractString(raw, 'region') = '${region}' AND dt >= now() - INTERVAL ${duration} GROUP BY hour ORDER BY hour ASC`

  const leakResult = await runSql(leakSql)
  console.log("📊 Disposed Sessions Pending GC (should be 0):\n")
  printTable(leakResult.data)

  // 2. GC freed amounts
  const gcSql = `SELECT toStartOfHour(dt) as hour, count() as probes, avg(JSONExtractFloat(raw, 'gcDurationMs')) as avg_gc_ms, max(JSONExtractFloat(raw, 'gcDurationMs')) as max_gc_ms, avg(JSONExtractFloat(raw, 'freedMB')) as avg_freed_mb FROM ${table} WHERE ${rowFilter}JSONExtractString(raw, 'feature') = 'gc-probe' AND JSONExtractString(raw, 'region') = '${region}' AND dt >= now() - INTERVAL ${duration} GROUP BY hour ORDER BY hour ASC`

  const gcResult = await runSql(gcSql)
  console.log("\n🗑️  GC Probe Trend (freed_mb should be > 0):\n")
  printTable(gcResult.data)

  // 3. Leak warnings from MemoryLeakDetector
  const warnSql = `SELECT dt, JSONExtractString(raw, 'tag') as tag, JSONExtractString(raw, 'message') as status FROM ${table} WHERE ${rowFilter}JSONExtractString(raw, 'service') = 'MemoryLeakDetector' AND JSONExtractString(raw, 'region') = '${region}' AND dt >= now() - INTERVAL ${duration} ORDER BY dt DESC LIMIT 20`

  const warnResult = await runSql(warnSql)
  if (warnResult.rows > 0) {
    console.log("\n⚠️  MemoryLeakDetector Events:\n")
    printTable(warnResult.data)
  }

  // Summary
  if (leakResult.data.length > 0) {
    const latest = leakResult.data[leakResult.data.length - 1]
    const leaked = parseFloat(latest.avg_leaked) || 0
    const rss = parseFloat(latest.avg_rss) || 0
    if (leaked > 1) {
      console.log(`\n  🔴 LEAK DETECTED: ${leaked.toFixed(1)} disposed sessions stuck in memory`)
      console.log(`     RSS: ${rss.toFixed(0)}MB — run timer audit (see: bstack runbook pod-crash)`)
    } else {
      console.log(`\n  ✅ No leak detected (disposedSessionsPendingGC = ${leaked.toFixed(1)})`)
    }
  }
}

// ── session — live session inspection ────────────────────────────────────────

async function cmdSession(flags: Record<string, string>, positional: string[]) {
  const userId = positional[0]
  const host = getFlag(flags, "host", "")

  if (!userId || !host) {
    console.error("Usage: bstack session <userId> --host <hostname>")
    console.error("\nExamples:")
    console.error("  bstack session isaiahballah@gmail.com --host debug.augmentos.cloud")
    console.error("  bstack session user@example.com --host uscentralapi.mentra.glass")
    process.exit(1)
  }

  const jwt = _ADMIN_JWT || process.env.MENTRA_ADMIN_JWT || ""
  if (!jwt) {
    console.error("❌ MENTRA_ADMIN_JWT not set. Set it in env or Doppler mentra-sre project.")
    process.exit(1)
  }

  console.log(`🔍 Session: ${userId} on ${host}\n`)

  try {
    const res = await fetch(`https://${host}/api/admin/memory/now`, {
      headers: {Authorization: `Bearer ${jwt}`},
    })
    if (!res.ok) {
      console.error(`❌ HTTP ${res.status}: ${await res.text()}`)
      return
    }

    const data = (await res.json()) as any
    const session = (data.sessions || []).find((s: any) => s.userId === userId)

    if (!session) {
      console.log(`  ❌ No active session for ${userId}`)
      console.log(`  Active users: ${(data.sessions || []).map((s: any) => s.userId).join(", ") || "(none)"}`)
      return
    }

    console.log(`  User:          ${session.userId}`)
    console.log(`  Running Apps:  ${(session.runningApps || []).join(", ") || "(none)"}`)
    console.log(`  Loading Apps:  ${(session.loadingApps || []).join(", ") || "(none)"}`)
    console.log(`  Apps:          ${JSON.stringify(session.apps || {})}`)
    console.log(`  Subscriptions: ${JSON.stringify(session.subscriptions || {})}`)

    if (session.mic !== undefined) console.log(`  Mic:           ${JSON.stringify(session.mic)}`)
    if (session.audio !== undefined) console.log(`  Audio:         ${JSON.stringify(session.audio)}`)
  } catch (error: any) {
    console.error(`❌ Error: ${error.message}`)
  }
}

// ── sql ──────────────────────────────────────────────────────────────────────

async function cmdSql(positional: string[]) {
  const sql = positional.join(" ")
  if (!sql) {
    console.error('Usage: bstack sql "SELECT ..."')
    process.exit(1)
  }

  console.log(`🔍 Raw SQL Query\n`)
  const result = await runSql(sql)
  printTable(result.data)

  if (result.statistics) {
    console.log(
      `\n  ${result.rows} rows | ${result.statistics.elapsed.toFixed(3)}s | ${(result.statistics.bytes_read / 1024 / 1024).toFixed(1)}MB scanned`,
    )
  }
}

// ── runbook ──────────────────────────────────────────────────────────────────

async function cmdRunbook(positional: string[]) {
  const name = positional[0]
  if (!name) {
    console.log("📖 Available Runbooks:\n")
    const fs = await import("fs")
    const path = await import("path")
    const runbookDir = path.join(import.meta.dir, "runbooks")
    try {
      const files = fs.readdirSync(runbookDir).filter((f: string) => f.endsWith(".md"))
      for (const f of files) {
        console.log(`  bstack runbook ${f.replace(".md", "")}`)
      }
    } catch {
      console.log("  (no runbooks found in cloud/tools/bstack/runbooks/)")
    }
    return
  }

  const fs = await import("fs")
  const path = await import("path")
  const filePath = path.join(import.meta.dir, "runbooks", `${name}.md`)
  try {
    const content = fs.readFileSync(filePath, "utf-8")
    console.log(content)
  } catch {
    console.error(`Runbook not found: ${name}`)
    console.error(`  Expected file: ${filePath}`)
    process.exit(1)
  }
}

// ── help ─────────────────────────────────────────────────────────────────────

function cmdHelp() {
  console.log(`
bstack — BetterStack CLI for MentraCloud SRE

═══════════════════════════════════════════════════════════════════════════
HOW IT WORKS (for humans and AI agents)
═══════════════════════════════════════════════════════════════════════════

This CLI sends ClickHouse SQL queries to BetterStack's HTTP API at:
  ${SQL_ENDPOINT}

Logs are stored in two places with different tradeoffs:
  HOT storage  — last ~2-5 minutes only, fast (<1s queries)
    Prod:  remote(t373499_mentracloud_prod_logs)
    Dev:   remote(t373499_augmentos_logs)
  COLD storage — full history, slower (3-5s queries), needs _row_type = 1
    Prod:  s3Cluster(primary, t373499_mentracloud_prod_s3)
    Dev:   s3Cluster(primary, t373499_augmentos_s3)

The CLI auto-selects hot vs cold based on --duration:
  ≤5 min  → hot table (fast, recent data only)
  >5 min  → cold/S3 table (slow, full history, adds WHERE _row_type = 1)
If you get zero rows for a query you expect data for, the duration might
be too short for cold storage or too long for hot storage.

Log fields are in a JSON blob called 'raw'. To extract fields use:
  JSONExtractString(raw, 'level')    → "error", "warn", "info", "debug"
  JSONExtractString(raw, 'message')  → the log message
  JSONExtractString(raw, 'service')  → "AppManager", "UserSession", etc.
  JSONExtractString(raw, 'region')   → "us-central", "france", etc.
  JSONExtractString(raw, 'feature')  → "system-vitals", "gc-probe", etc.
  JSONExtractString(raw, 'userId')   → user email
  JSONExtractFloat(raw, 'rssMB')     → RSS memory in MB
  JSONExtractInt(raw, 'activeSessions') → session count
Do NOT use json.field dot notation — it doesn't work on these tables.

Credentials are loaded in this order:
  1. Environment variables (BETTERSTACK_USERNAME, BETTERSTACK_PASSWORD, etc.)
  2. Auto-load from Doppler: doppler secrets get --project mentra-sre --config dev
     (runs automatically if env vars are missing and doppler CLI is installed)
SRE credentials live in Doppler project "mentra-sre" (NOT "mentraos-cloud").
Cloud runtime secrets (MONGO_URL, etc.) are in "mentraos-cloud" — don't mix them.

The admin API (for 'session' command) hits the cloud's /api/admin/memory/now
endpoint with a Bearer JWT. The JWT is MENTRA_ADMIN_JWT from mentra-sre.

Health checks hit each region's /health endpoint directly (no BetterStack):
${Object.entries(REGIONS)
  .map(([id, r]) => `  ${id.padEnd(12)} → ${r.healthUrl}`)
  .join("\n")}

If a command isn't doing what you need, use 'bstack sql' to run raw
ClickHouse SQL directly. The patterns above show exactly how to query.

═══════════════════════════════════════════════════════════════════════════
COMMANDS
═══════════════════════════════════════════════════════════════════════════

Investigation:
  bstack logs <user|keyword>                 Search logs by user or keyword
    --level error,warn                         Filters: JSONExtractString(raw, 'level') IN (...)
    --duration 1h                              How far back (default: 15m). Controls hot vs cold table.
    --region france                            Filters: JSONExtractString(raw, 'region') = '...'
    --service AppManager                       Filters: JSONExtractString(raw, 'service') = '...'
    --env dev                                  Search dev/debug source instead of prod (default: prod)
    Internally: SELECT dt, level, message, service FROM <table> WHERE raw LIKE '%<query>%' ...

  bstack errors --region <r>                 Top errors grouped by service + message
    --duration 4h                              Time window (default: 4h)
    Internally: GROUP BY service, message ORDER BY count() DESC

  bstack leaks --region <r>                  Memory leak detection — 3 queries:
    --duration 12h                             Time window (default: 12h)
    1. disposedSessionsPendingGC trend (from system-vitals, grouped by hour)
       Should be 0. If climbing, sessions are stuck in memory after dispose().
    2. GC probe trend (from gc-probe). avg_freed_mb should be > 0.
       If GC frees 0MB consistently, objects are reachable but shouldn't be.
    3. MemoryLeakDetector events — "Potential leak" = disposed but not GC'd
       within 60s. "Object finalized by GC" = eventually collected (ok).

  bstack session <userId> --host <hostname>  Hits GET /api/admin/memory/now on the host,
    finds the user's session, shows running apps, subscriptions, mic state.
    Requires MENTRA_ADMIN_JWT. Host must be the actual cloud hostname.

Diagnostics:
  bstack health                              Fetches /health from ALL regions in parallel.
    Shows: sessions, uptime, RSS, heap, event loop lag.
    Also fetches BetterStack uptime monitors if API_TOKEN is set.

  bstack diagnostics --region <r>            Runs 5 queries: GC probes, event loop gaps,
    MongoDB slow queries, operation budget, app cache. All from system-vitals/gc-probe/etc.

  bstack crash-timeline --region <r>         Shows interleaved system-vitals, gc-probe,
    event-loop-gap, and slow-query events to reconstruct what happened before a crash.

  bstack memory --region <r> [--duration 1h] RSS/heap/external/arraybuf trend over time.
    Calculates growth rate and estimates time to 1GB.

  bstack gc --region <r> [--duration 1h]     GC probe durations and freed MB.
    Warns if max GC > 100ms (contributing to event loop blocking).

  bstack gaps --region <r> [--duration 1h]   Event loop gaps (>1s freezes).
    Zero gaps = healthy. Any gaps = something blocking (GC, MongoDB, etc.).

  bstack budget --region <r>                 Per-operation CPU time breakdown.
    Shows audio processing, app messages, display rendering, MongoDB, etc.
    Budget > 50% = event loop is CPU-bound. < 20% = healthy headroom.

  bstack slow-queries --region <r>           MongoDB queries > 100ms, grouped by
    collection + operation. Shows count, avg/max duration, total blocking time.

  bstack cache --region <r>                  App cache refresh stats (count, timing).

Infrastructure:
  bstack incidents [--limit 10]              Fetches from BetterStack Uptime API.
    Requires BETTERSTACK_API_TOKEN. Shows start time, cause, resolution.

  bstack sources                             Lists all BetterStack log sources, collectors,
    dashboards, and uptime monitors with their IDs and table names.

  bstack sql "SELECT ..."                    Runs raw ClickHouse SQL. Append FORMAT JSON
    automatically. Use this when no built-in command covers your query.

  bstack runbook <name>                      Prints a runbook from cloud/tools/bstack/runbooks/.
    Runbooks contain step-by-step investigation procedures with example queries.

Regions: ${getAllRegions().join(", ")}
Cluster IDs: ${Object.entries(REGIONS)
    .map(([id, r]) => `${id}=${r.clusterId}`)
    .join(", ")}

📖 Runbooks (run 'bstack runbook <name>' to read):
  pod-crash            What to do when a pod crashes (exit codes, heap analysis, timer audit)
  weekly-error-audit   Weekly error audit process (top errors, log volume, churn, memory)
  client-disconnect    Investigate client disconnection patterns (ws-close, ws-reconnect)
`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const {command, flags, positional} = parseArgs()

try {
  switch (command) {
    case "health":
      await cmdHealth()
      break
    case "diagnostics":
    case "diag":
      await cmdDiagnostics(flags)
      break
    case "crash-timeline":
    case "crash":
      await cmdCrashTimeline(flags)
      break
    case "memory":
    case "mem":
      await cmdMemory(flags)
      break
    case "gc":
      await cmdGc(flags)
      break
    case "gaps":
      await cmdGaps(flags)
      break
    case "budget":
      await cmdBudget(flags)
      break
    case "slow-queries":
    case "slow":
      await cmdSlowQueries(flags)
      break
    case "cache":
      await cmdCache(flags)
      break
    case "logs":
    case "log":
      await cmdLogs(flags, positional)
      break
    case "errors":
    case "err":
      await cmdErrors(flags)
      break
    case "leaks":
    case "leak":
      await cmdLeaks(flags)
      break
    case "session":
    case "sess":
      await cmdSession(flags, positional)
      break
    case "incidents":
    case "inc":
      await cmdIncidents(flags)
      break
    case "sources":
    case "src":
      await cmdSources()
      break
    case "sql":
      await cmdSql(positional)
      break
    case "runbook":
    case "rb":
      await cmdRunbook(positional)
      break
    case "help":
    case "--help":
    case "-h":
      cmdHelp()
      break
    default:
      console.error(`Unknown command: ${command}`)
      cmdHelp()
      process.exit(1)
  }
} catch (error: any) {
  console.error(`\n❌ Error: ${error.message}`)
  if (error.message.includes("Unauthorized")) {
    console.error("   Check your BETTERSTACK_USERNAME and BETTERSTACK_PASSWORD environment variables.")
  }
  process.exit(1)
}
