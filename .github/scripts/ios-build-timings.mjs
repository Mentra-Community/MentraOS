#!/usr/bin/env node
// Summarise recent "Mobile App iOS Build" runs as a markdown table so build
// time changes can be compared like-for-like (same event type, same SHA,
// same runner pool). Reads the Actions API through the gh CLI.
//
// Usage:
//   node .github/scripts/ios-build-timings.mjs [--repo owner/name] [--limit 10]
//        [--event pull_request|push|workflow_dispatch|all] [--branch <ref>]
//        [--sha <full-or-short-sha>] [--only-success] [--label "Phase 1"] [--json]
//
// Column semantics (all from the job's step timestamps, so post-job cache
// saves ARE included, unlike the in-job step summary):
//   total        job started -> job completed
//   queue        run created -> job started
//   xcodebuild   first attempt + clean retry step durations
//   cacheRestore steps named "Cache ..."
//   cacheSave    steps named "Post Cache ..."
//   other        total - xcodebuild - cacheRestore - cacheSave
import {execFileSync} from "node:child_process"

export const WORKFLOW_FILE = "mentra-app-ios-build.yml"
export const JOB_NAME = "build"

const XCODEBUILD_STEP_PREFIXES = ["Build iOS app for Device", "Retry build with clean caches"]

export function parseArgs(argv) {
  const opts = {
    repo: process.env.GITHUB_REPOSITORY || "",
    limit: 10,
    event: "all",
    branch: "",
    sha: "",
    onlySuccess: false,
    label: "",
    json: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      i += 1
      if (i >= argv.length) throw new Error(`${arg} requires a value`)
      return argv[i]
    }
    switch (arg) {
      case "--repo":
        opts.repo = next()
        break
      case "--limit":
        opts.limit = Number.parseInt(next(), 10)
        if (!Number.isInteger(opts.limit) || opts.limit <= 0) throw new Error("--limit must be a positive integer")
        break
      case "--event":
        opts.event = next()
        break
      case "--branch":
        opts.branch = next()
        break
      case "--sha":
        opts.sha = next().toLowerCase()
        break
      case "--only-success":
        opts.onlySuccess = true
        break
      case "--label":
        opts.label = next()
        break
      case "--json":
        opts.json = true
        break
      default:
        throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return opts
}

function seconds(from, to) {
  if (!from || !to) return null
  const a = Date.parse(from)
  const b = Date.parse(to)
  if (Number.isNaN(a) || Number.isNaN(b)) return null
  return Math.max(0, Math.round((b - a) / 1000))
}

function stepDuration(step) {
  return seconds(step.started_at, step.completed_at) ?? 0
}

/** Reduce one run + its build job to a timing row. Pure. */
export function summarizeJob(run, job) {
  const steps = Array.isArray(job?.steps) ? job.steps : []
  const isXcodebuild = (name) => XCODEBUILD_STEP_PREFIXES.some((prefix) => name.startsWith(prefix))
  const isCacheRestore = (name) => name.startsWith("Cache ")
  const isCacheSave = (name) => name.startsWith("Post Cache ")

  let xcodebuild = 0
  let cacheRestore = 0
  let cacheSave = 0
  for (const step of steps) {
    const d = stepDuration(step)
    if (isXcodebuild(step.name)) xcodebuild += d
    else if (isCacheRestore(step.name)) cacheRestore += d
    else if (isCacheSave(step.name)) cacheSave += d
  }
  const total = seconds(job?.started_at, job?.completed_at)
  const queue = seconds(run.created_at ?? run.run_started_at, job?.started_at)
  const other = total == null ? null : Math.max(0, total - xcodebuild - cacheRestore - cacheSave)

  return {
    runId: run.id,
    attempt: run.run_attempt ?? 1,
    url: run.html_url,
    sha: (run.head_sha || "").slice(0, 7),
    event: run.event,
    branch: run.head_branch,
    runner: job?.runner_name ?? "",
    conclusion: job?.conclusion ?? run.conclusion ?? "",
    createdAt: run.created_at,
    total,
    queue,
    xcodebuild,
    cacheRestore,
    cacheSave,
    other,
  }
}

function median(values) {
  const v = values.filter((x) => typeof x === "number").sort((a, b) => a - b)
  if (v.length === 0) return null
  const mid = Math.floor(v.length / 2)
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2)
}

/** Median/min/max per column over successful rows. Pure. */
export function aggregate(rows) {
  const ok = rows.filter((r) => r.conclusion === "success")
  const cols = ["total", "queue", "xcodebuild", "cacheRestore", "cacheSave", "other"]
  const stats = {count: ok.length}
  for (const col of cols) {
    const values = ok.map((r) => r[col]).filter((x) => typeof x === "number")
    stats[col] = values.length
      ? {median: median(values), min: Math.min(...values), max: Math.max(...values)}
      : {median: null, min: null, max: null}
  }
  return stats
}

export function formatDuration(secs) {
  if (typeof secs !== "number") return "–"
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return `${m}m ${String(s).padStart(2, "0")}s`
}

/** Markdown table + stats block. Pure. */
export function renderMarkdown(rows, stats, {label = ""} = {}) {
  const lines = []
  if (label) lines.push(`### ${label}`, "")
  lines.push(
    "| Run | SHA | Event | Runner | Result | Total | Queue | xcodebuild | Cache restore | Cache save | Other |",
    "| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  )
  for (const r of rows) {
    const runLabel = r.attempt > 1 ? `${r.runId} (attempt ${r.attempt})` : String(r.runId)
    const runCell = r.url ? `[${runLabel}](${r.url})` : runLabel
    lines.push(
      `| ${runCell} | \`${r.sha}\` | ${r.event} | ${r.runner || "–"} | ${r.conclusion} | ${formatDuration(r.total)} | ${formatDuration(r.queue)} | ${formatDuration(r.xcodebuild)} | ${formatDuration(r.cacheRestore)} | ${formatDuration(r.cacheSave)} | ${formatDuration(r.other)} |`,
    )
  }
  lines.push("")
  lines.push(`Successful runs: **${stats.count}**`, "")
  lines.push("| Metric | Median | Min | Max |", "| --- | ---: | ---: | ---: |")
  const names = {
    total: "Total job",
    queue: "Queue wait",
    xcodebuild: "xcodebuild",
    cacheRestore: "Cache restore",
    cacheSave: "Cache save",
    other: "Other steps",
  }
  for (const [col, name] of Object.entries(names)) {
    const s = stats[col]
    lines.push(`| ${name} | ${formatDuration(s.median)} | ${formatDuration(s.min)} | ${formatDuration(s.max)} |`)
  }
  return lines.join("\n")
}

function ghApi(path) {
  const out = execFileSync("gh", ["api", path], {encoding: "utf8", maxBuffer: 64 * 1024 * 1024})
  return JSON.parse(out)
}

function resolveRepo(repo) {
  if (repo) return repo
  const out = execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], {
    encoding: "utf8",
  })
  return out.trim()
}

export async function collect(opts, api = ghApi) {
  const repo = resolveRepo(opts.repo)
  const params = new URLSearchParams({per_page: String(Math.min(100, opts.limit * 3)), status: "completed"})
  if (opts.event !== "all") params.set("event", opts.event)
  if (opts.branch) params.set("branch", opts.branch)
  const runsPayload = api(`repos/${repo}/actions/workflows/${WORKFLOW_FILE}/runs?${params}`)
  let runs = runsPayload.workflow_runs ?? []
  if (opts.sha) runs = runs.filter((r) => (r.head_sha || "").toLowerCase().startsWith(opts.sha))
  runs = runs.slice(0, opts.limit)

  const rows = []
  for (const run of runs) {
    const jobsPayload = api(`repos/${repo}/actions/runs/${run.id}/attempts/${run.run_attempt ?? 1}/jobs`)
    const job = (jobsPayload.jobs ?? []).find((j) => j.name === JOB_NAME) ?? (jobsPayload.jobs ?? [])[0]
    const row = summarizeJob(run, job)
    if (opts.onlySuccess && row.conclusion !== "success") continue
    rows.push(row)
  }
  return rows
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  const rows = await collect(opts)
  const stats = aggregate(rows)
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({rows, stats}, null, 2)}\n`)
    return
  }
  process.stdout.write(`${renderMarkdown(rows, stats, {label: opts.label})}\n`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
