import assert from "node:assert/strict"
import test from "node:test"
import {aggregate, formatDuration, parseArgs, renderMarkdown, summarizeJob} from "./ios-build-timings.mjs"

const run = {
  id: 42,
  run_attempt: 2,
  html_url: "https://github.com/o/r/actions/runs/42",
  head_sha: "abcdef0123456789",
  event: "pull_request",
  head_branch: "feature",
  conclusion: "success",
  created_at: "2026-09-18T09:15:52Z",
}

const step = (name, start, end, conclusion = "success") => ({
  name,
  conclusion,
  started_at: `2026-09-18T09:${start}Z`,
  completed_at: end ? `2026-09-18T09:${end}Z` : null,
})

const job = {
  name: "build",
  runner_name: "big-bob",
  conclusion: "success",
  started_at: "2026-09-18T09:16:00Z",
  completed_at: "2026-09-18T09:29:00Z",
  steps: [
    step("Set up job", "16:00", "16:03"),
    step("Cache CocoaPods downloads", "16:30", "17:13"),
    step("Cache installed CocoaPods", "17:13", "17:14"),
    step("Cache Xcode DerivedData (device build)", "17:14", "17:15"),
    step("Build iOS app for Device (cached attempt)", "18:50", "25:33"),
    step("Retry build with clean caches (if first attempt failed)", "25:33", "25:33", "skipped"),
    step("Post Cache Xcode DerivedData (device build)", "25:47", "28:20"),
    step("Post Cache installed CocoaPods", "28:20", "28:53"),
    step("Post Cache CocoaPods downloads", "28:53", "28:53"),
    step("Complete job", "28:59", null),
  ],
}

test("summarizeJob buckets step durations", () => {
  const row = summarizeJob(run, job)
  assert.equal(row.runId, 42)
  assert.equal(row.attempt, 2)
  assert.equal(row.sha, "abcdef0")
  assert.equal(row.runner, "big-bob")
  assert.equal(row.total, 13 * 60)
  assert.equal(row.queue, 8)
  assert.equal(row.xcodebuild, 403)
  assert.equal(row.cacheRestore, 43 + 1 + 1)
  assert.equal(row.cacheSave, 153 + 33)
  assert.equal(row.other, 13 * 60 - 403 - 45 - 186)
})

test("summarizeJob tolerates a missing job", () => {
  const row = summarizeJob(run, undefined)
  assert.equal(row.total, null)
  assert.equal(row.xcodebuild, 0)
  assert.equal(row.conclusion, "success")
})

test("aggregate reports median/min/max over successful rows only", () => {
  const rows = [
    {conclusion: "success", total: 600, queue: 5, xcodebuild: 300, cacheRestore: 0, cacheSave: 0, other: 300},
    {conclusion: "success", total: 800, queue: 15, xcodebuild: 400, cacheRestore: 0, cacheSave: 0, other: 400},
    {conclusion: "success", total: 700, queue: 10, xcodebuild: 350, cacheRestore: 0, cacheSave: 0, other: 350},
    {conclusion: "cancelled", total: 60, queue: 1, xcodebuild: 10, cacheRestore: 0, cacheSave: 0, other: 50},
  ]
  const stats = aggregate(rows)
  assert.equal(stats.count, 3)
  assert.deepEqual(stats.total, {median: 700, min: 600, max: 800})
  assert.deepEqual(stats.xcodebuild, {median: 350, min: 300, max: 400})
})

test("aggregate handles an even number of rows and empty input", () => {
  const stats = aggregate([
    {conclusion: "success", total: 100},
    {conclusion: "success", total: 300},
  ])
  assert.equal(stats.total.median, 200)
  assert.equal(aggregate([]).total.median, null)
})

test("formatDuration renders minutes and zero-padded seconds", () => {
  assert.equal(formatDuration(403), "6m 43s")
  assert.equal(formatDuration(5), "0m 05s")
  assert.equal(formatDuration(null), "–")
})

test("renderMarkdown emits a table row per run and a stats block", () => {
  const rows = [summarizeJob(run, job)]
  const md = renderMarkdown(rows, aggregate(rows), {label: "Baseline"})
  assert.match(md, /^### Baseline/)
  assert.match(md, /\[42 \(attempt 2\)\]\(https:\/\/github\.com\/o\/r\/actions\/runs\/42\)/)
  assert.match(md, /\| `abcdef0` \| pull_request \| big-bob \| success \| 13m 00s \| 0m 08s \| 6m 43s \| 0m 45s \| 3m 06s \|/)
  assert.match(md, /\| Total job \| 13m 00s \| 13m 00s \| 13m 00s \|/)
})

test("parseArgs reads options and rejects unknown flags", () => {
  const opts = parseArgs(["--repo", "o/r", "--limit", "3", "--event", "pull_request", "--sha", "ABC", "--only-success", "--json", "--label", "P1"])
  assert.equal(opts.repo, "o/r")
  assert.equal(opts.limit, 3)
  assert.equal(opts.event, "pull_request")
  assert.equal(opts.sha, "abc")
  assert.equal(opts.onlySuccess, true)
  assert.equal(opts.json, true)
  assert.equal(opts.label, "P1")
  assert.throws(() => parseArgs(["--bogus"]), /Unknown argument/)
  assert.throws(() => parseArgs(["--limit", "0"]), /positive integer/)
})
