#!/usr/bin/env node
import {createHash} from "node:crypto"
import {mkdirSync, readFileSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {createInitialPromotionRecord, promotionAssetName} from "./production-promotion-state.mjs"
import {
  buildNumberBelongsTo,
  createReleasePlan,
  loadReleaseFamily,
  releaseRecordSha256,
  serializeReleaseRecord,
} from "./release-family.mjs"
import {
  allocateFamilyBuildNumber,
  familyBuildNumberMarker,
  readMarkersDirectory,
} from "./allocate-family-build-sequence.mjs"

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
  if (previousManifest === null) {
    // First coordinated promotion: no mentra-vX.Y.Z release describes the public
    // app, so freeze exactly what both stores serve today. The app cannot be
    // rebuilt for the compatibility lab, but Phase 5 still verifies it against
    // production Cloud N+1 using these coordinates.
    const {marketingVersion, buildNumber} = inventory.apple.current
    return {
      provenance: "store-observed",
      sourceCommit: null,
      provenanceUrl: null,
      ios: {marketingVersion, buildNumber},
      android: {marketingVersion, buildNumber: inventory.google.currentVersionCode},
    }
  }
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
  // A coordinated release that predates the family build-number formula (a
  // flat or timestamp number outside its family's window) cannot be rebuilt
  // for the compatibility lab: no number in that family's window would install
  // over it. It is frozen the way a store-observed app is, and Phase 5 still
  // verifies it against production Cloud N+1.
  if (!buildNumberBelongsTo(expected.marketingVersion, expected.buildNumber)) {
    return {
      provenance: "store-observed",
      sourceCommit: null,
      provenanceUrl: null,
      ios: {marketingVersion: expected.marketingVersion, buildNumber: expected.buildNumber},
      android: {marketingVersion: expected.marketingVersion, buildNumber: expected.buildNumber},
    }
  }
  return {
    provenance: "coordinated",
    sourceCommit: previousManifest.sourceCommit,
    provenanceUrl: previousManifest.url,
    ios: {marketingVersion: expected.marketingVersion, buildNumber: expected.buildNumber},
    android: {marketingVersion: expected.marketingVersion, buildNumber: expected.buildNumber},
  }
}

// Shared by promotion preparation and stable package publication: the selected
// beta must be complete, internally consistent, pinned to an immutable OTA
// manifest, and belong to the checked-out release family.
export function validateSelectedBeta({family, betaPlan, betaManifest}) {
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
  return betaPlan
}

export function prepareProductionPromotion({
  family,
  betaPlan,
  betaManifest,
  betaManifestUrl,
  betaManifestSha256,
  previousManifest,
  mentraInventory,
  familyAssets,
  familyMarkers = [],
  currentFamilyAssets = null,
  currentFamilyMarkers = [],
  attempt,
  actor,
  createdAt,
  provenanceUrl,
}) {
  validateSelectedBeta({family, betaPlan, betaManifest})
  validateInventory(mentraInventory, {bundleId: "com.mentra.mentra", allowNoCurrent: false})
  const currentMentraApp = validateCurrentMentraApp(previousManifest, mentraInventory)
  if (!buildNumberBelongsTo(family.familyBaseVersion, betaPlan.native.buildNumber)) {
    throw new Error(
      `Selected beta build number ${betaPlan.native.buildNumber} is outside the ${family.familyBaseVersion} family window`,
    )
  }
  // The candidate takes the next family sequence, exactly like a coordinated
  // run: the next free number above everything the family's build container
  // already records (earlier runs' markers and ASG client pairs).
  const promotionId = `mentra-${family.familyBaseVersion}-attempt-${attempt}`
  const candidate = allocateFamilyBuildNumber({
    assets: familyAssets,
    baseVersion: family.familyBaseVersion,
    owner: `promotion:${promotionId}:candidate`,
    markers: familyMarkers,
  })
  const mentraBuildNumber = candidate.buildNumber
  if (mentraBuildNumber <= betaPlan.native.buildNumber) {
    throw new Error(
      `Family container for ${family.familyBaseVersion} does not record the selected beta build ${betaPlan.native.buildNumber}`,
    )
  }
  // The compatibility lab rebuilds the current public app, so its number is
  // the next sequence of that app's own family, from that family's container.
  const hasCompatibilityLab = currentMentraApp.provenance === "coordinated"
  let compatibilityLab = null
  if (hasCompatibilityLab) {
    if (!Array.isArray(currentFamilyAssets)) {
      throw new Error(`The build container of the current family ${currentMentraApp.ios.marketingVersion} is required`)
    }
    compatibilityLab = allocateFamilyBuildNumber({
      assets: currentFamilyAssets,
      baseVersion: currentMentraApp.ios.marketingVersion,
      owner: `promotion:${promotionId}:compatibility-lab`,
      markers: currentFamilyMarkers,
    })
    if (
      compatibilityLab.buildNumber <= Math.max(currentMentraApp.ios.buildNumber, currentMentraApp.android.buildNumber)
    ) {
      throw new Error(
        `Family container for ${currentMentraApp.ios.marketingVersion} does not record the current public build`,
      )
    }
  }
  const compatibilityLabBuildNumber = compatibilityLab?.buildNumber ?? null
  // Google Play only publishes a production release above the one it serves.
  // A production code above the family's window (a legacy flat number) can
  // only be exceeded by a family whose window lies above it.
  if (mentraBuildNumber <= mentraInventory.google.currentVersionCode) {
    throw new Error(
      `Candidate build number ${mentraBuildNumber} is not above the Google Play production version code ${mentraInventory.google.currentVersionCode}; release under a family base version whose window lies above that code`,
    )
  }
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
    source: {mentraosCommit: betaPlan.sourceCommit},
    coordinates: {
      currentMentraApp,
      compatibilityLab: hasCompatibilityLab
        ? {
            ios: {marketingVersion: currentMentraApp.ios.marketingVersion, buildNumber: compatibilityLabBuildNumber},
            android: {
              marketingVersion: currentMentraApp.android.marketingVersion,
              buildNumber: compatibilityLabBuildNumber,
            },
          }
        : null,
      candidates: {
        mentraApp: {
          ios: {marketingVersion: productionPlan.native.marketingVersion, buildNumber: mentraBuildNumber},
          android: {marketingVersion: productionPlan.native.marketingVersion, buildNumber: mentraBuildNumber},
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
  const markers = [
    {
      containerBaseVersion: family.familyBaseVersion,
      marker: familyBuildNumberMarker({
        baseVersion: family.familyBaseVersion,
        buildNumber: mentraBuildNumber,
        owner: candidate.owner,
      }),
    },
    ...(compatibilityLab
      ? [
          {
            containerBaseVersion: currentMentraApp.ios.marketingVersion,
            marker: familyBuildNumberMarker({
              baseVersion: currentMentraApp.ios.marketingVersion,
              buildNumber: compatibilityLab.buildNumber,
              owner: compatibilityLab.owner,
            }),
          },
        ]
      : []),
  ]
  return {productionPlan, record, markers}
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
  let previousManifest = null
  if (args["previous-manifest"] || args["previous-manifest-url"]) {
    previousManifest = readJson(args["previous-manifest"])
    previousManifest.url = args["previous-manifest-url"]
  }
  const result = prepareProductionPromotion({
    family: loadReleaseFamily({rootDir: path.resolve(args.root || process.cwd()), requireVersionMirrors: true}),
    betaPlan: readJson(args["beta-plan"]),
    betaManifest: readJson(betaManifestPath),
    betaManifestUrl: args["beta-manifest-url"],
    betaManifestSha256: sha256File(betaManifestPath),
    previousManifest,
    mentraInventory: readJson(args["mentra-inventory"]),
    familyAssets: readJson(args["family-assets"]),
    familyMarkers: readMarkersDirectory(args["family-markers-dir"]),
    currentFamilyAssets: args["current-family-assets"] ? readJson(args["current-family-assets"]) : null,
    currentFamilyMarkers: readMarkersDirectory(args["current-family-markers-dir"]),
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
  if (args["marker-directory"]) {
    const markerDirectory = path.resolve(args["marker-directory"])
    for (const {containerBaseVersion, marker} of result.markers) {
      const directory = path.join(markerDirectory, containerBaseVersion)
      mkdirSync(directory, {recursive: true})
      writeFileSync(
        path.join(directory, `mentra-build-number-${marker.buildNumber}.json`),
        `${JSON.stringify(marker, null, 2)}\n`,
      )
    }
  }
  console.log(recordFile)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
