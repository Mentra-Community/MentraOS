import assert from "node:assert/strict"
import {mkdtemp, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import path from "node:path"
import test from "node:test"
import {publishSdkTestsArtifacts, reusableSdkTestsApk, validateSdkTestsReceipt} from "./pr-sdk-tests-artifacts.mjs"

const fp = "f".repeat(64), digest = "d".repeat(64), now = Date.parse("2026-11-27T00:00:00Z")
const apk = (pr, label, created_at) => ({name: `mentra-sdk-tests-android-pr-${pr}-${"a".repeat(40)}-1-1.apk`, label, digest: `sha256:${digest}`, size: 9, created_at})
const env = {PR_NUMBER: "7", PR_HEAD_SHA: "b".repeat(40), GITHUB_RUN_ID: "5", GITHUB_RUN_ATTEMPT: "1",
  GITHUB_REPOSITORY: "Mentra-Community/Mentra", GITHUB_SHA: "c".repeat(40), SDK_TESTS_FINGERPRINT: fp}
const coordinates = {pr: 7, sha: "b".repeat(40), runId: 5, attempt: 1}
// The files a publication uploads, in order, with their extra arguments.
const uploads = () => {
  const calls = []
  const exec = (command, args) => command === "gh" ? "42\n" : calls.push([args[args.indexOf("--name") + 1], ...args.slice(args.indexOf("--repository") + 2)])
  return {calls, exec}
}

test("reuse takes the newest APK any PR published with these inputs that the sweep keeps", () => {
  const label = `mobile-v1:${fp}:${digest}`
  const assets = [apk(1, label, "2026-11-25T00:00:00Z"), apk(2, label, "2026-11-26T00:00:00Z"), apk(3, label, "2026-11-20T00:00:00Z"),
    apk(4, `mobile-v1:${"e".repeat(64)}:${digest}`, "2026-11-26T12:00:00Z"), {...apk(5, label, "2026-11-26T12:00:00Z"), name: "mentra-android-pr-5.apk"}]
  assert.deepEqual(reusableSdkTestsApk(assets, fp, now), {name: apk(2).name, sha256: digest, size: 9})
  assert.equal(reusableSdkTestsApk(assets, "0".repeat(64), now), undefined)
})

test("a reuse publishes only this head's receipt, naming the reused APK", async () => {
  const {calls, exec} = uploads()
  const reused = {name: apk(2).name, sha256: digest, size: 9}
  const receipt = await publishSdkTestsArtifacts(reused, env, {exec})
  assert.deepEqual(validateSdkTestsReceipt(receipt, coordinates), reused)
  assert.deepEqual(calls, [[`mentra-sdk-tests-android-pr-7-${"b".repeat(40)}-5-1.json`]])
})

test("a build publishes its APK labeled with its fingerprint, then the receipt", async () => {
  const file = path.join(await mkdtemp(path.join(tmpdir(), "sdk-tests-test-")), "tests.apk")
  await writeFile(file, "apk bytes")
  const {calls, exec} = uploads()
  const receipt = await publishSdkTestsArtifacts(file, env, {exec})
  const name = `mentra-sdk-tests-android-pr-7-${"b".repeat(40)}-5-1`
  assert.equal(validateSdkTestsReceipt(receipt, coordinates).name, `${name}.apk`)
  assert.deepEqual(calls, [[`${name}.apk`, "--fingerprint", fp], [`${name}.json`]])
})
