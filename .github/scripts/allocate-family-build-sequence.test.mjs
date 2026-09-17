import assert from "node:assert/strict"
import {mkdtempSync, readFileSync} from "node:fs"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"

import {
  allocateFamilyBuildNumber,
  familyBuildNumberMarker,
  markerAssetName,
  readMarkersDirectory,
  recordedFamilyBuildNumbers,
  writeMarker,
} from "./allocate-family-build-sequence.mjs"
import {familyBuildNumber} from "./release-family.mjs"

const marker = (version, sequence) => ({name: markerAssetName(familyBuildNumber(version, sequence))})
const owner = "coordinated-run:123"

test("a new family starts at sequence 1 and every later run takes the next free number above markers and ASG pairs", () => {
  assert.deepEqual(allocateFamilyBuildNumber({assets: [], baseVersion: "3.1.1", owner}), {
    familyBaseVersion: "3.1.1",
    buildNumber: familyBuildNumber("3.1.1", 1),
    sequence: 1,
    owner,
    reused: false,
  })
  const assets = [
    marker("3.1.1", 1),
    marker("3.1.1", 2),
    marker("3.1.1", 5),
    marker("3.2.0", 40),
    {name: "mentra-release-plan-3.1.1-beta.240.json"},
    {name: `mentra-live-asg-${familyBuildNumber("3.1.1", 9)}-${"a".repeat(64)}.apk`},
    {name: "mentra-live-asg-100000173-" + "a".repeat(64) + ".apk"},
  ]
  // An ASG pair numbered before markers existed holds its number too.
  assert.deepEqual(recordedFamilyBuildNumbers(assets, "3.1.1"), [
    familyBuildNumber("3.1.1", 1),
    familyBuildNumber("3.1.1", 2),
    familyBuildNumber("3.1.1", 5),
    familyBuildNumber("3.1.1", 9),
  ])
  assert.equal(allocateFamilyBuildNumber({assets, baseVersion: "3.1.1", owner}).sequence, 10)
  assert.equal(allocateFamilyBuildNumber({assets, baseVersion: "3.2.0", owner}).sequence, 41)
  assert.equal(allocateFamilyBuildNumber({assets, baseVersion: "3.3.0", owner}).sequence, 1)
})

test("an owner reuses its own reservation and other owners never share bytes", () => {
  const mine = familyBuildNumberMarker({baseVersion: "3.1.1", buildNumber: familyBuildNumber("3.1.1", 7), owner})
  const theirs = familyBuildNumberMarker({
    baseVersion: "3.1.1",
    buildNumber: familyBuildNumber("3.1.1", 7),
    owner: "coordinated-run:456",
  })
  assert.notEqual(JSON.stringify(mine), JSON.stringify(theirs))
  assert.deepEqual(mine, {
    schemaVersion: 1,
    kind: "mentra-family-build-number",
    familyBaseVersion: "3.1.1",
    buildNumber: familyBuildNumber("3.1.1", 7),
    sequence: 7,
    owner,
  })
  // A retry that finds its own marker keeps the number even though the
  // container has moved on.
  const assets = [marker("3.1.1", 7), marker("3.1.1", 8)]
  assert.deepEqual(allocateFamilyBuildNumber({assets, baseVersion: "3.1.1", owner, markers: [theirs, mine]}), {
    familyBaseVersion: "3.1.1",
    buildNumber: familyBuildNumber("3.1.1", 7),
    sequence: 7,
    owner,
    reused: true,
  })
  assert.equal(allocateFamilyBuildNumber({assets, baseVersion: "3.1.1", owner, markers: [theirs]}).sequence, 9)
  assert.throws(
    () =>
      allocateFamilyBuildNumber({
        assets,
        baseVersion: "3.1.1",
        owner,
        markers: [mine, {...mine, buildNumber: familyBuildNumber("3.1.1", 8)}],
      }),
    /owns more than one/,
  )
  assert.throws(
    () =>
      allocateFamilyBuildNumber({
        assets,
        baseVersion: "3.1.1",
        owner,
        markers: [{...mine, familyBaseVersion: "3.2.0"}],
      }),
    /belongs to family 3\.2\.0/,
  )
  assert.throws(
    () => allocateFamilyBuildNumber({assets, baseVersion: "3.1.1", owner: "run 12"}),
    /Invalid build number owner/,
  )
  const directory = mkdtempSync(path.join(tmpdir(), "family-markers-"))
  const file = writeMarker(directory, mine)
  assert.equal(path.basename(file), "mentra-build-number-301010007.json")
  assert.deepEqual(readMarkersDirectory(directory), [JSON.parse(readFileSync(file, "utf8"))])
  assert.deepEqual(readMarkersDirectory(undefined), [])
})

test("the release band is bounded", () => {
  assert.throws(
    () => allocateFamilyBuildNumber({assets: [marker("3.1.1", 2999)], baseVersion: "3.1.1", owner}),
    /exhausted/,
  )
  assert.throws(() => allocateFamilyBuildNumber({assets: null, baseVersion: "3.1.1", owner}), /must be an array/)
  assert.throws(
    () => familyBuildNumberMarker({baseVersion: "3.1.1", buildNumber: 900000002, owner}),
    /does not belong to family/,
  )
})
