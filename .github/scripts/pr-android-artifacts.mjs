import {createHash} from "node:crypto"
import {execFileSync} from "node:child_process"
import {readFile, readdir, writeFile} from "node:fs/promises"
import path from "node:path"
import {fileURLToPath} from "node:url"
import {artifactUrl} from "./release-artifact-storage.mjs"

export const ANDROID_WORKFLOW = "mentra-app-android-build.yml"
export const ANDROID_PUBLICATION_STEP = "Upload APK to the public artifact CDN"
const SHA = /^[a-f0-9]{40}$/
const HASH = /^[a-f0-9]{64}$/
const positive = value => Number.isSafeInteger(value) && value > 0
const requireThat = (value, message) => { if (!value) throw new Error(message) }

export function androidReceiptName(pr, sha, runId, attempt) {
  requireThat(positive(pr) && SHA.test(sha ?? "") && positive(runId) && positive(attempt),
    "Invalid Android publication coordinates")
  return `mentra-android-pr-${pr}-${sha}-${runId}-${attempt}.json`
}

export function validateAndroidReceipt(receipt, {pr, sha, runId, attempt}) {
  const name = androidReceiptName(pr, sha, runId, attempt)
  requireThat(receipt?.schemaVersion === 1 && receipt.pr === pr && receipt.headSha === sha &&
    receipt.runId === runId && receipt.runAttempt === attempt && SHA.test(receipt.baseSha ?? "") &&
    SHA.test(receipt.buildSha ?? ""), "Android receipt belongs to a different revision or workflow attempt")
  const app = receipt.app
  const ota = artifactUrl("Mentra-Community/MentraOS", "pr-builds", `ota-pr-${pr}-${sha}.json`)
  requireThat(app?.packageId === "com.mentra.mentra" && app.headSha === sha && app.buildSha === receipt.buildSha &&
    app.backend === "dev" && app.otaManifestUrl === ota && typeof app.version === "string" && !!app.version &&
    typeof app.build === "string" && /^[1-9]\d*$/.test(app.build) && Number(app.build) <= 2100000000 &&
    (app.mobileFingerprint === undefined || HASH.test(app.mobileFingerprint)) &&
    (app.mobileSourceCommit === undefined || SHA.test(app.mobileSourceCommit)), "Invalid Android app identity or OTA pin")
  const asset = receipt.artifacts?.android
  requireThat(Object.keys(receipt.artifacts ?? {}).join() === "android" &&
    asset?.name === name.replace(/\.json$/, ".apk") && HASH.test(asset.sha256 ?? "") && positive(asset.size),
    "Invalid Android artifact")
  return receipt.artifacts
}

/** Read the packaged configuration and the binary manifest, not source defaults. */
export function androidAppIdentity({config, badging, pr, headSha, buildSha, backend}) {
  const native = /^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/m.exec(badging)
  const build = config?.extra?.mentraPrBuild
  requireThat(native?.[1] === "com.mentra.mentra" && config.android?.package === native[1] &&
    config.version === native[3] && String(config.android?.versionCode) === native[2] &&
    build?.schemaVersion === 1 && build.prHeadSha === headSha && String(build.buildNumber) === native[2] &&
    HASH.test(build.mobileFingerprint ?? "") && SHA.test(build.mobileSourceCommit ?? "") &&
    build.otaManifestUrl === artifactUrl("Mentra-Community/MentraOS", "pr-builds", `ota-pr-${pr}-${headSha}.json`) &&
    backend === "dev", "Packaged Android identity differs from its native manifest or PR inputs")
  return {packageId: native[1], version: native[3], build: native[2], headSha, buildSha, backend,
    otaManifestUrl: build.otaManifestUrl, mobileFingerprint: build.mobileFingerprint,
    mobileSourceCommit: build.mobileSourceCommit}
}

/** Commit an immutable receipt only after its exact signed APK is published. */
export async function publishAndroidArtifacts(apk, env = process.env, {exec = execFileSync} = {}) {
  const pr = Number(env.PR_NUMBER), headSha = env.PR_HEAD_SHA, runId = Number(env.GITHUB_RUN_ID),
    runAttempt = Number(env.GITHUB_RUN_ATTEMPT), buildSha = env.GITHUB_SHA
  const name = androidReceiptName(pr, headSha, runId, runAttempt)
  requireThat(env.GITHUB_REPOSITORY === "Mentra-Community/MentraOS" && SHA.test(buildSha ?? ""),
    "Invalid Android publication source")
  const commit = exec("git", ["cat-file", "-p", buildSha], {encoding: "utf8"})
  const parents = [...commit.split("\n\n", 1)[0].matchAll(/^parent ([a-f0-9]{40})$/gm)].map(match => match[1])
  requireThat(parents.length === 2 && SHA.test(parents[0]) && parents[1] === headSha,
    "Android package is not the declared PR merge")
  const baseSha = parents[0]
  const config = JSON.parse(exec("unzip", ["-p", apk, "assets/app.config"], {encoding: "utf8", maxBuffer: 1024 * 1024}))
  const versions = (await readdir(path.join(env.ANDROID_HOME, "build-tools"))).sort((a, b) => b.localeCompare(a, undefined, {numeric: true}))
  requireThat(versions.length > 0, "Android build tools are unavailable")
  const badging = exec(path.join(env.ANDROID_HOME, "build-tools", versions[0], "aapt"), ["dump", "badging", apk], {encoding: "utf8"})
  const app = androidAppIdentity({config, badging, pr, headSha, buildSha, backend: env.EXPO_PUBLIC_BUILD_ENV})
  requireThat(app.mobileFingerprint === env.MENTRA_PR_MOBILE_FINGERPRINT, "APK compilation fingerprint differs from the selected build")
  const bytes = await readFile(apk)
  const receipt = {schemaVersion: 1, pr, headSha, baseSha, buildSha, runId, runAttempt, app,
    artifacts: {android: {name: name.replace(/\.json$/, ".apk"), sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length}}}
  validateAndroidReceipt(receipt, {pr, sha: headSha, runId, attempt: runAttempt})
  const file = path.join(path.dirname(apk), name)
  await writeFile(file, JSON.stringify(receipt, null, 2) + "\n")
  const releaseId = exec("gh", ["api", `repos/${env.GITHUB_REPOSITORY}/releases/tags/pr-builds`, "--jq", ".id"], {encoding: "utf8"}).trim()
  for (const [source, target] of [[apk, receipt.artifacts.android.name], [file, name]])
    exec(process.execPath, [fileURLToPath(new URL("./publish-immutable-release-asset.mjs", import.meta.url)),
      "--file", source, "--name", target, "--release-id", releaseId, "--repository", env.GITHUB_REPOSITORY], {stdio: "inherit", env})
  return receipt
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await publishAndroidArtifacts(path.resolve(process.argv[2]))
