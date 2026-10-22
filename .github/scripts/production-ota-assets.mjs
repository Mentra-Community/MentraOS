#!/usr/bin/env node
// A production release builds no OTA set of its own: it promotes the selected
// beta's. Its release container (mentra-v<identity>) carries byte-identical
// copies of that beta's OTA manifest and portable OTA bundle under the
// production names, so the production release record and download page list
// them next to the rest of the release. The SDK packages and the Mentra App
// keep pinning the beta's manifest URL, which the production record still
// records as otaManifest.
//
//   stage  downloads the promoted beta's manifest and bundle, verifies them
//          against the beta release record, and writes them under the
//          production names with production-ota-assets.json describing them
import {createHash} from "node:crypto"
import {appendFileSync, mkdirSync, readFileSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {artifactUrl} from "./release-artifact-storage.mjs"
import {requirePublicHttpsUrl} from "./release-family.mjs"

const SHA256_PATTERN = /^[0-9a-f]{64}$/

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

// What to copy, from the production plan and the promoted beta's record.
export function productionOtaSources({plan, betaManifest, betaManifestSha256}) {
  if (plan?.channel !== "production" || !plan.promotion) throw new Error("A production release plan is required")
  const betaIdentity = plan.promotion.selectedBetaIdentity
  if (
    betaManifest?.releaseIdentity !== betaIdentity ||
    betaManifest.channel !== "beta" ||
    betaManifest.releaseSetId !== plan.promotion.selectedBetaReleaseSetId ||
    betaManifestSha256 !== plan.promotion.selectedBetaManifest?.sha256
  ) {
    throw new Error("The beta release record is not the one the production release was promoted from")
  }
  const manifest = betaManifest.otaManifest
  if (manifest?.url !== plan.promotion.otaManifest?.url || manifest?.sha256 !== plan.promotion.otaManifest?.sha256) {
    throw new Error("The promoted OTA manifest differs from the beta release record")
  }
  const bundleName = `mentra-live-ota-bundle-${betaIdentity}.zip`
  const bundle = (betaManifest.artifacts || []).find((artifact) => artifact.coordinate === bundleName)
  if (!bundle) throw new Error(`The promoted beta ${betaIdentity} published no ${bundleName}`)
  for (const [label, source] of [
    ["OTA manifest", manifest],
    ["OTA bundle", bundle],
  ]) {
    requirePublicHttpsUrl(source.url, `${label} URL`)
    if (!SHA256_PATTERN.test(source.sha256 || "")) throw new Error(`${label} SHA-256 is invalid`)
  }
  for (const key of ["otaManifest", "otaBundle"]) {
    if (!plan.artifactNames?.[key]) throw new Error(`The production plan names no ${key}`)
  }
  return [
    {
      key: "otaManifest",
      name: plan.artifactNames.otaManifest,
      source: {coordinate: manifest.coordinate, url: manifest.url, sha256: manifest.sha256},
    },
    {
      key: "otaBundle",
      name: plan.artifactNames.otaBundle,
      source: {coordinate: bundle.coordinate, url: bundle.url, sha256: bundle.sha256},
    },
  ]
}

// The production record's entries for the copies.
export function productionOtaArtifacts({plan, sources, files, repository, provenanceUrl}) {
  return sources.map(({key, name, source}) => {
    const bytes = files[key]
    if (!bytes || sha256(bytes) !== source.sha256) {
      throw new Error(`${name} is not a byte-identical copy of ${source.coordinate}`)
    }
    return {
      status: "promoted",
      coordinate: name,
      url: artifactUrl(repository, plan.artifactContainerTag, name),
      sha256: source.sha256,
      size: bytes.length,
      promotedFrom: {coordinate: source.coordinate, url: source.url},
      provenanceUrl: requirePublicHttpsUrl(provenanceUrl, "provenance URL"),
    }
  })
}

// The production record lists exactly these two copies.
export function validateProductionOtaArtifacts(plan, artifacts) {
  const expected = [plan.artifactNames?.otaManifest, plan.artifactNames?.otaBundle]
  if (
    !Array.isArray(artifacts) ||
    artifacts.length !== 2 ||
    artifacts.some(
      (artifact, index) =>
        artifact?.coordinate !== expected[index] ||
        artifact.status !== "promoted" ||
        !SHA256_PATTERN.test(artifact.sha256 || "") ||
        !Number.isSafeInteger(artifact.size) ||
        !artifact.promotedFrom?.url,
    )
  ) {
    throw new Error("The production release must list the promoted OTA manifest and bundle copies")
  }
  if (artifacts[0].sha256 !== plan.promotion?.otaManifest?.sha256) {
    throw new Error("The production OTA manifest copy differs from the promoted manifest")
  }
  for (const artifact of artifacts) {
    requirePublicHttpsUrl(artifact.url, `${artifact.coordinate} URL`)
    requirePublicHttpsUrl(artifact.promotedFrom.url, `${artifact.coordinate} source URL`)
  }
  return artifacts
}

async function download(url) {
  const response = await fetch(url, {redirect: "follow"})
  if (!response.ok) throw new Error(`GET ${url} returned HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

function parseArgs(args) {
  const values = {}
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]
    const value = args[index + 1]
    if (!option?.startsWith("--") || value === undefined) throw new Error("Expected --name value pairs")
    values[option.slice(2)] = value
  }
  return values
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  if (command !== "stage") throw new Error(`Unknown command ${JSON.stringify(command)}`)
  const args = parseArgs(rest)
  const plan = JSON.parse(readFileSync(path.resolve(args.plan), "utf8"))
  const betaBytes = await download(plan.promotion.selectedBetaManifest.url)
  const sources = productionOtaSources({
    plan,
    betaManifest: JSON.parse(betaBytes.toString("utf8")),
    betaManifestSha256: sha256(betaBytes),
  })
  const files = {}
  for (const {key, source} of sources) files[key] = await download(source.url)
  const artifacts = productionOtaArtifacts({
    plan,
    sources,
    files,
    repository: args.repository,
    provenanceUrl: args["provenance-url"],
  })
  const directory = path.resolve(args["output-dir"])
  mkdirSync(directory, {recursive: true})
  for (const {key, name} of sources) writeFileSync(path.join(directory, name), files[key])
  writeFileSync(path.join(directory, "production-ota-assets.json"), `${JSON.stringify(artifacts, null, 2)}\n`)
  if (args["github-output"]) {
    appendFileSync(args["github-output"], `manifest_name=${sources[0].name}\nbundle_name=${sources[1].name}\n`)
  }
  for (const artifact of artifacts)
    console.log(`Staged ${artifact.coordinate} from ${artifact.promotedFrom.coordinate}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
