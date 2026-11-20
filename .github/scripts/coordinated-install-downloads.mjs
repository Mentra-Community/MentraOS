import {createHash} from "node:crypto"
import {execFileSync} from "node:child_process"
import {appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"
import {artifactUrl, downloadAsset, listReleaseAssets, resolveRelease} from "./release-artifact-storage.mjs"
import {exampleArtifactName} from "./bluetooth-example-artifacts.mjs"
import {iosInstallationFiles} from "./pr-ios-artifacts-install.mjs"
import {PR_APPS} from "./pr-mobile-build.mjs"
import {appIdOf} from "./release-family.mjs"

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"))

// The backend each channel's app talks to (mobile/ci/coordinated-downloads.py).
const BACKENDS = {dev: "dev", beta: "staging", production: "prod"}

// Each function takes the app (PR_APPS's key, MENTRA_PR_APP from the command
// line): the Mentra App, or the Bluetooth example app from its own App Store
// IPA, named as the release's other example files are.
export function downloadNames(plan, app = "mentra") {
  const prerelease = plan.channel === "production" ? "" : `-${plan.channel}\\.[1-9][0-9]*`
  if (!Object.hasOwn(BACKENDS, plan.channel) || !new RegExp(`^[0-9]+\\.[0-9]+\\.[0-9]+${prerelease}$`).test(plan.releaseIdentity))
    throw new Error("Installable downloads require a dev, beta or production release identity")
  const prefix =
    app === "mentra" ? `mentraos-${plan.releaseIdentity}` : exampleArtifactName("reactNative", plan.releaseIdentity).replace(/\.apk$/, "")
  return {
    iphone: `${prefix}-iphone.ipa`,
    mac: `${prefix}-mac.zip`,
    manifest: `${prefix}-install.plist`,
    install: `${prefix}-install.html`,
    receipt: `${prefix}-apple-downloads.json`,
  }
}

export function validateDownloads(receipt, plan, otaUrl, {complete = true, app = "mentra"} = {}) {
  const names = downloadNames(plan, app)
  const receiptApp = receipt.app
  if (
    receipt.schemaVersion !== 1 ||
    receipt.releaseIdentity !== plan.releaseIdentity ||
    receipt.sourceCommit !== plan.sourceCommit ||
    !/^[a-f0-9]{40}$/.test(plan.sourceCommit) ||
    receiptApp?.bundleId !== (app === "mentra" ? appIdOf(plan) : PR_APPS[app].packageId) ||
    receiptApp.build !== String(plan.native.buildNumber) ||
    receiptApp.version !== plan.native.marketingVersion ||
    receiptApp.headSha !== plan.sourceCommit ||
    !Object.hasOwn(BACKENDS, plan.channel) ||
    receiptApp.backend !== BACKENDS[plan.channel] ||
    receiptApp.otaManifestUrl !== otaUrl ||
    !otaUrl ||
    !/^[a-f0-9]{64}$/.test(receiptApp.executableSha256) ||
    !/^[a-f0-9]{64}$/.test(receiptApp.javascriptSha256)
  )
    throw new Error("Apple downloads do not match the coordinated release and OTA target")
  const kinds = complete ? ["iphone", "mac", "manifest", "install"] : ["iphone", "mac"]
  if (
    Object.keys(receipt.artifacts || {})
      .sort()
      .join() !== kinds.sort().join()
  )
    throw new Error("Incomplete Apple download set")
  for (const kind of kinds) {
    const asset = receipt.artifacts[kind]
    if (
      asset?.name !== names[kind] ||
      !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      !Number.isSafeInteger(asset.size) ||
      asset.size <= 0
    )
      throw new Error(`Invalid Apple ${kind} artifact`)
  }
  return receipt
}

export function verifyFiles(directory, receipt) {
  for (const asset of Object.values(receipt.artifacts)) {
    const file = path.join(directory, asset.name)
    if (statSync(file).size !== asset.size || hash(readFileSync(file)) !== asset.sha256)
      throw new Error(`Download bytes disagree with receipt: ${asset.name}`)
  }
}

export function prepareDownloads(directory, plan, repository, otaUrl, app = "mentra") {
  const names = downloadNames(plan, app)
  const file = path.join(directory, names.receipt)
  const receipt = readJson(file)
  if (!receipt.artifacts.manifest) {
    validateDownloads(receipt, plan, otaUrl, {complete: false, app})
    verifyFiles(directory, receipt)
    const context = {
      tag: plan.artifactContainerTag,
      identity: plan.releaseIdentity,
      backend: receipt.app.backend,
      manifestName: names.manifest,
      pageName: names.install,
      url: `https://github.com/${repository}/commit/${plan.sourceCommit}`,
    }
    for (const [kind, asset] of Object.entries(
      iosInstallationFiles({...receipt, headSha: plan.sourceCommit}, repository, context, app),
    )) {
      writeFileSync(path.join(directory, asset.name), asset.content)
      receipt.artifacts[kind] = {name: asset.name, size: Buffer.byteLength(asset.content), sha256: hash(asset.content)}
    }
    writeFileSync(file, JSON.stringify(receipt, null, 2) + "\n")
  }
  validateDownloads(receipt, plan, otaUrl, {app})
  verifyFiles(directory, receipt)
  return receipt
}

export async function restoreDownloads(
  directory,
  plan,
  repository,
  otaUrl,
  {releaseId, app = "mentra", resolve = resolveRelease, list = listReleaseAssets, download = downloadAsset} = {},
) {
  // By ID when the caller has it: production's container is a draft until the
  // release completes, and a draft has no tag to look it up by.
  const release = resolve(repository, releaseId ? {releaseId} : {tag: plan.artifactContainerTag})
  const assets = await list(repository, release)
  const names = downloadNames(plan, app)
  const matches = assets.filter((asset) => asset.name === names.receipt)
  if (matches.length > 1) throw new Error("Duplicate Apple download receipts")
  if (!matches.length) return false
  mkdirSync(directory, {recursive: true})
  const receiptFile = path.join(directory, names.receipt)
  await download(repository, matches[0], receiptFile)
  const receipt = validateDownloads(readJson(receiptFile), plan, otaUrl, {app})
  for (const asset of Object.values(receipt.artifacts)) {
    const found = assets.filter((entry) => entry.name === asset.name)
    if (found.length !== 1) throw new Error(`Published receipt has missing or duplicate ${asset.name}`)
    await download(repository, found[0], path.join(directory, asset.name))
  }
  verifyFiles(directory, receipt)
  return true
}

export function publishDownloads(directory, plan, repository, otaUrl, releaseId, {app = "mentra", exec = execFileSync} = {}) {
  const receipt = prepareDownloads(directory, plan, repository, otaUrl, app)
  // Publication retries reuse the original signed handoff. Never replace bytes
  // under a release URL; commit the receipt only after every download verifies.
  for (const name of [...Object.values(receipt.artifacts).map((asset) => asset.name), downloadNames(plan, app).receipt]) {
    exec(
      process.execPath,
      [
        fileURLToPath(new URL("./publish-immutable-release-asset.mjs", import.meta.url)),
        "--file",
        path.join(directory, name),
        "--name",
        name,
        "--release-id",
        releaseId,
        "--repository",
        repository,
      ],
      {stdio: "inherit"},
    )
  }
  return downloadLinks(plan, repository, app)
}

export function downloadLinks(plan, repository, app = "mentra") {
  const names = downloadNames(plan, app)
  return Object.fromEntries(
    ["manifest", "install", "mac"].map((kind) => [
      `${kind}_url`,
      artifactUrl(repository, plan.artifactContainerTag, names[kind]),
    ]),
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, planFile, directory] = process.argv.slice(2)
  const plan = readJson(planFile),
    repository = process.env.GITHUB_REPOSITORY,
    otaUrl = process.env.COORDINATED_OTA_URL,
    app = process.env.MENTRA_PR_APP || "mentra"
  if (command === "restore") {
    const restored = await restoreDownloads(directory, plan, repository, otaUrl, {releaseId: process.env.RELEASE_ID || undefined, app})
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `restored=${restored}\n`)
  } else if (command === "prepare") prepareDownloads(directory, plan, repository, otaUrl, app)
  else if (command === "publish") {
    const links = publishDownloads(directory, plan, repository, otaUrl, process.env.RELEASE_ID, {app})
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        Object.entries(links)
          .map(([key, value]) => `${key}=${value}\n`)
          .join(""),
      )
  } else throw new Error(`Unknown downloads command ${command}`)
}
