import assert from "node:assert/strict"
import test from "node:test"

import {
  androidCodeMarkerName,
  prAndroidVersionCode,
  reservedAndroidCodes,
  resolveAndroidVersionCode,
} from "./resolve-android-version-code.mjs"

test("a testing track above the family window lends the code two above its floor and every reservation", () => {
  assert.deepEqual(resolveAndroidVersionCode({planBuildNumber: 302010036, track: "beta", trackCodes: ["310000212"]}), {
    versionCode: 310000214,
    source: "track-floor",
    floor: 310000212,
    reused: false,
  })
  // A run that built 310000214 and stopped before uploading still holds it.
  const reservations = [{code: 310000214, owner: "coordinated-run-1"}]
  assert.equal(
    resolveAndroidVersionCode({
      planBuildNumber: 302010036,
      track: "beta",
      trackCodes: [310000212],
      reservations,
      owner: "coordinated-run-2",
    }).versionCode,
    310000216,
  )
  // Its retry reuses its own reservation instead of allocating again.
  assert.deepEqual(
    resolveAndroidVersionCode({
      planBuildNumber: 302010036,
      track: "beta",
      trackCodes: [310000212],
      reservations,
      owner: "coordinated-run-1",
    }),
    {versionCode: 310000214, source: "reservation", reused: true},
  )
  // Codes Play accepted earlier but no longer serves are skipped too.
  assert.equal(
    resolveAndroidVersionCode({
      planBuildNumber: 302010036,
      track: "beta",
      trackCodes: [310000212],
      usedCodes: [50572796, 310000212, 310000213, 310000214, 310000215, 310000227, 900000002],
    }).versionCode,
    310000216,
  )
  assert.throws(
    () =>
      resolveAndroidVersionCode({planBuildNumber: 302010036, track: "beta", trackCodes: [310000212], usedCodes: [-1]}),
    /invalid used version code/,
  )
  assert.equal(
    resolveAndroidVersionCode({planBuildNumber: 310000300, track: "beta", trackCodes: [310000212]}).source,
    "family",
  )
  assert.equal(
    resolveAndroidVersionCode({planBuildNumber: 302010036, track: "beta", trackCodes: []}).versionCode,
    302010036,
  )
})

test("a pull-request build sits between the latest reserved code and the next beta", () => {
  const reservations = [
    {code: 310000774, owner: "monorepo-release-1"},
    {code: 310000776, owner: "monorepo-release-2"},
  ]
  // A 3.4 PR build, family number 304007989, over beta 310000776.
  const pr = prAndroidVersionCode({familyNumber: 304007989, reservations})
  assert.deepEqual(pr, {versionCode: 310000777, reservedFloor: 310000776, source: "reserved-floor"})
  // A 3.5 dev-branch PR build lands on the same code: the two install over each other.
  assert.equal(prAndroidVersionCode({familyNumber: 305003456, reservations}).versionCode, 310000777)
  // The next beta skips that code, so it installs over the PR build.
  const beta = resolveAndroidVersionCode({
    planBuildNumber: 304000020,
    track: "beta",
    trackCodes: [310000776],
    reservations,
    owner: "monorepo-release-3",
  })
  assert.equal(beta.versionCode, 310000778)
  assert.ok(beta.versionCode > pr.versionCode)
  // Above every borrowed code, the family number wins, as before.
  assert.deepEqual(prAndroidVersionCode({familyNumber: 311003500, reservations}), {
    versionCode: 311003500,
    reservedFloor: 310000776,
    source: "family",
  })
  assert.equal(prAndroidVersionCode({familyNumber: 304007989}).versionCode, 304007989)
  assert.throws(
    () => prAndroidVersionCode({familyNumber: 304007989, reservations: [{code: 2_100_000_000, owner: "x"}]}),
    /above Android's limit/,
  )
  assert.throws(() => prAndroidVersionCode({familyNumber: 0}), /Invalid family build number/)
})

test("production borrows like a beta, two above the beta it promotes", () => {
  assert.deepEqual(
    resolveAndroidVersionCode({
      planBuildNumber: 304000290,
      track: "production",
      trackCodes: [304000275],
      reservations: [{code: 310000776, owner: "monorepo-release-1"}],
      owner: "monorepo-release-2",
    }),
    {versionCode: 310000778, source: "track-floor", floor: 310000776, reused: false},
  )
})

test("Internal App Sharing always carries the family number", () => {
  assert.equal(
    resolveAndroidVersionCode({planBuildNumber: 302010037, track: "internal-app-sharing", trackCodes: [900000002]})
      .versionCode,
    302010037,
  )
})

test("reservations are read from marker names and rejected when invalid", () => {
  assert.equal(
    androidCodeMarkerName(310000213, "coordinated-run-1"),
    "mentra-android-version-code-310000213-coordinated-run-1.json",
  )
  assert.deepEqual(
    reservedAndroidCodes([
      {name: "mentra-android-version-code-310000213-coordinated-run-1.json"},
      {name: "mentra-build-number-302010036.json"},
      {name: "mentraos-3.2.1-beta.312-android.apk"},
    ]),
    [{code: 310000213, owner: "coordinated-run-1"}],
  )
  assert.throws(() => androidCodeMarkerName(1, "Run 1"), /Invalid Android code owner/)
  assert.throws(() => resolveAndroidVersionCode({planBuildNumber: 0, track: "beta"}), /Invalid plan build number/)
  assert.throws(() => resolveAndroidVersionCode({planBuildNumber: 1, track: ""}), /track is required/)
  assert.throws(
    () => resolveAndroidVersionCode({planBuildNumber: 1, track: "beta", trackCodes: ["x"]}),
    /invalid version code/,
  )
  assert.throws(
    () =>
      resolveAndroidVersionCode({
        planBuildNumber: 1,
        track: "beta",
        reservations: [
          {code: 5, owner: "coordinated-run-1"},
          {code: 6, owner: "coordinated-run-1"},
        ],
        owner: "coordinated-run-1",
      }),
    /more than one/,
  )
})
