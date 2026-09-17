import assert from "node:assert/strict"
import test from "node:test"

import {allocateAsgVersion, asgVersionCodePrefix} from "./allocate-asg-version.mjs"

const fingerprint = "a".repeat(64)
const other = "b".repeat(64)

function asset(id, versionCode, selectedFingerprint, extension) {
  return {id, name: `mentra-live-asg-${versionCode}-${selectedFingerprint}.${extension}`}
}

test("derives the version code prefix from the family build-number formula", () => {
  assert.equal(asgVersionCodePrefix("3.1.0"), 301_000_000)
  assert.equal(asgVersionCodePrefix("3.1.1"), 301_010_000)
  assert.equal(asgVersionCodePrefix("3.2.4"), 302_040_000)
  assert.equal(asgVersionCodePrefix("20.99.99"), 2_099_990_000)
  assert.throws(() => asgVersionCodePrefix("3.1.0-beta.5"), /plain X\.Y\.Z/)
  assert.throws(() => asgVersionCodePrefix("1.9.0"), /major 1 must be between 2 and 20/)
  assert.throws(() => asgVersionCodePrefix("21.0.0"), /major 21 must be between 2 and 20/)
  assert.throws(() => asgVersionCodePrefix("3.100.0"), /minor 100 must be at most 99/)
})

test("a rebuilt ASG client takes exactly the number its run reserved", () => {
  const result = allocateAsgVersion({
    assets: [
      asset(1, 52_000_000, other, "apk"),
      asset(2, 52_000_000, other, "json"),
      asset(3, 100_000_173, "c".repeat(64), "apk"),
      asset(4, 100_000_173, "c".repeat(64), "json"),
      asset(5, 301_010_003, "d".repeat(64), "apk"),
      asset(6, 301_010_003, "d".repeat(64), "json"),
    ],
    fingerprint,
    baseVersion: "3.1.1",
    buildNumber: 301_010_005,
  })
  assert.deepEqual(result, {
    exists: false,
    versionCode: 301_010_005,
    apkAsset: `mentra-live-asg-301010005-${fingerprint}.apk`,
    provenanceAsset: `mentra-live-asg-301010005-${fingerprint}.json`,
    orphanAssetIds: [],
  })
  // An older run's number is never moved above a newer build: it is used as is.
  assert.equal(
    allocateAsgVersion({
      assets: [asset(5, 301_010_040, other, "apk"), asset(6, 301_010_040, other, "json")],
      fingerprint,
      baseVersion: "3.1.1",
      buildNumber: 301_010_030,
    }).versionCode,
    301_010_030,
  )
})

test("reuses the recorded code for an existing complete fingerprint in the family window", () => {
  const result = allocateAsgVersion({
    assets: [asset(1, 301_010_042, fingerprint, "apk"), asset(2, 301_010_042, fingerprint, "json")],
    fingerprint,
    baseVersion: "3.1.1",
    buildNumber: 301_010_300,
  })
  assert.equal(result.exists, true)
  assert.equal(result.versionCode, 301_010_042)
  // A pair of the same fingerprint under an older scheme is not this family's build.
  const legacy = allocateAsgVersion({
    assets: [asset(1, 100_000_173, fingerprint, "apk"), asset(2, 100_000_173, fingerprint, "json")],
    fingerprint,
    baseVersion: "3.1.0",
    buildNumber: 301_000_300,
  })
  assert.equal(legacy.exists, false)
  assert.equal(legacy.versionCode, 301_000_300)
  assert.deepEqual(legacy.orphanAssetIds, [])
})

test("a pull-request selection only asks for reuse", () => {
  const miss = allocateAsgVersion({
    assets: [asset(7, 301_010_005, fingerprint, "apk")],
    fingerprint,
    baseVersion: "3.1.1",
  })
  assert.deepEqual(miss, {exists: false, versionCode: null, apkAsset: null, provenanceAsset: null, orphanAssetIds: [7]})
  const hit = allocateAsgVersion({
    assets: [asset(1, 301_010_042, fingerprint, "apk"), asset(2, 301_010_042, fingerprint, "json")],
    fingerprint,
    baseVersion: "3.1.1",
  })
  assert.equal(hit.exists, true)
})

test("marks an interrupted asset pair for removal before rebuilding at the reserved number", () => {
  const result = allocateAsgVersion({
    assets: [asset(7, 301_010_005, fingerprint, "apk")],
    fingerprint,
    baseVersion: "3.1.1",
    buildNumber: 301_010_005,
  })
  assert.equal(result.exists, false)
  assert.equal(result.versionCode, 301_010_005)
  assert.deepEqual(result.orphanAssetIds, [7])
})

test("fails closed on conflicts, duplicates, out-of-window and out-of-band numbers", () => {
  assert.throws(
    () =>
      allocateAsgVersion({
        assets: [asset(1, 301_010_057, other, "apk"), asset(2, 301_010_057, other, "json")],
        fingerprint,
        baseVersion: "3.1.1",
        buildNumber: 301_010_057,
      }),
    /already used by mentra-live-asg-301010057/,
  )
  assert.throws(
    () =>
      allocateAsgVersion({
        assets: [asset(1, 301_010_057, fingerprint, "apk"), asset(2, 301_010_057, fingerprint, "apk")],
        fingerprint,
        baseVersion: "3.1.1",
        buildNumber: 301_010_060,
      }),
    /Duplicate/,
  )
  assert.throws(
    () =>
      allocateAsgVersion({
        assets: [asset(1, 301_010_057, fingerprint, "apk"), asset(2, 301_010_058, fingerprint, "json")],
        fingerprint,
        baseVersion: "3.1.1",
        buildNumber: 301_010_060,
      }),
    /different version codes/,
  )
  assert.throws(
    () => allocateAsgVersion({assets: [], fingerprint, baseVersion: "3.1.1", buildNumber: 900000002}),
    /does not belong to base version/,
  )
  assert.throws(
    () => allocateAsgVersion({assets: [], fingerprint, baseVersion: "3.1.1", buildNumber: 301_013_000}),
    /outside the release band/,
  )
})
