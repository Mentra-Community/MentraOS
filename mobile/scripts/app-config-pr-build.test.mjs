import assert from "node:assert/strict"
import {execFileSync} from "node:child_process"
import {fileURLToPath} from "node:url"
import test from "node:test"
import {backendTarget} from "./backend-target.cjs"

const mobile = fileURLToPath(new URL("..", import.meta.url))
const fingerprint = "f".repeat(64)

function packagedBuild(workflowSha, compilationSha) {
  const output = execFileSync(process.execPath, ["--require", "tsx/cjs", "--eval",
    'const configure = require("./app.config.ts"); console.log(JSON.stringify(configure({config: {}}).extra.mentraPrBuild))',
  ], {
    cwd: mobile,
    encoding: "utf8",
    env: {
      ...process.env,
      EXPO_PUBLIC_MAPBOX_ACCESS_TOKEN: "ci-dummy-not-a-real-token",
      MENTRAOS_PINNED_BUILD_NUMBER: "303000123",
      MENTRA_PR_MOBILE_FINGERPRINT: fingerprint,
      MENTRA_PR_BUILD_SHA: compilationSha,
      GITHUB_SHA: workflowSha,
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
      MENTRA_PR_MOBILE_FINGERPRINT: pr ? fingerprint : "", MENTRA_PR_BUILD_SHA: "b".repeat(40),
      EXPO_PUBLIC_CLOUD_CORE_URL: "https://core.staging.us-west-2.mentraglass.com",
    }})
    const extra = JSON.parse(output)
    assert.deepEqual(extra.mentraBackendTarget, {schemaVersion: 1, coreUrl: "https://core.staging.us-west-2.mentraglass.com"})
    assert.equal(extra.unrelated, true)
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
      MENTRA_PR_MOBILE_FINGERPRINT: pr ? fingerprint : "", MENTRA_PR_BUILD_SHA: "b".repeat(40),
    }
    if (value === undefined) delete env.EXPO_PUBLIC_CLOUD_CORE_URL
    else env.EXPO_PUBLIC_CLOUD_CORE_URL = value
    const extra = JSON.parse(execFileSync(process.execPath, ["--require", "tsx/cjs", "--eval",
      'const configure = require("./app.config.ts"); console.log(JSON.stringify(configure({config: {extra: {unrelated: true, mentraBackendTarget: {schemaVersion: 1, coreUrl: "https://stale.example"}}}}).extra))',
    ], {cwd: mobile, encoding: "utf8", env}))
    assert.deepEqual(extra.mentraBackendTarget, {schemaVersion: 1, coreUrl: "https://core.dev.us-west-2.mentraglass.com"})
    assert.equal(extra.unrelated, true)
    assert.equal(Boolean(extra.mentraPrBuild), pr)
  }
})

test("explicit PR builds package the checked-out compilation revision, not the workflow ref", () => {
  const workflowSha = "a".repeat(40), compilationSha = "b".repeat(40)
  const build = packagedBuild(workflowSha, compilationSha)
  assert.equal(build.mobileSourceCommit, compilationSha)
  assert.equal(build.mobileFingerprint, fingerprint)
  assert.equal(build.schemaVersion, 1)
  assert.equal(build.otaManifestUrl, "")
})

test("ordinary pull-request builds retain their matching compilation revision", () => {
  const mergeSha = "c".repeat(40)
  assert.equal(packagedBuild(mergeSha, mergeSha).mobileSourceCommit, mergeSha)
})
