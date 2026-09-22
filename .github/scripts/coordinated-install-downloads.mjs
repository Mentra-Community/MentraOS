import {createHash} from "node:crypto"
import {execFileSync} from "node:child_process"
import {appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"
import {artifactUrl, downloadAsset, listReleaseAssets, resolveRelease} from "./release-artifact-storage.mjs"
import {iosInstallationFiles} from "./pr-ios-artifacts-install.mjs"

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"))

export function downloadNames(plan) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+-(dev|beta)\.[1-9][0-9]*$/.test(plan.releaseIdentity))
    throw new Error("Installable downloads require a dev or beta release identity")
  const prefix = `mentraos-${plan.releaseIdentity}`
  return {
    iphone: `${prefix}-iphone.ipa`,
    mac: `${prefix}-mac.zip`,
    manifest: `${prefix}-install.plist`,
    install: `${prefix}-install.html`,
    receipt: `${prefix}-apple-downloads.json`,
  }
}

export function validateDownloads(receipt, plan, otaUrl, {complete = true} = {}) {
  const names = downloadNames(plan)
  const app = receipt.app
  if (
    receipt.schemaVersion !== 1 ||
    receipt.releaseIdentity !== plan.releaseIdentity ||
    receipt.sourceCommit !== plan.sourceCommit ||
    !/^[a-f0-9]{40}$/.test(plan.sourceCommit) ||
    app?.bundleId !== "com.mentra.mentra" ||
    app.build !== String(plan.native.buildNumber) ||
    app.version !== plan.native.marketingVersion ||
    app.headSha !== plan.sourceCommit ||
    app.backend !== (plan.channel === "dev" ? "dev" : "staging") ||
    !["dev", "beta"].includes(plan.channel) ||
    app.otaManifestUrl !== otaUrl ||
    !otaUrl ||
    !/^[a-f0-9]{64}$/.test(app.executableSha256) ||
    !/^[a-f0-9]{64}$/.test(app.javascriptSha256)
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

export function prepareDownloads(directory, plan, repository, otaUrl) {
  const names = downloadNames(plan)
  const file = path.join(directory, names.receipt)
  const receipt = readJson(file)
  if (!receipt.artifacts.manifest) {
    validateDownloads(receipt, plan, otaUrl, {complete: false})
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
      iosInstallationFiles({...receipt, headSha: plan.sourceCommit}, repository, context),
    )) {
      writeFileSync(path.join(directory, asset.name), asset.content)
      receipt.artifacts[kind] = {name: asset.name, size: Buffer.byteLength(asset.content), sha256: hash(asset.content)}
    }
    writeFileSync(file, JSON.stringify(receipt, null, 2) + "\n")
  }
  validateDownloads(receipt, plan, otaUrl)
  verifyFiles(directory, receipt)
  return receipt
}

export async function restoreDownloads(directory, plan, repository, otaUrl) {
  const release = resolveRelease(repository, {tag: plan.artifactContainerTag})
  const assets = await listReleaseAssets(repository, release)
  const names = downloadNames(plan)
  const matches = assets.filter((asset) => asset.name === names.receipt)
  if (matches.length > 1) throw new Error("Duplicate Apple download receipts")
  if (!matches.length) return false
  mkdirSync(directory, {recursive: true})
  const receiptFile = path.join(directory, names.receipt)
  await downloadAsset(repository, matches[0], receiptFile)
  const receipt = validateDownloads(readJson(receiptFile), plan, otaUrl)
  for (const asset of Object.values(receipt.artifacts)) {
    const found = assets.filter((entry) => entry.name === asset.name)
    if (found.length !== 1) throw new Error(`Published receipt has missing or duplicate ${asset.name}`)
    await downloadAsset(repository, found[0], path.join(directory, asset.name))
  }
  verifyFiles(directory, receipt)
  return true
}

export function publishDownloads(directory, plan, repository, otaUrl, releaseId, {exec = execFileSync} = {}) {
  const receipt = prepareDownloads(directory, plan, repository, otaUrl)
  // Publication retries reuse the original signed handoff. Never replace bytes
  // under a release URL; commit the receipt only after every download verifies.
  for (const name of [...Object.values(receipt.artifacts).map((asset) => asset.name), downloadNames(plan).receipt]) {
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
  return downloadLinks(plan, repository)
}

export function downloadLinks(plan, repository) {
  const names = downloadNames(plan)
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
    otaUrl = process.env.COORDINATED_OTA_URL
  if (command === "restore") {
    const restored = await restoreDownloads(directory, plan, repository, otaUrl)
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `restored=${restored}\n`)
  } else if (command === "prepare") prepareDownloads(directory, plan, repository, otaUrl)
  else if (command === "publish") {
    const links = publishDownloads(directory, plan, repository, otaUrl, process.env.RELEASE_ID)
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(
        process.env.GITHUB_OUTPUT,
        Object.entries(links)
          .map(([key, value]) => `${key}=${value}\n`)
          .join(""),
      )
  } else throw new Error(`Unknown downloads command ${command}`)
}
