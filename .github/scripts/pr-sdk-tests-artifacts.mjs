import {createHash} from "node:crypto"
import {execFileSync} from "node:child_process"
import {readFile, writeFile} from "node:fs/promises"
import path from "node:path"
import {fileURLToPath} from "node:url"
import {PR_BUILD_REPOSITORIES} from "./pr-android-artifacts.mjs"

// The Bluetooth SDK's hardware tests (the Mentra monorepo's testing/routines/*/android): the instrumentation APK a
// lab run installs on its phone, published for a PR head beside its app builds in the pr-builds release, as
// `mentra-sdk-tests-android-pr-<n>-<head>-<run>-<attempt>.apk` with a receipt of the same name in `.json`, published
// last. The lab runner finds them as it finds a PR's app builds (testing/agent/latest-app.ts). Signed with the debug
// key: it only ever runs under `am instrument` on a lab phone.
export const SDK_TESTS_PREFIX = "mentra-sdk-tests"
const SHA = /^[a-f0-9]{40}$/
const HASH = /^[a-f0-9]{64}$/
const positive = value => Number.isSafeInteger(value) && value > 0
const requireThat = (value, message) => { if (!value) throw new Error(message) }

export function sdkTestsReceiptName(pr, sha, runId, attempt) {
  requireThat(positive(pr) && SHA.test(sha ?? "") && positive(runId) && positive(attempt), "Invalid SDK tests publication coordinates")
  return `${SDK_TESTS_PREFIX}-android-pr-${pr}-${sha}-${runId}-${attempt}.json`
}

/** The receipt of exactly this PR head's run and attempt, with its APK's name, hash and size. */
export function validateSdkTestsReceipt(receipt, {pr, sha, runId, attempt}) {
  const name = sdkTestsReceiptName(pr, sha, runId, attempt)
  requireThat(receipt?.schemaVersion === 1 && receipt.pr === pr && receipt.headSha === sha && receipt.runId === runId &&
    receipt.runAttempt === attempt && SHA.test(receipt.buildSha ?? ""), "SDK tests receipt belongs to a different revision or workflow attempt")
  const asset = receipt.artifacts?.android
  requireThat(Object.keys(receipt.artifacts ?? {}).join() === "android" && asset?.name === name.replace(/\.json$/, ".apk") &&
    HASH.test(asset.sha256 ?? "") && positive(asset.size), "Invalid SDK tests artifact")
  return asset
}

/** Publish the APK, then its receipt, which says it's whole. */
export async function publishSdkTestsArtifacts(apk, env = process.env, {exec = execFileSync} = {}) {
  const pr = Number(env.PR_NUMBER), headSha = env.PR_HEAD_SHA, runId = Number(env.GITHUB_RUN_ID), runAttempt = Number(env.GITHUB_RUN_ATTEMPT)
  const repository = env.GITHUB_REPOSITORY, buildSha = env.GITHUB_SHA
  requireThat(PR_BUILD_REPOSITORIES.includes(repository), "Unsupported SDK tests publication repository")
  const name = sdkTestsReceiptName(pr, headSha, runId, runAttempt)
  const bytes = await readFile(apk)
  const receipt = {schemaVersion: 1, pr, headSha, buildSha, runId, runAttempt,
    artifacts: {android: {name: name.replace(/\.json$/, ".apk"), sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length}}}
  validateSdkTestsReceipt(receipt, {pr, sha: headSha, runId, attempt: runAttempt})
  const file = path.join(path.dirname(apk), name)
  await writeFile(file, JSON.stringify(receipt, null, 2) + "\n")
  const releaseId = exec("gh", ["api", `repos/${repository}/releases/tags/pr-builds`, "--jq", ".id"], {encoding: "utf8"}).trim()
  for (const [source, target] of [[apk, receipt.artifacts.android.name], [file, name]])
    exec(process.execPath, [fileURLToPath(new URL("./publish-immutable-release-asset.mjs", import.meta.url)),
      "--file", source, "--name", target, "--release-id", releaseId, "--repository", repository], {stdio: "inherit", env})
  return receipt
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await publishSdkTestsArtifacts(path.resolve(process.argv[2]))
