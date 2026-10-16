import assert from "node:assert/strict"
import {execFileSync} from "node:child_process"
import {fileURLToPath} from "node:url"
import test from "node:test"

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
