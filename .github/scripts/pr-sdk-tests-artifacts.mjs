import {createHash} from "node:crypto"
import {execFileSync} from "node:child_process"
import {appendFileSync} from "node:fs"
import {mkdtemp, readFile, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import path from "node:path"
import {fileURLToPath} from "node:url"
import {PR_BUILD_REPOSITORIES} from "./pr-android-artifacts.mjs"
import {UNCHANGED_MAX_AGE_DAYS} from "./pr-mobile-build-unchanged.mjs"
import {readArtifactIndex} from "./release-artifact-storage.mjs"

// The Bluetooth SDK's hardware tests (the Mentra monorepo's testing/routines/*/android): the instrumentation APK a
// lab run installs on its phone, published for a PR head beside its app builds in the pr-builds release, as
// `mentra-sdk-tests-android-pr-<n>-<head>-<run>-<attempt>.apk` with a receipt of the same name in `.json`, published
// last. The APK is labeled with its inputs' fingerprint (the monorepo's component-fingerprints.mjs, `sdk_tests`), as
// the app builds are: a head whose fingerprint matches an APK any PR published publishes only its receipt, naming that
// APK. The lab runner finds them as it finds a PR's app builds (testing/agent/latest-app.ts). Signed with the debug
// key: it only ever runs under `am instrument` on a lab phone.
export const SDK_TESTS_PREFIX = "mentra-sdk-tests"
const APK = new RegExp(`^${SDK_TESTS_PREFIX}-android-pr-\\d+-[a-f0-9]{40}-\\d+-\\d+\\.apk$`)
const SHA = /^[a-f0-9]{40}$/
const HASH = /^[a-f0-9]{64}$/
const positive = value => Number.isSafeInteger(value) && value > 0
const requireThat = (value, message) => { if (!value) throw new Error(message) }

export function sdkTestsReceiptName(pr, sha, runId, attempt) {
  requireThat(positive(pr) && SHA.test(sha ?? "") && positive(runId) && positive(attempt), "Invalid SDK tests publication coordinates")
  return `${SDK_TESTS_PREFIX}-android-pr-${pr}-${sha}-${runId}-${attempt}.json`
}

/** The receipt of exactly this PR head's run and attempt, with its APK's name (its own, or a reused one), hash and size. */
export function validateSdkTestsReceipt(receipt, {pr, sha, runId, attempt}) {
  sdkTestsReceiptName(pr, sha, runId, attempt)
  requireThat(receipt?.schemaVersion === 1 && receipt.pr === pr && receipt.headSha === sha && receipt.runId === runId &&
    receipt.runAttempt === attempt && SHA.test(receipt.buildSha ?? ""), "SDK tests receipt belongs to a different revision or workflow attempt")
  const asset = receipt.artifacts?.android
  requireThat(Object.keys(receipt.artifacts ?? {}).join() === "android" && APK.test(asset?.name ?? "") &&
    HASH.test(asset.sha256 ?? "") && positive(asset.size), "Invalid SDK tests artifact")
  return asset
}

/** The newest APK built from these inputs that the 7-day sweep keeps two more days, from any PR: its name, hash and size. */
export function reusableSdkTestsApk(assets, fingerprint, now = Date.now()) {
  const asset = assets
    .filter(({name, label, digest, created_at}) => APK.test(name) && label === `mobile-v1:${fingerprint}:${digest.slice("sha256:".length)}` &&
      Date.parse(created_at) > now - UNCHANGED_MAX_AGE_DAYS * 86400000)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0]
  return asset && {name: asset.name, sha256: asset.digest.slice("sha256:".length), size: asset.size}
}

/** Publish this head's receipt for `apk`: a path, which is published first under this head's name, or a reused APK's
 * {name, sha256, size}. */
export async function publishSdkTestsArtifacts(apk, env = process.env, {exec = execFileSync} = {}) {
  const pr = Number(env.PR_NUMBER), headSha = env.PR_HEAD_SHA, runId = Number(env.GITHUB_RUN_ID), runAttempt = Number(env.GITHUB_RUN_ATTEMPT)
  const repository = env.GITHUB_REPOSITORY, buildSha = env.GITHUB_SHA, fingerprint = env.SDK_TESTS_FINGERPRINT
  requireThat(PR_BUILD_REPOSITORIES.includes(repository), "Unsupported SDK tests publication repository")
  requireThat(HASH.test(fingerprint ?? ""), "Invalid SDK_TESTS_FINGERPRINT")
  const name = sdkTestsReceiptName(pr, headSha, runId, runAttempt)
  const files = []
  let android = apk
  if (typeof apk === "string") {
    const bytes = await readFile(apk)
    android = {name: name.replace(/\.json$/, ".apk"), sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length}
    files.push([apk, android.name, ["--fingerprint", fingerprint]])
  }
  const receipt = {schemaVersion: 1, pr, headSha, buildSha, runId, runAttempt, fingerprint, artifacts: {android}}
  validateSdkTestsReceipt(receipt, {pr, sha: headSha, runId, attempt: runAttempt})
  const file = path.join(await mkdtemp(path.join(tmpdir(), "sdk-tests-")), name)
  await writeFile(file, JSON.stringify(receipt, null, 2) + "\n")
  files.push([file, name, []])
  const releaseId = exec("gh", ["api", `repos/${repository}/releases/tags/pr-builds`, "--jq", ".id"], {encoding: "utf8"}).trim()
  for (const [source, target, extra] of files)
    exec(process.execPath, [fileURLToPath(new URL("./publish-immutable-release-asset.mjs", import.meta.url)),
      "--file", source, "--name", target, "--release-id", releaseId, "--repository", repository, ...extra], {stdio: "inherit", env})
  return receipt
}

/** Publish this head's receipt for an APK built from the same inputs, if one is published. Says whether it did. */
export async function reuseSdkTestsApk(env = process.env, {readIndex = readArtifactIndex, publish = publishSdkTestsArtifacts} = {}) {
  const {assets} = await readIndex(env.GITHUB_REPOSITORY, "pr-builds")
  const apk = reusableSdkTestsApk(assets, env.SDK_TESTS_FINGERPRINT)
  if (!apk) {
    console.log(`No published SDK tests APK has the fingerprint ${env.SDK_TESTS_FINGERPRINT}: building it.`)
    return false
  }
  await publish(apk, env)
  console.log(`Reused ${apk.name}: nothing compiled.`)
  return true
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "reuse") appendFileSync(process.env.GITHUB_OUTPUT, `reused=${await reuseSdkTestsApk()}\n`)
  else await publishSdkTestsArtifacts(path.resolve(process.argv[2]))
}
