#!/usr/bin/env node
// Production Bluetooth example candidates.
//
// The Starter Kit example is its own release notion. Its production release is
// keyed on the promoted beta exactly like the stable packages: it builds the
// Starter Kit main branch against the public plain X.Y.Z packages and the
// beta's frozen OTA pin (whose ASG client is named after the same base
// version), distributes it through the public TestFlight link and the Play
// open-testing link, and records mentra-example-release-X.Y.Z.json in the
// stable release container. Nothing here promotes a store listing: the
// example never reaches a public store from this workflow.
import {createHash} from "node:crypto"
import {appendFileSync, readFileSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {validateSelectedBeta} from "./prepare-production-promotion.mjs"
import {createReleasePlan, loadReleaseFamily, serializeReleaseRecord} from "./release-family.mjs"

export const EXAMPLE_BUNDLE_ID = "com.mentra.bluetoothsdkexample"
// The production example is distributed like a public beta, not like a store
// candidate: an external TestFlight group with a public link and the Play
// open-testing track with its opt-in link. Nothing in this lane submits a
// store listing.
export const EXAMPLE_TESTFLIGHT_GROUP = "Mentra Bluetooth Example"
export const EXAMPLE_TESTFLIGHT_AUDIENCE = "external"
export const EXAMPLE_PLAY_TRACK = "beta"
const ANDROID_MAX_VERSION_CODE = 2_100_000_000

function requireInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`)
  return value
}

// One build number serves both stores, allocated above everything either store
// has ever seen for the example app and above the beta's own number so a
// production candidate can never collide with the beta candidate built from
// the same source. Google Play inventory is optional because the example's
// Play record may not be reachable yet; Play itself refuses a reused code.
export function allocateExampleBuildNumber({betaPlan, appleInventory, googleInventory = null}) {
  if (appleInventory?.bundleId !== EXAMPLE_BUNDLE_ID) {
    throw new Error(`Apple inventory does not identify ${EXAMPLE_BUNDLE_ID}`)
  }
  requireInteger(appleInventory.maxBuildNumber, "Apple maxBuildNumber")
  let googleMax = 0
  if (googleInventory !== null) {
    if (googleInventory?.packageName !== EXAMPLE_BUNDLE_ID) {
      throw new Error(`Google inventory does not identify ${EXAMPLE_BUNDLE_ID}`)
    }
    googleMax = requireInteger(googleInventory.maxVersionCode, "Google maxVersionCode")
  }
  if (!Number.isSafeInteger(betaPlan?.native?.buildNumber) || betaPlan.native.buildNumber < 1) {
    throw new Error("Selected beta has no native build number")
  }
  const buildNumber = Math.max(appleInventory.maxBuildNumber, googleMax, betaPlan.native.buildNumber) + 1
  if (buildNumber > ANDROID_MAX_VERSION_CODE) throw new Error("Example build number exceeds the Android-safe range")
  return buildNumber
}

export function createProductionExamplePlan({
  family,
  betaPlan,
  betaManifest,
  betaManifestUrl,
  betaManifestSha256,
  buildNumber,
}) {
  validateSelectedBeta({family, betaPlan, betaManifest})
  if (!/^https:\/\//.test(betaManifestUrl || "")) throw new Error("beta manifest URL must be HTTPS")
  if (!/^[0-9a-f]{64}$/.test(betaManifestSha256 || "")) throw new Error("beta manifest SHA-256 is invalid")
  if (!Number.isSafeInteger(buildNumber) || buildNumber <= betaPlan.native.buildNumber) {
    throw new Error("Example build number must be allocated above the selected beta's build number")
  }
  const plan = createReleasePlan({
    family,
    channel: "production",
    sourceCommit: betaPlan.sourceCommit,
    nativeBuildNumber: buildNumber,
    otaInputs: betaPlan.otaInputs,
  })
  plan.promotion = {
    selectedBetaReleaseSetId: betaPlan.releaseSetId,
    selectedBetaIdentity: betaPlan.releaseIdentity,
    selectedBetaManifest: {url: betaManifestUrl, sha256: betaManifestSha256},
    otaManifest: betaManifest.otaManifest,
  }
  plan.example = {
    testflight: {group: EXAMPLE_TESTFLIGHT_GROUP, audience: EXAMPLE_TESTFLIGHT_AUDIENCE},
    googlePlay: {track: EXAMPLE_PLAY_TRACK},
    storePromotion: "never",
  }
  return plan
}

// A previous run may already have frozen and persisted the plan for this
// identity. It is reused verbatim when it describes the same selected beta,
// source, and manifest; any other frozen plan is a hard stop rather than a
// silently different candidate identity.
export function reuseExistingExamplePlan({existingPlan, betaPlan, betaManifestUrl, betaManifestSha256}) {
  if (
    existingPlan?.channel !== "production" ||
    existingPlan.releaseSetId !== `mentra-${existingPlan.releaseIdentity}` ||
    existingPlan.sourceCommit !== betaPlan.sourceCommit ||
    existingPlan.promotion?.selectedBetaIdentity !== betaPlan.releaseIdentity ||
    existingPlan.promotion?.selectedBetaReleaseSetId !== betaPlan.releaseSetId ||
    existingPlan.promotion?.selectedBetaManifest?.url !== betaManifestUrl ||
    existingPlan.promotion?.selectedBetaManifest?.sha256 !== betaManifestSha256 ||
    existingPlan.example?.storePromotion !== "never" ||
    !Number.isSafeInteger(existingPlan.native?.buildNumber) ||
    existingPlan.native.buildNumber <= betaPlan.native.buildNumber
  ) {
    throw new Error("A production example plan already frozen for this identity describes different inputs")
  }
  return existingPlan
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

function output(values, githubOutput) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`)
  for (const line of lines) console.log(line)
  if (githubOutput) appendFileSync(path.resolve(githubOutput), `${lines.join("\n")}\n`)
}

function readJson(file) {
  return JSON.parse(readFileSync(path.resolve(file), "utf8"))
}

function main() {
  const command = process.argv[2]
  const args = parseArgs(process.argv.slice(3))
  if (command === "plan") {
    const betaPlan = readJson(args["beta-plan"])
    const betaManifestPath = path.resolve(args["beta-manifest"])
    const betaManifestSha256 = createHash("sha256").update(readFileSync(betaManifestPath)).digest("hex")
    const family = loadReleaseFamily({rootDir: path.resolve(args.root || process.cwd()), requireVersionMirrors: true})
    let plan
    if (args["existing-plan"]) {
      plan = reuseExistingExamplePlan({
        existingPlan: readJson(args["existing-plan"]),
        betaPlan,
        betaManifestUrl: args["beta-manifest-url"],
        betaManifestSha256,
      })
      // The frozen plan must still be the one this checkout would derive.
      const derived = createProductionExamplePlan({
        family,
        betaPlan,
        betaManifest: readJson(betaManifestPath),
        betaManifestUrl: args["beta-manifest-url"],
        betaManifestSha256,
        buildNumber: plan.native.buildNumber,
      })
      if (serializeReleaseRecord(derived) !== serializeReleaseRecord(plan)) {
        throw new Error("The frozen production example plan no longer matches the selected beta source")
      }
    } else {
      const buildNumber = allocateExampleBuildNumber({
        betaPlan,
        appleInventory: readJson(args["apple-inventory"]),
        googleInventory: args["google-inventory"] ? readJson(args["google-inventory"]) : null,
      })
      plan = createProductionExamplePlan({
        family,
        betaPlan,
        betaManifest: readJson(betaManifestPath),
        betaManifestUrl: args["beta-manifest-url"],
        betaManifestSha256,
        buildNumber,
      })
    }
    writeFileSync(path.resolve(args.output), serializeReleaseRecord(plan))
    output(
      {
        release_identity: plan.releaseIdentity,
        release_set_id: plan.releaseSetId,
        source_commit: plan.sourceCommit,
        stable_tag: plan.artifactContainerTag,
        ota_manifest_url: plan.promotion.otaManifest.url,
        ota_manifest_sha256: plan.promotion.otaManifest.sha256,
        build_number: plan.native.buildNumber,
        testflight_group: plan.example.testflight.group,
        testflight_audience: plan.example.testflight.audience,
        play_track: plan.example.googlePlay.track,
      },
      args["github-output"],
    )
    return
  }
  throw new Error(`Unknown production example command ${JSON.stringify(command)}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
