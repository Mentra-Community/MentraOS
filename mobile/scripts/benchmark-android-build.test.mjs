import assert from "node:assert/strict"
import test from "node:test"

import {compareRecords, parseAutolinkingGuard, parseGradleSummary} from "./benchmark-android-build.mjs"

test("parseGradleSummary reads the last successful app build", () => {
  const summary = parseGradleSummary(`
BUILD SUCCESSFUL in 21s
32 actionable tasks: 22 executed, 10 up-to-date
BUILD SUCCESSFUL in 16s
482 actionable tasks: 27 executed, 3 from cache, 452 up-to-date
`)
  assert.equal(summary.wallMs, 16_000)
  assert.equal(summary.actionable, 482)
  assert.equal(summary.executed, 27)
  assert.equal(summary.fromCache, 3)
  assert.equal(summary.upToDate, 452)
})

test("parseAutolinkingGuard reads wipe decisions", () => {
  assert.deepEqual(parseAutolinkingGuard("[autolinking-guard] kept (clean)"), {wiped: false, reason: "clean"})
  assert.deepEqual(parseAutolinkingGuard("[autolinking-guard] wiped (packageName)"), {wiped: true, reason: "packageName"})
  assert.deepEqual(parseAutolinkingGuard("no guard line"), {wiped: null, reason: null})
})

test("compareRecords reports savings", () => {
  const delta = compareRecords(
    {totalWallMs: 90_000, gradle: {wallMs: 16_000, executed: 32}, apk: {mb: 467.3, abis: ["arm64-v8a", "armeabi-v7a"]}, install: {ms: 20_000, mbps: 23}},
    {totalWallMs: 70_000, gradle: {wallMs: 8_000, executed: 18}, apk: {mb: 320, abis: ["arm64-v8a"]}, install: {ms: 12_000, mbps: 26}},
  )
  assert.equal(delta.gradleWallMs.savedMs, 8_000)
  assert.equal(delta.totalWallMs.savedMs, 20_000)
  assert.deepEqual(delta.apkAbis.after, ["arm64-v8a"])
})
