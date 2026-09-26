import assert from "node:assert/strict"
import test from "node:test"
import {mkdtemp, mkdir, readFile, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import path from "node:path"
import {androidAppIdentity, androidReceiptName, publishAndroidArtifacts, validateAndroidReceipt} from "./pr-android-artifacts.mjs"
import {artifactUrl} from "./release-artifact-storage.mjs"

const head = "a".repeat(40), base = "b".repeat(40), merge = "c".repeat(40), fingerprint = "d".repeat(64)
const ota = artifactUrl("Mentra-Community/MentraOS", "pr-builds", `ota-pr-42-${head}.json`)
const config = () => ({version: "3.3.0", android: {package: "com.mentra.mentra", versionCode: 303000123},
  extra: {unrelated: "must not appear in receipt", mentraPrBuild: {schemaVersion: 1, mobileFingerprint: fingerprint,
    mobileSourceCommit: "e".repeat(40), prHeadSha: head, buildNumber: 303000123, otaManifestUrl: ota}}})
const badging = "package: name='com.mentra.mentra' versionCode='303000123' versionName='3.3.0' platformBuildVersionName='11'"
const identity = {pr: 42, headSha: head, buildSha: merge, backend: "dev"}

test("the receipt reflects native APK metadata and preserves reused compilation identity separately", () => {
  const app = androidAppIdentity({...identity, config: config(), badging})
  assert.deepEqual(app, {packageId: "com.mentra.mentra", version: "3.3.0", build: "303000123", headSha: head,
    buildSha: merge, backend: "dev", otaManifestUrl: ota, mobileFingerprint: fingerprint, mobileSourceCommit: "e".repeat(40)})
  for (const change of [c => c.android.versionCode++, c => c.version = "3.2.0", c => c.android.package += ".other",
    c => c.extra.mentraPrBuild.prHeadSha = base, c => c.extra.mentraPrBuild.otaManifestUrl += "other"])
    { const value = config(); change(value); assert.throws(() => androidAppIdentity({...identity, config: value, badging})) }
  assert.throws(() => androidAppIdentity({...identity, backend: "prod", config: config(), badging}))
})

test("staging-targeted PRs package staging and never relabel another backend", () => {
  const staging = androidAppIdentity({...identity, backend: "staging", baseRef: "staging", config: config(), badging})
  assert.equal(staging.backend, "staging")
  for (const [backend, baseRef] of [["dev", "staging"], ["staging", "dev"], ["staging", "main"], ["staging", undefined], ["prod", "staging"]])
    assert.throws(() => androidAppIdentity({...identity, backend, baseRef, config: config(), badging}), /PR inputs/)
})

async function publishing(run, failApk = false) {
  const dir = await mkdtemp(path.join(tmpdir(), "android-receipt-"))
  try {
    await mkdir(path.join(dir, "build-tools", "35.0.0"), {recursive: true})
    const apk = path.join(dir, "app-release.apk"); await writeFile(apk, "synthetic APK bytes")
    const calls = [], env = {GITHUB_REPOSITORY: "Mentra-Community/MentraOS", PR_NUMBER: "42", PR_HEAD_SHA: head,
      GITHUB_SHA: merge, GITHUB_RUN_ID: "100", GITHUB_RUN_ATTEMPT: "2", ANDROID_HOME: dir, EXPO_PUBLIC_BUILD_ENV: "dev", MENTRA_PR_MOBILE_FINGERPRINT: fingerprint}
    const exec = (command, args) => {
      if (command === "git") return `tree ${head}\nparent ${base}\nparent ${head}\n\nMerge PR`
      if (command === "unzip") return JSON.stringify(config())
      if (command.endsWith("/aapt")) return badging
      if (command === "gh") return "10\n"
      assert.equal(command, process.execPath)
      const name = args[args.indexOf("--name") + 1]
      assert.equal(args.includes("--replace"), false)
      calls.push(name)
      if (failApk && name.endsWith(".apk")) throw new Error("APK upload failed")
      return ""
    }
    await run({apk, env, exec, calls, dir})
  } finally { await rm(dir, {recursive: true, force: true}) }
}

test("immutable signed APK publication precedes the per-attempt receipt, with no config leakage", async () => {
  await publishing(async ({apk, env, exec, calls, dir}) => {
    const receipt = await publishAndroidArtifacts(apk, env, {exec})
    const name = androidReceiptName(42, head, 100, 2)
    assert.deepEqual(calls, [name.replace(/\.json$/, ".apk"), name])
    assert.equal(receipt.baseSha, base)
    assert.equal(receipt.artifacts.android.size, 19)
    const raw = await readFile(path.join(dir, name), "utf8")
    assert.equal(raw.includes("unrelated"), false)
    for (const mutate of [r => r.runAttempt++, r => r.baseSha = "bad", r => r.app.otaManifestUrl += "other",
      r => r.artifacts.android.name = "mobile-pr-42-aaaaaaa.apk", r => r.artifacts.android.size = 0]) {
      const value = structuredClone(receipt); mutate(value)
      assert.throws(() => validateAndroidReceipt(value, {pr: 42, sha: head, runId: 100, attempt: 2}))
    }
  })
})

test("a staging receipt records its staging backend, and a mismatched build publishes nothing", async () => {
  await publishing(async ({apk, env, exec, calls}) => {
    const staging = {...env, GITHUB_BASE_REF: "staging", EXPO_PUBLIC_BUILD_ENV: "staging"}
    const receipt = await publishAndroidArtifacts(apk, staging, {exec})
    assert.equal(receipt.app.backend, "staging")
    assert.equal(validateAndroidReceipt(receipt, {pr: 42, sha: head, runId: 100, attempt: 2}), receipt.artifacts)
    for (const backend of ["prod", "", undefined]) {
      const value = structuredClone(receipt); value.app.backend = backend
      assert.throws(() => validateAndroidReceipt(value, {pr: 42, sha: head, runId: 100, attempt: 2}), /app identity/)
    }
    calls.length = 0
    await assert.rejects(publishAndroidArtifacts(apk, {...staging, EXPO_PUBLIC_BUILD_ENV: "dev"}, {exec}), /PR inputs/)
    await assert.rejects(publishAndroidArtifacts(apk, {...env, EXPO_PUBLIC_BUILD_ENV: "staging"}, {exec}), /PR inputs/)
    assert.deepEqual(calls, [])
  })
})

test("a failed APK publication never publishes a receipt", async () => {
  await publishing(async ({apk, env, exec, calls}) => {
    await assert.rejects(publishAndroidArtifacts(apk, env, {exec}), /APK upload failed/)
    assert.equal(calls.length, 1); assert.ok(calls[0].endsWith(".apk"))
  }, true)
})
