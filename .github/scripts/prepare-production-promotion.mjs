#!/usr/bin/env node
import {createHash} from "node:crypto"
import {mkdirSync, readFileSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {createInitialPromotionRecord, promotionAssetName} from "./production-promotion-state.mjs"
import {createReleasePlan, loadReleaseFamily, releaseRecordSha256, serializeReleaseRecord} from "./release-family.mjs"

const COMMIT_PATTERN = /^[0-9a-f]{40}$/

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

function requireInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`)
  return value
}

function validateInventory(inventory, {bundleId, allowNoCurrent}) {
  if (inventory.apple?.bundleId !== bundleId) throw new Error(`Apple inventory does not identify ${bundleId}`)
  if (inventory.google?.packageName !== bundleId) throw new Error(`Google inventory does not identify ${bundleId}`)
  requireInteger(inventory.apple.maxBuildNumber, `${bundleId} Apple maxBuildNumber`)
  requireInteger(inventory.google.maxVersionCode, `${bundleId} Google maxVersionCode`)
  if (!allowNoCurrent && (!inventory.apple.current || !Number.isSafeInteger(inventory.google.currentVersionCode))) {
    throw new Error(`${bundleId} has no current public store release`)
  }
  return inventory
}

function validateCurrentMentraApp(previousManifest, inventory) {
  const expected = previousManifest.native
  if (
    !expected ||
    inventory.apple.current.marketingVersion !== expected.marketingVersion ||
    inventory.apple.current.buildNumber !== expected.buildNumber ||
    inventory.google.currentVersionCode !== expected.buildNumber
  ) {
    throw new Error("Current App Store and Google Play builds do not match the previous production manifest")
  }
  if (!COMMIT_PATTERN.test(previousManifest.sourceCommit || "")) {
    throw new Error("Previous production manifest has no full source commit")
  }
  return {
    sourceCommit: previousManifest.sourceCommit,
    provenanceUrl: previousManifest.url,
    ios: {marketingVersion: expected.marketingVersion, buildNumber: expected.buildNumber},
    android: {marketingVersion: expected.marketingVersion, buildNumber: expected.buildNumber},
  }
}

export function prepareProductionPromotion({
  family,
  betaPlan,
  betaManifest,
  betaManifestUrl,
  betaManifestSha256,
  previousManifest,
  mentraInventory,
  starterKitInventory,
  starterKitCommit,
  attempt,
  actor,
  createdAt,
  provenanceUrl,
}) {
  if (
    betaPlan.channel !== "beta" ||
    betaManifest.channel !== "beta" ||
    betaPlan.releaseSetId !== betaManifest.releaseSetId ||
    betaPlan.releaseIdentity !== betaManifest.releaseIdentity ||
    betaPlan.sourceCommit !== betaManifest.sourceCommit ||
    betaManifest.releasePlanSha256 !== releaseRecordSha256(betaPlan)
  ) {
    throw new Error("Selected beta plan and completed manifest do not match")
  }
  if (betaPlan.familyBaseVersion !== family.familyBaseVersion) {
    throw new Error("Selected beta belongs to a different checked-out release family")
  }
  if (!betaManifest.completedAt) throw new Error("Selected beta is not complete")
  if (
    !/^https:\/\//.test(betaManifest.otaManifest?.url || "") ||
    !/^[0-9a-f]{64}$/.test(betaManifest.otaManifest?.sha256 || "")
  ) {
    throw new Error("Selected beta has no immutable OTA manifest pin")
  }
  const betaStarterKitCommit = betaManifest.starterKit?.starterKit?.releaseCommit
  if (!COMMIT_PATTERN.test(betaStarterKitCommit || "")) {
    throw new Error("Selected beta has no exact Starter Kit release commit")
  }
  if (!COMMIT_PATTERN.test(starterKitCommit || "")) {
    throw new Error("Stable Starter Kit tag has no exact release commit")
  }
  validateInventory(mentraInventory, {bundleId: "com.mentra.mentra", allowNoCurrent: false})
  validateInventory(starterKitInventory, {bundleId: "com.mentra.bluetoothsdkexample", allowNoCurrent: true})
  const currentMentraApp = validateCurrentMentraApp(previousManifest, mentraInventory)
  const lastMentraBuildNumber = Math.max(
    mentraInventory.apple.maxBuildNumber,
    mentraInventory.google.maxVersionCode,
    betaPlan.native.buildNumber,
  )
  const compatibilityLabBuildNumber = lastMentraBuildNumber + 1
  const mentraBuildNumber = lastMentraBuildNumber + 2
  const starterKitBuildNumber =
    Math.max(starterKitInventory.apple.maxBuildNumber, starterKitInventory.google.maxVersionCode, mentraBuildNumber) + 1
  const productionPlan = createReleasePlan({
    family,
    channel: "production",
    sourceCommit: betaPlan.sourceCommit,
    nativeBuildNumber: mentraBuildNumber,
    otaInputs: betaPlan.otaInputs,
  })
  productionPlan.promotion = {
    selectedBetaReleaseSetId: betaPlan.releaseSetId,
    selectedBetaIdentity: betaPlan.releaseIdentity,
    selectedBetaManifest: {url: betaManifestUrl, sha256: betaManifestSha256},
    otaManifest: betaManifest.otaManifest,
  }
  const record = createInitialPromotionRecord({
    releaseIdentity: productionPlan.releaseIdentity,
    attempt,
    selectedBeta: {
      identity: betaPlan.releaseIdentity,
      releaseSetId: betaPlan.releaseSetId,
      manifestUrl: betaManifestUrl,
      manifestSha256: betaManifestSha256,
    },
    source: {mentraosCommit: betaPlan.sourceCommit, starterKitCommit},
    coordinates: {
      currentMentraApp,
      compatibilityLab: {
        ios: {marketingVersion: currentMentraApp.ios.marketingVersion, buildNumber: compatibilityLabBuildNumber},
        android: {
          marketingVersion: currentMentraApp.android.marketingVersion,
          buildNumber: compatibilityLabBuildNumber,
        },
      },
      candidates: {
        mentraApp: {
          ios: {marketingVersion: productionPlan.native.marketingVersion, buildNumber: mentraBuildNumber},
          android: {marketingVersion: productionPlan.native.marketingVersion, buildNumber: mentraBuildNumber},
        },
        starterKit: {
          ios: {marketingVersion: productionPlan.native.marketingVersion, buildNumber: starterKitBuildNumber},
          android: {marketingVersion: productionPlan.native.marketingVersion, buildNumber: starterKitBuildNumber},
        },
      },
    },
    actor,
    createdAt,
    provenanceUrl,
    evidence: [
      {
        kind: "selected-beta-manifest",
        url: betaManifestUrl,
        sha256: betaManifestSha256,
        assetName: path.basename(new URL(betaManifestUrl).pathname),
      },
    ],
  })
  return {productionPlan, record}
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

function readJson(file) {
  return JSON.parse(readFileSync(path.resolve(file), "utf8"))
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const betaManifestPath = path.resolve(args["beta-manifest"])
  const previousManifest = readJson(args["previous-manifest"])
  previousManifest.url = args["previous-manifest-url"]
  const result = prepareProductionPromotion({
    family: loadReleaseFamily({rootDir: path.resolve(args.root || process.cwd()), requireVersionMirrors: true}),
    betaPlan: readJson(args["beta-plan"]),
    betaManifest: readJson(betaManifestPath),
    betaManifestUrl: args["beta-manifest-url"],
    betaManifestSha256: sha256File(betaManifestPath),
    previousManifest,
    mentraInventory: readJson(args["mentra-inventory"]),
    starterKitInventory: readJson(args["starter-kit-inventory"]),
    starterKitCommit: args["starter-kit-commit"],
    attempt: Number(args.attempt),
    actor: args.actor,
    createdAt: args["created-at"],
    provenanceUrl: args["provenance-url"],
  })
  writeFileSync(path.resolve(args["plan-output"]), serializeReleaseRecord(result.productionPlan))
  const recordDirectory = path.resolve(args["record-directory"])
  const recordFile = path.join(recordDirectory, promotionAssetName(result.record))
  mkdirSync(recordDirectory, {recursive: true})
  writeFileSync(recordFile, serializeReleaseRecord(result.record))
  console.log(recordFile)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
