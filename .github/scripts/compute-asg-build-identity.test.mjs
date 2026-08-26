import assert from "node:assert/strict"
import test from "node:test"

import {
  computeAsgBuildFingerprint,
  computeAsgBuildIdentity,
  finalizeAsgBuildIdentity,
} from "./compute-asg-build-identity.mjs"

const entries = [
  {mode: "100644", object: "a".repeat(40), path: "asg_client/app/build.gradle"},
  {mode: "160000", object: "b".repeat(40), path: "asg_client/StreamPackLite"},
]

test("derives a deterministic content-addressed ASG identity", () => {
  const first = computeAsgBuildIdentity({entries, latestInputCommitTimestamp: 1_782_000_000, versionCode: 100_057})
  const reordered = computeAsgBuildIdentity({
    entries: [...entries].reverse(),
    latestInputCommitTimestamp: 1_782_000_000,
    versionCode: 100_057,
  })

  assert.deepEqual(first, reordered)
  assert.match(first.fingerprint, /^[0-9a-f]{64}$/)
  assert.equal(first.versionCode, 100_057)
  assert.equal(first.versionName, `asg.100057.${first.fingerprint.slice(0, 12)}`)
  assert.equal(first.apkAsset, `mentra-live-asg-${first.versionCode}-${first.fingerprint}.apk`)
})

test("changes identity when an effective source or build contract changes", () => {
  const baseline = computeAsgBuildIdentity({entries, latestInputCommitTimestamp: 1_782_000_000, versionCode: 100_057})
  const sourceChange = computeAsgBuildIdentity({
    entries: [{...entries[0], object: "c".repeat(40)}, entries[1]],
    latestInputCommitTimestamp: 1_782_000_100,
    versionCode: 100_058,
  })
  const contractChange = computeAsgBuildIdentity({
    entries,
    latestInputCommitTimestamp: 1_782_000_000,
    versionCode: 100_057,
    contract: {androidBuildVariant: "release", javaVersion: "21"},
  })

  assert.notEqual(sourceChange.fingerprint, baseline.fingerprint)
  assert.notEqual(sourceChange.versionCode, baseline.versionCode)
  assert.notEqual(contractChange.fingerprint, baseline.fingerprint)
})

test("allocates the externally selected version code without changing the content fingerprint", () => {
  const fingerprint = computeAsgBuildFingerprint({entries, latestInputCommitTimestamp: 1_782_000_000})
  const first = finalizeAsgBuildIdentity({buildFingerprint: fingerprint, versionCode: 100_057})
  const later = finalizeAsgBuildIdentity({buildFingerprint: fingerprint, versionCode: 100_099})

  assert.equal(first.fingerprint, later.fingerprint)
  assert.equal(first.versionCode, 100_057)
  assert.equal(later.versionCode, 100_099)
})

test("rejects malformed input entries, timestamps, and version codes", () => {
  assert.throws(
    () => computeAsgBuildIdentity({entries: [], latestInputCommitTimestamp: 1, versionCode: 100_001}),
    /must not be empty/,
  )
  assert.throws(
    () =>
      computeAsgBuildIdentity({
        entries: [{mode: "bad", object: "x", path: "asg"}],
        latestInputCommitTimestamp: 1,
        versionCode: 100_001,
      }),
    /Invalid ASG build input/,
  )
  assert.throws(
    () => computeAsgBuildIdentity({entries, latestInputCommitTimestamp: 1, versionCode: 0}),
    /outside the Android-safe range/,
  )
})
