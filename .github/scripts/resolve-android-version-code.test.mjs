import assert from "node:assert/strict"
import test from "node:test"

import {
  androidCodeMarkerName,
  reservedAndroidCodes,
  resolveAndroidVersionCode,
} from "./resolve-android-version-code.mjs"

test("a testing track above the family window lends the next code above its floor and every reservation", () => {
  assert.deepEqual(resolveAndroidVersionCode({planBuildNumber: 302010036, track: "beta", trackCodes: ["310000212"]}), {
    versionCode: 310000213,
    source: "track-floor",
    floor: 310000212,
    reused: false,
  })
  // A run that built 310000213 and stopped before uploading still holds it.
  const reservations = [{code: 310000213, owner: "coordinated-run-1"}]
  assert.equal(
    resolveAndroidVersionCode({
      planBuildNumber: 302010036,
      track: "beta",
      trackCodes: [310000212],
      reservations,
      owner: "coordinated-run-2",
    }).versionCode,
    310000214,
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
    {versionCode: 310000213, source: "reservation", reused: true},
  )
  // Codes Play accepted earlier but no longer serves are skipped too.
  assert.equal(
    resolveAndroidVersionCode({
      planBuildNumber: 302010036,
      track: "beta",
      trackCodes: [310000212],
      usedCodes: [50572796, 310000212, 310000213, 310000214, 310000227, 900000002],
    }).versionCode,
    310000215,
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

test("production and Internal App Sharing always carry the family number", () => {
  assert.equal(
    resolveAndroidVersionCode({planBuildNumber: 302010037, track: "production", trackCodes: [301010003]}).versionCode,
    302010037,
  )
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
