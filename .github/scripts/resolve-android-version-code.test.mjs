import assert from "node:assert/strict"
import test from "node:test"

import {resolveAndroidVersionCode} from "./resolve-android-version-code.mjs"

test("a testing track above the family window lends its floor plus one; otherwise the family number", () => {
  assert.deepEqual(resolveAndroidVersionCode({planBuildNumber: 302010036, track: "beta", trackCodes: ["310000212"]}), {
    versionCode: 310000213,
    source: "track-floor",
    floor: 310000212,
  })
  assert.deepEqual(
    resolveAndroidVersionCode({planBuildNumber: 302010036, track: "beta", trackCodes: [310000212, 305000000]}),
    {
      versionCode: 310000213,
      source: "track-floor",
      floor: 310000212,
    },
  )
  assert.deepEqual(resolveAndroidVersionCode({planBuildNumber: 310000300, track: "beta", trackCodes: [310000212]}), {
    versionCode: 310000300,
    source: "family",
  })
  assert.deepEqual(resolveAndroidVersionCode({planBuildNumber: 302010036, track: "beta", trackCodes: []}), {
    versionCode: 302010036,
    source: "family",
  })
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

test("rejects invalid inputs", () => {
  assert.throws(() => resolveAndroidVersionCode({planBuildNumber: 0, track: "beta"}), /Invalid plan build number/)
  assert.throws(() => resolveAndroidVersionCode({planBuildNumber: 1, track: ""}), /track is required/)
  assert.throws(
    () => resolveAndroidVersionCode({planBuildNumber: 1, track: "beta", trackCodes: ["x"]}),
    /invalid version code/,
  )
})
