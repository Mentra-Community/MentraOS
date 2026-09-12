import assert from "node:assert/strict"
import test from "node:test"

import {allocateAsgVersion, asgVersionCodePrefix} from "./allocate-asg-version.mjs"

const fingerprint = "a".repeat(64)
const other = "b".repeat(64)

function asset(id, versionCode, selectedFingerprint, extension) {
  return {id, name: `mentra-live-asg-${versionCode}-${selectedFingerprint}.${extension}`}
}

test("derives the version code prefix from the family base version", () => {
  assert.equal(asgVersionCodePrefix("3.1.0"), 301_000_000)
  assert.equal(asgVersionCodePrefix("3.2.4"), 302_040_000)
  assert.equal(asgVersionCodePrefix("20.99.99"), 2_099_990_000)
  assert.throws(() => asgVersionCodePrefix("3.1.0-beta.5"), /plain X\.Y\.Z/)
  assert.throws(() => asgVersionCodePrefix("1.9.0"), /major 1 must be between 2 and 20/)
  assert.throws(() => asgVersionCodePrefix("21.0.0"), /major 21 must be between 2 and 20/)
  assert.throws(() => asgVersionCodePrefix("3.100.0"), /at most 99/)
})

test("allocates the first code of a base version above every legacy namespace", () => {
  const result = allocateAsgVersion({
    assets: [
      asset(1, 52_000_000, other, "apk"),
      asset(2, 52_000_000, other, "json"),
      asset(3, 100_000_173, "c".repeat(64), "apk"),
      asset(4, 100_000_173, "c".repeat(64), "json"),
    ],
    fingerprint,
    baseVersion: "3.1.0",
  })
  assert.equal(result.exists, false)
  assert.equal(result.versionCode, 301_000_001)
  assert.ok(result.versionCode > 100_000_173)
  assert.equal(result.apkAsset, `mentra-live-asg-301000001-${fingerprint}.apk`)
  assert.deepEqual(result.orphanAssetIds, [])
})

test("counts distinct builds within one base version and ignores other versions", () => {
  const result = allocateAsgVersion({
    assets: [
      asset(1, 301_000_001, other, "apk"),
      asset(2, 301_000_001, other, "json"),
      asset(3, 301_000_002, "c".repeat(64), "apk"),
      asset(4, 301_000_002, "c".repeat(64), "json"),
      asset(5, 302_000_007, "d".repeat(64), "apk"),
      asset(6, 302_000_007, "d".repeat(64), "json"),
    ],
    fingerprint,
    baseVersion: "3.1.0",
  })
  assert.equal(result.versionCode, 301_000_003)
  assert.equal(allocateAsgVersion({assets: [], fingerprint, baseVersion: "3.2.0"}).versionCode, 302_000_001)
})

test("reuses the recorded code for an existing complete fingerprint", () => {
  const result = allocateAsgVersion({
    assets: [asset(1, 301_000_042, fingerprint, "apk"), asset(2, 301_000_042, fingerprint, "json")],
    fingerprint,
    baseVersion: "3.1.0",
  })
  assert.equal(result.exists, true)
  assert.equal(result.versionCode, 301_000_042)
  assert.throws(
    () =>
      allocateAsgVersion({
        assets: [asset(1, 100_000_173, fingerprint, "apk"), asset(2, 100_000_173, fingerprint, "json")],
        fingerprint,
        baseVersion: "3.1.0",
      }),
    /does not belong to base version 3\.1\.0/,
  )
})

test("marks an interrupted asset pair for removal before rebuilding", () => {
  const result = allocateAsgVersion({
    assets: [asset(7, 301_000_005, fingerprint, "apk")],
    fingerprint,
    baseVersion: "3.1.0",
  })
  assert.equal(result.exists, false)
  assert.equal(result.versionCode, 301_000_006)
  assert.deepEqual(result.orphanAssetIds, [7])
})

test("rejects duplicate and mismatched complete pairs and an exhausted base version", () => {
  assert.throws(
    () =>
      allocateAsgVersion({
        assets: [asset(1, 301_000_057, fingerprint, "apk"), asset(2, 301_000_057, fingerprint, "apk")],
        fingerprint,
        baseVersion: "3.1.0",
      }),
    /Duplicate/,
  )
  assert.throws(
    () =>
      allocateAsgVersion({
        assets: [asset(1, 301_000_057, fingerprint, "apk"), asset(2, 301_000_058, fingerprint, "json")],
        fingerprint,
        baseVersion: "3.1.0",
      }),
    /different version codes/,
  )
  assert.throws(
    () =>
      allocateAsgVersion({
        assets: [asset(1, 301_009_999, other, "apk"), asset(2, 301_009_999, other, "json")],
        fingerprint,
        baseVersion: "3.1.0",
      }),
    /exhausted/,
  )
})
