import {execFileSync} from "node:child_process"
import {randomUUID} from "node:crypto"
import {readFileSync} from "node:fs"
import {mkdtemp, rm, writeFile} from "node:fs/promises"
import {tmpdir} from "node:os"
import path from "node:path"
import {setTimeout as sleep} from "node:timers/promises"
import {fileURLToPath} from "node:url"
import {isDeepStrictEqual} from "node:util"
import {NO_BUILD_RUN_NAME} from "./notify-pr-builds.mjs"
import {androidReceiptName, validateAndroidReceipt} from "./pr-android-artifacts.mjs"
import {iosReceiptName, validateIosReceipt} from "./pr-ios-artifacts.mjs"
import {packagingFingerprint, prApp} from "./pr-mobile-build.mjs"
import {artifactUrl, readArtifactIndex} from "./release-artifact-storage.mjs"

// A push that changes neither the app nor the glasses software it pins
// publishes only a receipt for this head that names an earlier push's
// publication, with `reusedFrom`, instead of packaging and uploading the
// same app again.

// The 7-day sweep (release-assets.mjs sweep --days 7) removes the files: reuse
// only those it keeps for two more days.
export const UNCHANGED_MAX_AGE_DAYS = 5

// `app` is a key of PR_APPS (pr-mobile-build.mjs).
const PLATFORMS = {
  android: {
    receiptName: (pr, sha, runId, attempt, app) => androidReceiptName(pr, sha, runId, attempt, false, app),
    validate: (receipt, coordinates, repository, app) => validateAndroidReceipt(receipt, {...coordinates, repository, app}),
  },
  ios: {
    receiptName: iosReceiptName,
    validate: (receipt, coordinates, repository, app) => validateIosReceipt(receipt, {...coordinates, app}),
  },
}

function receiptCoordinates(platform, pr, name, app) {
  const prefix = `${prApp(app).prefix}-${platform}`
  const match = new RegExp(`^${prefix}-pr-${pr}-([a-f0-9]{40})-(\\d+)-(\\d+)\\.json$`).exec(name)
  return match ? {pr, sha: match[1], runId: Number(match[2]), attempt: Number(match[3])} : null
}

async function readJson(fetchImpl, url) {
  const response = await fetchImpl(`${url}?read=${randomUUID()}`, {
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
  })
  if (!response.ok) throw new Error(`Reading ${url} failed with HTTP ${response.status}`)
  return response.json()
}

/** What an OTA manifest installs, without its release version, names and URLs, which differ per head. */
export function otaContent(manifest) {
  const content = {
    asgSource: manifest?.asgSource?.fingerprint,
    asg: manifest?.apps?.["com.mentra.asg_client"]?.sha256,
    bes: manifest?.bes_firmware?.sha256,
    mtkFullOta: manifest?.mtk_full_ota,
    mtkPatches: manifest?.mtk_patches,
  }
  if (
    !content.asgSource ||
    !/^[a-f0-9]{64}$/.test(content.asg ?? "") ||
    !/^[a-f0-9]{64}$/.test(content.bes ?? "") ||
    !content.mtkFullOta ||
    !Array.isArray(content.mtkPatches)
  )
    throw new Error("OTA manifest is missing its ASG, BES or MTK content")
  return content
}

/** This head's OTA manifest, once mentra-asg-client-build.yml publishes it; undefined if it never does. */
export async function waitForOtaManifest({github, context, env, fetchImpl = fetch, wait = sleep, now = Date.now}) {
  const asgStatus = async () => {
    try {
      const {data} = await github.rest.actions.listWorkflowRuns({
        ...context.repo,
        workflow_id: "mentra-asg-client-build.yml",
        head_sha: env.PR_HEAD_SHA,
        event: "pull_request",
        per_page: 20,
      })
      return data.workflow_runs.find((run) => run.display_title !== NO_BUILD_RUN_NAME)?.status ?? ""
    } catch {
      return ""
    }
  }
  // A cached ASG run takes about a minute.
  const deadline = now() + 600_000
  while (now() < deadline) {
    // The status first: a completed run has published all it will.
    const status = await asgStatus()
    const response = await fetchImpl(`${env.PR_OTA_MANIFEST_URL}?read=${randomUUID()}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    })
    if (response.ok) return response.json()
    if (status === "completed") return undefined
    await wait(15_000)
  }
  return undefined
}

// The ad hoc profile this job signs with (artifacts.py configure): a refreshed
// profile, such as one with a newly registered device, needs a new package.
const currentIosProfile = () =>
  JSON.parse(readFileSync(new URL("../../mobile/build/pr-ios/signing.json", import.meta.url), "utf8")).profile

async function earlierPublication(options) {
  const {github, context, core, platform, env, fetchImpl, readIndex, wait, now, packaging, iosProfile} = options
  const pr = Number(env.PR_NUMBER)
  const app = env.MENTRA_PR_APP || "mentra"
  const profile = platform === "ios" ? iosProfile() : undefined
  if (platform === "ios" && !profile) throw new Error("This job's iOS provisioning profile is unknown")
  const repository = `${context.repo.owner}/${context.repo.repo}`
  const {assets} = await readIndex(repository, "pr-builds")
  const published = new Map(assets.map((asset) => [asset.name, asset]))
  const fresh = (asset) => Date.parse(asset?.created_at) > now() - UNCHANGED_MAX_AGE_DAYS * 86400000
  const receipts = assets
    .flatMap((asset) => {
      const coordinates = receiptCoordinates(platform, pr, asset.name, app)
      return coordinates && coordinates.sha !== env.PR_HEAD_SHA && fresh(asset) ? [{asset, coordinates}] : []
    })
    .sort((a, b) => Date.parse(b.asset.created_at) - Date.parse(a.asset.created_at))
  let found
  for (const {asset, coordinates} of receipts) {
    const receipt = await readJson(fetchImpl, artifactUrl(repository, "pr-builds", asset.name))
    // A receipt that reuses another is skipped: the original is published too.
    if (
      receipt.reusedFrom !== undefined ||
      receipt.app?.mobileFingerprint !== env.MENTRA_PR_MOBILE_FINGERPRINT ||
      receipt.app?.backend !== env.EXPO_PUBLIC_BUILD_ENV ||
      // Receipts from before the packaging fingerprint are never reused.
      receipt.packagingFingerprint !== packaging ||
      receipt.app?.profileUUID !== profile ||
      // An Android APK at or below a code reserved since it was built would not
      // install over that beta (prepare-pr-mobile.mjs).
      (platform === "android" &&
        env.MENTRA_ANDROID_RESERVED_CODE_FLOOR !== undefined &&
        !(Number(receipt.app?.build) > Number(env.MENTRA_ANDROID_RESERVED_CODE_FLOOR)))
    )
      continue
    try {
      PLATFORMS[platform].validate(receipt, coordinates, repository, app)
    } catch (error) {
      core.info(`Skipping ${asset.name}: ${error.message}`)
      continue
    }
    const files = Object.values(receipt.artifacts)
    if (files.every((file) => published.get(file.name)?.size === file.size && fresh(published.get(file.name)))) {
      found = {name: asset.name, receipt}
      break
    }
  }
  if (!found) {
    core.info("No earlier push of this PR published this app recently enough to reuse.")
    return undefined
  }
  const manifest = await waitForOtaManifest({github, context, env, fetchImpl, wait, now})
  if (!manifest) {
    core.info("This head's OTA manifest is not published: no reuse.")
    return undefined
  }
  if (manifest.releaseVersion !== `pr-${pr}-${env.PR_HEAD_SHA}`)
    throw new Error("This head's OTA manifest belongs to another revision")
  const earlier = await readJson(fetchImpl, found.receipt.app.otaManifestUrl)
  if (!isDeepStrictEqual(otaContent(manifest), otaContent(earlier))) {
    core.info(`The glasses software changed since ${found.receipt.headSha.slice(0, 10)}: no reuse.`)
    return undefined
  }
  return found.name
}

/**
 * Finds the receipt of an earlier push of this PR whose publication this head
 * can reuse: the same compiled app (its fingerprint and backend), packaging
 * and, on iOS, provisioning profile, files the sweep keeps, and the same
 * glasses software in both heads' OTA manifests.
 * Sets the `unchanged` and `receipt` outputs. Anything missing, different or
 * unreadable means no reuse.
 */
export async function findUnchangedBuild({
  github,
  context,
  core,
  platform = "android",
  env = process.env,
  fetchImpl = fetch,
  readIndex = readArtifactIndex,
  wait = sleep,
  now = Date.now,
  packaging = () => packagingFingerprint(platform),
  iosProfile = currentIosProfile,
}) {
  let name
  try {
    const current = {packaging: packaging(), iosProfile}
    name = await earlierPublication({github, context, core, platform, env, fetchImpl, readIndex, wait, now, ...current})
  } catch (error) {
    core.warning(`Cannot reuse an earlier push's publication: ${error.message}`)
  }
  core.setOutput("unchanged", String(Boolean(name)))
  if (name) {
    core.setOutput("receipt", name)
    core.info(`Nothing changed since ${name}: publishing only this head's receipt for it.`)
  }
  return name
}

/** This head's receipt for the earlier one `original`: the same app and files, and where they come from. */
export function unchangedReceipt(original, {headSha, runId, runAttempt}) {
  const {buildAttempt, ...receipt} = original
  return {
    ...receipt,
    headSha,
    runId,
    runAttempt,
    reusedFrom: {
      headSha: original.headSha,
      runId: original.runId,
      runAttempt: original.runAttempt,
      ...(buildAttempt === undefined ? {} : {buildAttempt}),
    },
  }
}

/** Publish this head's receipt for the earlier publication `name` that findUnchangedBuild found. */
export async function publishUnchangedReceipt(
  platform,
  name,
  env = process.env,
  {exec = execFileSync, fetchImpl = fetch} = {},
) {
  const {receiptName, validate} = PLATFORMS[platform]
  const repository = env.GITHUB_REPOSITORY
  const pr = Number(env.PR_NUMBER)
  const app = env.MENTRA_PR_APP || "mentra"
  const source = receiptCoordinates(platform, pr, name, app)
  if (!source || source.sha === env.PR_HEAD_SHA) throw new Error(`${name} is not an earlier publication of this PR`)
  const original = await readJson(fetchImpl, artifactUrl(repository, "pr-builds", name))
  if (original.reusedFrom !== undefined) throw new Error(`${name} already reuses another publication`)
  validate(original, source, repository, app)
  const coordinates = {
    pr,
    sha: env.PR_HEAD_SHA,
    runId: Number(env.GITHUB_RUN_ID),
    attempt: Number(env.GITHUB_RUN_ATTEMPT),
  }
  const receipt = unchangedReceipt(original, {
    headSha: coordinates.sha,
    runId: coordinates.runId,
    runAttempt: coordinates.attempt,
  })
  validate(receipt, coordinates, repository, app)
  const target = receiptName(pr, coordinates.sha, coordinates.runId, coordinates.attempt, app)
  const directory = await mkdtemp(path.join(tmpdir(), "pr-mobile-unchanged-"))
  try {
    const file = path.join(directory, target)
    await writeFile(file, JSON.stringify(receipt, null, 2) + "\n")
    const releaseId = exec("gh", ["api", `repos/${repository}/releases/tags/pr-builds`, "--jq", ".id"], {
      encoding: "utf8",
    }).trim()
    exec(
      process.execPath,
      [
        fileURLToPath(new URL("./publish-immutable-release-asset.mjs", import.meta.url)),
        "--file",
        file,
        "--name",
        target,
        "--release-id",
        releaseId,
        "--repository",
        repository,
      ],
      {stdio: "inherit", env},
    )
  } finally {
    await rm(directory, {recursive: true, force: true})
  }
  console.log(artifactUrl(repository, "pr-builds", target))
  return receipt
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [platform, name] = process.argv.slice(2)
  if (!["android", "ios"].includes(platform) || !name)
    throw new Error("Expected android or ios, and the earlier receipt's name")
  await publishUnchangedReceipt(platform, name)
}
