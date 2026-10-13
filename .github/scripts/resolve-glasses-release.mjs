#!/usr/bin/env node
// Pin one published Mentra Live ASG/MTK/BES set for a refurbishment track.
// Production uses only a public mentra-vX.Y.Z release. Staging and dev use the
// newest complete artifact triplet in mentra-builds-vX.Y.Z. Nothing here talks
// to a glasses device.

import {createHash} from "node:crypto"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {latestProductionRelease, parseJsonLines, RELEASE_LIST_FIELDS} from "./production-promotion-assets.mjs"
import {gh, readPublicIndex} from "./release-artifact-storage.mjs"

export const REPOSITORY = "Mentra-Community/MentraOS"
const TRACKS = new Map([
  ["production", "production"],
  ["staging", "beta"],
  ["dev", "dev"],
])
const IDENTITY_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(dev|beta)\.(0|[1-9]\d*))?$/
const BUILD_TAG_PATTERN = /^mentra-builds-v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/
const SHA256_PATTERN = /^[0-9a-f]{64}$/
const COMMIT_PATTERN = /^[0-9a-f]{40}$/

export class GlassesReleaseError extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.name = "GlassesReleaseError"
    this.exitCode = exitCode
  }
}

function fail(message, exitCode = 1) {
  throw new GlassesReleaseError(message, exitCode)
}

export function parseReleaseIdentity(identity) {
  const match = IDENTITY_PATTERN.exec(identity || "")
  if (!match) return null
  return {
    identity,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    family: `${match[1]}.${match[2]}.${match[3]}`,
    channel: match[4] || "production",
    sequence: match[5] === undefined ? 0 : Number(match[5]),
  }
}

// Higher X.Y.Z wins before the prerelease sequence, so 3.3.0-beta.1 is newer
// than 3.2.1-beta.999.
export function compareReleaseIdentities(left, right) {
  const a = parseReleaseIdentity(left)
  const b = parseReleaseIdentity(right)
  if (!a || !b) fail(`Cannot compare release identities ${left} and ${right}`)
  for (const key of ["major", "minor", "patch", "sequence"]) {
    if (a[key] !== b[key]) return a[key] - b[key]
  }
  return 0
}

export function requireCompleteReleaseList(releases, complete) {
  if (!Array.isArray(releases) || complete !== true) {
    fail("GitHub release list is truncated; refusing to choose a glasses release from a partial page")
  }
}

function assetNamed(index, name) {
  const matches = (index?.assets || []).filter((asset) => asset?.name === name)
  if (matches.length !== 1) return null
  return matches[0]
}

function httpsUrl(value, label) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    fail(`${label} is not a URL`, 12)
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) {
    fail(`${label} must be credential-free HTTPS`, 12)
  }
  return parsed.toString()
}

async function readJson(url, fetchImpl) {
  let response
  try {
    response = await fetchImpl(url, {redirect: "error", signal: AbortSignal.timeout(30_000)})
  } catch (error) {
    const status = error?.cause?.code || error?.name || "network"
    fail(`Could not download ${url} (${status})`)
  }
  if (response.status === 401 || response.status === 403) fail(`Artifact request was not authorized (HTTP ${response.status})`)
  if (response.status === 429) fail("Artifact host rate-limited the release lookup (HTTP 429)")
  if (!response.ok) fail(`Artifact download failed with HTTP ${response.status}`, 12)
  const text = await response.text()
  if (!text || text.length < 2) fail(`Artifact download from ${url} was empty or truncated`, 12)
  try {
    return {value: JSON.parse(text), sha256: createHash("sha256").update(text).digest("hex")}
  } catch {
    fail(`Artifact at ${url} is not JSON`, 12)
  }
}

function pageAgrees(releases, identity, sourceCommit) {
  const page = releases.find((release) => release?.tag_name === `mentra-v${identity}`)
  if (!page) return
  if (page.draft === true && page.prerelease === false && parseReleaseIdentity(identity)?.channel === "production") return
  const commit = page.target_commitish || ""
  if (COMMIT_PATTERN.test(commit) && commit !== sourceCommit) {
    fail(`Public release page mentra-v${identity} records commit ${commit}, not ${sourceCommit}`, 12)
  }
}

function validateCommon(plan, record, planSha, identity, channel, container) {
  const parsed = parseReleaseIdentity(identity)
  if (
    !parsed ||
    plan?.schemaVersion !== 1 ||
    plan.releaseIdentity !== identity ||
    plan.channel !== channel ||
    plan.releaseSetId !== `mentra-${identity}` ||
    plan.artifactContainerTag !== container ||
    plan.artifactNames?.releasePlan !== `mentra-release-plan-${identity}.json` ||
    plan.artifactNames?.releaseManifest !== `mentra-release-${identity}.json` ||
    plan.artifactNames?.otaManifest !== `mentra-live-ota-${identity}.json` ||
    !COMMIT_PATTERN.test(plan.sourceCommit || "")
  ) {
    fail(`Release plan for ${identity} does not describe that ${channel} glasses set`, 12)
  }
  if (
    record?.schemaVersion !== 1 ||
    record.releaseIdentity !== identity ||
    record.channel !== channel ||
    record.releaseSetId !== plan.releaseSetId ||
    record.sourceCommit !== plan.sourceCommit ||
    record.releasePlanSha256 !== planSha
  ) {
    fail(`Release record for ${identity} does not match its plan`, 12)
  }
  const ota = record.otaManifest
  if (!ota || typeof ota !== "object") fail(`Release record for ${identity} has no OTA manifest`, 12)
  httpsUrl(ota.url, "OTA manifest URL")
  if (!SHA256_PATTERN.test(ota.sha256 || "")) fail(`OTA manifest digest for ${identity} is not a SHA-256`, 12)
  return ota
}

function pinFrom(track, channel, identity, container, plan, record, ota) {
  return {
    track,
    channel,
    releaseIdentity: identity,
    releaseSetId: plan.releaseSetId,
    containerTag: container,
    sourceCommit: plan.sourceCommit,
    otaUrl: ota.url,
    otaSha256: ota.sha256,
    planSha256: record.releasePlanSha256,
    ...(track === "production"
      ? {selectedBetaIdentity: plan.promotion.selectedBetaIdentity}
      : {}),
  }
}

async function resolveProduction({releases, repository, fetchImpl, readIndex}) {
  const selected = latestProductionRelease(releases)
  if (!selected) {
    fail("No published production glasses release. Refusing to use a draft, prerelease, staging snapshot, or Private Cloud build.", 10)
  }
  const identity = selected.releaseIdentity
  const container = selected.tag
  let index
  try {
    index = await readIndex(repository, container, fetchImpl)
  } catch (error) {
    fail(`Production artifact index for ${container} failed: ${error.message}`)
  }
  const planAsset = assetNamed(index, `mentra-release-plan-${identity}.json`)
  const recordAsset = assetNamed(index, `mentra-release-${identity}.json`)
  if (!planAsset?.url || !recordAsset?.url) {
    fail(`Published production release ${container} is missing its plan or release record`, 12)
  }
  const planDownload = await readJson(planAsset.url, fetchImpl)
  const recordDownload = await readJson(recordAsset.url, fetchImpl)
  const plan = planDownload.value
  const record = recordDownload.value
  const ota = validateCommon(plan, record, planDownload.sha256, identity, "production", container)
  const promotion = plan.promotion
  const recorded = record.promotion
  const beta = parseReleaseIdentity(promotion?.selectedBetaIdentity)
  if (
    ota.status !== "promoted" ||
    ota.coordinate !== `mentra-live-ota-${promotion?.selectedBetaIdentity}.json` ||
    !beta ||
    beta.channel !== "beta" ||
    beta.family !== identity ||
    promotion?.selectedBetaReleaseSetId !== `mentra-${promotion.selectedBetaIdentity}` ||
    !promotion?.selectedBetaManifest?.url ||
    !SHA256_PATTERN.test(promotion?.selectedBetaManifest?.sha256 || "") ||
    recorded?.selectedBetaIdentity !== promotion.selectedBetaIdentity ||
    recorded?.selectedBetaReleaseSetId !== promotion.selectedBetaReleaseSetId ||
    recorded?.selectedBetaManifest?.url !== promotion.selectedBetaManifest.url ||
    recorded?.selectedBetaManifest?.sha256 !== promotion.selectedBetaManifest.sha256
  ) {
    fail(`Production release ${identity} is not a promoted selected-beta glasses set`, 12)
  }
  httpsUrl(promotion.selectedBetaManifest.url, "selected beta manifest URL")
  httpsUrl(ota.url, "promoted OTA manifest URL")
  return pinFrom("production", "production", identity, container, plan, record, ota)
}

function tripletIdentities(index, family, channel) {
  const found = []
  for (const asset of index?.assets || []) {
    const name = asset?.name || ""
    const prefix = "mentra-release-plan-"
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue
    const identity = name.slice(prefix.length, -".json".length)
    const parsed = parseReleaseIdentity(identity)
    if (!parsed || parsed.channel !== channel || parsed.family !== family) continue
    const record = assetNamed(index, `mentra-release-${identity}.json`)
    const ota = assetNamed(index, `mentra-live-ota-${identity}.json`)
    if (!record || !ota) continue
    found.push(identity)
  }
  return found
}

async function resolvePrerelease({track, channel, releases, repository, fetchImpl, readIndex}) {
  const containers = releases.filter(
    (release) => release?.draft === false && BUILD_TAG_PATTERN.test(release.tag_name || ""),
  )
  let best = null
  for (const release of containers) {
    const family = BUILD_TAG_PATTERN.exec(release.tag_name)[1]
    let index
    try {
      index = await readIndex(repository, release.tag_name, fetchImpl)
    } catch (error) {
      fail(`Artifact index for ${release.tag_name} failed: ${error.message}`)
    }
    for (const identity of tripletIdentities(index, family, channel)) {
      if (!best || compareReleaseIdentities(identity, best.identity) > 0) {
        best = {identity, container: release.tag_name, index}
      }
    }
  }
  if (!best) {
    fail(`No complete published ${track} glasses release. An OTA file alone is not a release.`)
  }
  const planName = `mentra-release-plan-${best.identity}.json`
  const recordName = `mentra-release-${best.identity}.json`
  const otaName = `mentra-live-ota-${best.identity}.json`
  const planAsset = assetNamed(best.index, planName)
  const recordAsset = assetNamed(best.index, recordName)
  const otaAsset = assetNamed(best.index, otaName)
  const planDownload = await readJson(planAsset.url, fetchImpl)
  const recordDownload = await readJson(recordAsset.url, fetchImpl)
  const plan = planDownload.value
  const record = recordDownload.value
  const ota = validateCommon(plan, record, planDownload.sha256, best.identity, channel, best.container)
  if (!["published", "reused", "promoted"].includes(ota.status) || ota.coordinate !== otaName) {
    fail(`Release record for ${best.identity} does not publish ${otaName}`, 12)
  }
  if (ota.url !== otaAsset.url || otaAsset.digest !== `sha256:${ota.sha256}`) {
    fail(`Release record for ${best.identity} does not match the uploaded OTA manifest`, 12)
  }
  pageAgrees(releases, best.identity, plan.sourceCommit)
  return pinFrom(track, channel, best.identity, best.container, plan, record, ota)
}

export async function resolveGlassesRelease({
  track,
  releases,
  complete = false,
  repository = REPOSITORY,
  fetchImpl = fetch,
  readIndex = readPublicIndex,
} = {}) {
  const channel = TRACKS.get(track)
  if (!channel) fail("Track must be production, staging, or dev")
  requireCompleteReleaseList(releases, complete)
  if (track === "production") return resolveProduction({releases, repository, fetchImpl, readIndex})
  return resolvePrerelease({track, channel, releases, repository, fetchImpl, readIndex})
}

export function listGithubReleases({execImpl = gh, repository = REPOSITORY} = {}) {
  let output
  try {
    output = execImpl([
      "api",
      "--paginate",
      `repos/${repository}/releases?per_page=100`,
      "--jq",
      `.[] | ${RELEASE_LIST_FIELDS} | tojson`,
    ])
  } catch (error) {
    const message = String(error?.stderr || error?.message || error)
    if (/401|403|auth/i.test(message)) fail("GitHub refused the release list")
    if (/429|rate limit/i.test(message)) fail("GitHub rate-limited the release list")
    fail("Could not list GitHub releases")
  }
  return parseJsonLines(output)
}

function optionValue(args, name) {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith("--")) fail(`${name} requires a value`)
  return value
}

async function main() {
  const track = optionValue(process.argv.slice(2), "--track") || "production"
  try {
    const releases = listGithubReleases()
    const pin = await resolveGlassesRelease({track, releases, complete: true})
    process.stdout.write(`${JSON.stringify(pin)}\n`)
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exit(error.exitCode || 1)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
