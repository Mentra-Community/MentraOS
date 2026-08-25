#!/usr/bin/env node
import {createHash} from "node:crypto"
import {readFileSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {createReleasePlan, loadReleaseFamily, releaseRecordSha256, serializeReleaseRecord} from "./release-family.mjs"

const SHA256_PATTERN = /^[0-9a-f]{64}$/

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"))
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

function exactArtifact(manifest, coordinate) {
  const matches = (manifest.artifacts || []).filter((artifact) => artifact.coordinate === coordinate)
  if (matches.length !== 1) throw new Error(`Expected one beta artifact ${coordinate}, found ${matches.length}`)
  return matches[0]
}

export function prepareProductionRelease({family, betaPlan, betaManifest, betaManifestSha256, repository}) {
  if (betaPlan.channel !== "beta" || !/^\d+\.\d+\.\d+-beta\.\d+$/.test(betaPlan.releaseIdentity)) {
    throw new Error("Production can only select a completed beta release plan")
  }
  if (
    betaManifest.channel !== "beta" ||
    betaManifest.releaseSetId !== betaPlan.releaseSetId ||
    betaManifest.releaseIdentity !== betaPlan.releaseIdentity ||
    betaManifest.sourceCommit !== betaPlan.sourceCommit
  ) {
    throw new Error("Beta release manifest does not match its plan")
  }
  if (betaManifest.releasePlanSha256 !== releaseRecordSha256(betaPlan)) {
    throw new Error("Beta release plan digest does not match the completed manifest")
  }
  if (betaPlan.familyBaseVersion !== family.familyBaseVersion) {
    throw new Error("Selected beta belongs to a different family base")
  }
  if (!SHA256_PATTERN.test(betaManifestSha256)) throw new Error("Invalid beta manifest SHA-256")
  if (!Number.isSafeInteger(betaPlan.native?.buildNumber) || betaPlan.native.buildNumber < 1) {
    throw new Error("Selected beta has no valid native build number")
  }

  const betaTag = `mentra-v${betaPlan.releaseIdentity}`
  const betaAssetBaseUrl = `https://github.com/${repository}/releases/download/${betaTag}`
  const betaManifestUrl = `${betaAssetBaseUrl}/${betaPlan.artifactNames.releaseManifest}`
  const productionPlan = createReleasePlan({
    family,
    channel: "production",
    sourceCommit: betaPlan.sourceCommit,
    nativeBuildNumber: betaPlan.native.buildNumber,
    otaInputs: betaPlan.otaInputs,
  })
  productionPlan.promotion = {
    selectedBetaReleaseSetId: betaPlan.releaseSetId,
    selectedBetaIdentity: betaPlan.releaseIdentity,
    selectedBetaManifest: {
      url: betaManifestUrl,
      sha256: betaManifestSha256,
    },
  }

  const mobileArtifacts = {
    androidApk: exactArtifact(betaManifest, betaPlan.artifactNames.androidApp),
    androidAab: exactArtifact(betaManifest, betaPlan.artifactNames.androidStoreApp),
    iosIpa: exactArtifact(betaManifest, betaPlan.artifactNames.iosApp),
  }
  const asgArtifacts = (betaManifest.artifacts || []).filter(
    (artifact) => typeof artifact.signingCertificateSha256 === "string",
  )
  if (asgArtifacts.length !== 1) {
    throw new Error(`Expected one signed ASG artifact in the completed beta manifest, found ${asgArtifacts.length}`)
  }
  const otaArtifacts = [
    exactArtifact(betaManifest, betaPlan.artifactNames.otaBundle),
    exactArtifact(betaManifest, betaPlan.artifactNames.asgSelection),
    asgArtifacts[0],
  ]

  return {
    productionPlan,
    selection: {
      schemaVersion: 1,
      releaseSetId: productionPlan.releaseSetId,
      selectedBetaReleaseSetId: betaPlan.releaseSetId,
      selectedBetaIdentity: betaPlan.releaseIdentity,
      sourceCommit: betaPlan.sourceCommit,
      native: betaPlan.native,
      betaManifest: productionPlan.promotion.selectedBetaManifest,
      otaManifest: betaManifest.otaManifest,
      otaArtifacts,
      mobileArtifacts,
    },
  }
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

function main() {
  const args = parseArgs(process.argv.slice(2))
  const betaPlanPath = path.resolve(args["beta-plan"])
  const betaManifestPath = path.resolve(args["beta-manifest"])
  const result = prepareProductionRelease({
    family: loadReleaseFamily({rootDir: path.resolve(args.root || process.cwd()), requireVersionMirrors: true}),
    betaPlan: readJson(betaPlanPath),
    betaManifest: readJson(betaManifestPath),
    betaManifestSha256: sha256File(betaManifestPath),
    repository: args.repository,
  })
  writeFileSync(path.resolve(args["plan-output"]), serializeReleaseRecord(result.productionPlan))
  writeFileSync(path.resolve(args["selection-output"]), serializeReleaseRecord(result.selection))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
