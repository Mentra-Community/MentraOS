import assert from "node:assert/strict"
import {execFileSync} from "node:child_process"
import {readFileSync} from "node:fs"
import {fileURLToPath} from "node:url"
import test from "node:test"
import {backendTarget} from "./backend-target.cjs"

const mobile = fileURLToPath(new URL("..", import.meta.url))
const fingerprint = "f".repeat(64)

function packagedBuild(env = {}) {
  const output = execFileSync(process.execPath, ["--require", "tsx/cjs", "--eval",
    'const configure = require("./app.config.ts"); console.log(JSON.stringify(configure({config: {}}).extra.mentraBuild))',
  ], {
    cwd: mobile,
    encoding: "utf8",
    env: {
      ...process.env,
      EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN: "ci-dummy-not-a-real-token",
      MENTRAOS_PINNED_BUILD_NUMBER: "303000123",
      MENTRA_MOBILE_FINGERPRINT: fingerprint,
      MENTRA_MOBILE_SOURCE_COMMIT: "b".repeat(40),
      ...env,
    },
  })
  return JSON.parse(output)
}
test("ordinary and PR Expo generation retain the exact build backend baseline", () => {
  for (const pr of [false, true]) {
    const output = execFileSync(process.execPath, ["--require", "tsx/cjs", "--eval",
      'const configure = require("./app.config.ts"); console.log(JSON.stringify(configure({config: {extra: {unrelated: true}}}).extra))',
    ], {cwd: mobile, encoding: "utf8", env: {...process.env,
      EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN: "ci-dummy-not-a-real-token", MENTRAOS_PINNED_BUILD_NUMBER: "303000123",
      MENTRA_MOBILE_FINGERPRINT: pr ? fingerprint : "", MENTRA_MOBILE_SOURCE_COMMIT: "b".repeat(40),
      EXPO_PUBLIC_CLOUD_CORE_URL: "https://core.staging.us-west-2.mentraglass.com",
    }})
    const extra = JSON.parse(output)
    assert.deepEqual(extra.mentraBackendTarget, {schemaVersion: 1, coreUrl: "https://core.staging.us-west-2.mentraglass.com"})
    assert.equal(extra.unrelated, true)
  }
})

test("ordinary and PR builds package the Mentra App's own App Store age rating", () => {
  for (const pr of [false, true]) {
    const output = execFileSync(process.execPath, ["--require", "tsx/cjs", "--eval",
      'const configure = require("./app.config.ts"); console.log(JSON.stringify(configure({config: {}}).extra))',
    ], {cwd: mobile, encoding: "utf8", env: {...process.env,
      EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN: "ci-dummy-not-a-real-token", MENTRAOS_PINNED_BUILD_NUMBER: "303000123",
      MENTRA_MOBILE_FINGERPRINT: pr ? fingerprint : "", MENTRA_MOBILE_SOURCE_COMMIT: "b".repeat(40),
    }})
    assert.equal(JSON.parse(output).MENTRA_APP_AGE_RATING, "12+")
  }
})

test("all baseline contexts preserve the existing service URL without consulting Expo runtime extra", () => {
  for (const value of ["https://core.dev.us-west-2.mentraglass.com", "https://core.staging.us-west-2.mentraglass.com",
    "https://core.mentraglass.com", "http://localhost:3000/workspace", "  https://custom.example:8443/core  "])
    assert.equal(backendTarget(value), value.trim())
  for (const value of [undefined, "", "  "]) assert.equal(backendTarget(value), "https://core.dev.us-west-2.mentraglass.com")
})

test("unset or blank build environment never retains a stale generated target", () => {
  for (const pr of [false, true]) for (const value of [undefined, "", "  "]) {
    const env = {...process.env,
      EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN: "ci-dummy-not-a-real-token", MENTRAOS_PINNED_BUILD_NUMBER: "303000123",
      MENTRA_MOBILE_FINGERPRINT: pr ? fingerprint : "", MENTRA_MOBILE_SOURCE_COMMIT: "b".repeat(40),
    }
    if (value === undefined) delete env.EXPO_PUBLIC_CLOUD_CORE_URL
    else env.EXPO_PUBLIC_CLOUD_CORE_URL = value
    const extra = JSON.parse(execFileSync(process.execPath, ["--require", "tsx/cjs", "--eval",
      'const configure = require("./app.config.ts"); console.log(JSON.stringify(configure({config: {extra: {unrelated: true, mentraBackendTarget: {schemaVersion: 1, coreUrl: "https://stale.example"}}}}).extra))',
    ], {cwd: mobile, encoding: "utf8", env}))
    assert.deepEqual(extra.mentraBackendTarget, {schemaVersion: 1, coreUrl: "https://core.dev.us-west-2.mentraglass.com"})
    assert.equal(extra.unrelated, true)
    assert.equal(Boolean(extra.mentraBuild), pr)
  }
})

test("a PR compile leaves its OTA manifest and build info for packaging to write", () => {
  const build = packagedBuild({MENTRA_OTA_MANIFEST_URL: "", MENTRA_APP_IDENTITY: "", MENTRA_BUILD_COMMIT: ""})
  assert.deepEqual(build, {
    schemaVersion: 2,
    mobileFingerprint: fingerprint,
    mobileSourceCommit: "b".repeat(40),
    otaManifestUrl: "",
    identity: JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version,
    buildInfo: "",
    buildNumber: 303000123,
  })
})

test("a release compile packages its OTA manifest, identity and build info, none of them in the JS bundle", () => {
  const build = packagedBuild({
    MENTRA_OTA_MANIFEST_URL: "https://cdn.example/mentra-live-ota-3.5.0-beta.1351.json",
    MENTRA_APP_IDENTITY: "3.5.0-beta.1351",
    MENTRA_BUILD_COMMIT: "c".repeat(40),
    MENTRA_BUILD_BRANCH: "beta",
    MENTRA_BUILD_TIME: "2026-11-19T12:00:00Z",
    MENTRA_BUILD_USER: "release",
  })
  assert.equal(build.otaManifestUrl, "https://cdn.example/mentra-live-ota-3.5.0-beta.1351.json")
  assert.equal(build.identity, "3.5.0-beta.1351")
  assert.deepEqual(build.buildInfo, {commit: "c".repeat(40), branch: "beta", time: "2026-11-19T12:00:00Z", user: "release"})
})
