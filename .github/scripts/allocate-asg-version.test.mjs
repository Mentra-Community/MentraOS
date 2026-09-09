import assert from "node:assert/strict"
import test from "node:test"

import {allocateAsgVersion} from "./allocate-asg-version.mjs"

const fingerprint = "a".repeat(64)

function asset(id, versionCode, selectedFingerprint, extension) {
  return {id, name: `mentra-live-asg-${versionCode}-${selectedFingerprint}.${extension}`}
}

test("allocates from the monotonic workflow run number for a new fingerprint", () => {
  const result = allocateAsgVersion({assets: [], fingerprint, runNumber: 57})
  assert.equal(result.exists, false)
  assert.equal(result.versionCode, 100_000_057)
  assert.deepEqual(result.orphanAssetIds, [])
})

test("allocates above the complete legacy timestamp namespace at cutover", () => {
  const result = allocateAsgVersion({
    assets: [asset(1, 52_000_000, "b".repeat(64), "apk"), asset(2, 52_000_000, "b".repeat(64), "json")],
    fingerprint,
    runNumber: 1,
  })
  assert.equal(result.versionCode, 100_000_001)
})

test("reuses the recorded code for an existing complete fingerprint", () => {
  const result = allocateAsgVersion({
    assets: [asset(1, 100_000_042, fingerprint, "apk"), asset(2, 100_000_042, fingerprint, "json")],
    fingerprint,
    runNumber: 99,
  })
  assert.equal(result.exists, true)
  assert.equal(result.versionCode, 100_000_042)
})

test("allocates above all published codes when retrying an older workflow run", () => {
  const result = allocateAsgVersion({
    assets: [asset(1, 100_000_120, "b".repeat(64), "apk"), asset(2, 100_000_120, "b".repeat(64), "json")],
    fingerprint,
    runNumber: 57,
  })
  assert.equal(result.versionCode, 100_000_121)
})

test("marks an interrupted asset pair for removal before rebuilding", () => {
  const result = allocateAsgVersion({
    assets: [asset(7, 100_000_057, fingerprint, "apk")],
    fingerprint,
    runNumber: 57,
  })
  assert.equal(result.exists, false)
  assert.equal(result.versionCode, 100_000_058)
  assert.deepEqual(result.orphanAssetIds, [7])
})

test("rejects duplicate and mismatched complete pairs", () => {
  assert.throws(
    () =>
      allocateAsgVersion({
        assets: [asset(1, 100_000_057, fingerprint, "apk"), asset(2, 100_000_057, fingerprint, "apk")],
        fingerprint,
        runNumber: 57,
      }),
    /Duplicate/,
  )
  assert.throws(
    () =>
      allocateAsgVersion({
        assets: [asset(1, 100_000_057, fingerprint, "apk"), asset(2, 100_000_058, fingerprint, "json")],
        fingerprint,
        runNumber: 57,
      }),
    /different version codes/,
  )
})
