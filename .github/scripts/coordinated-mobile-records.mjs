#!/usr/bin/env node
import {createHash} from "node:crypto"
import {readFileSync, statSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {serializeReleaseRecord} from "./release-family.mjs"

const STATUSES = new Set(["built", "published", "reused"])

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"))
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex")
}

function requireHttps(value, label) {
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error(`${label} must be credential-free HTTPS without a fragment`)
  }
  return url.toString()
}

function validatePlan(plan) {
  const app = plan.members?.mentraos
  if (plan.releaseSetId !== `mentra-${plan.releaseIdentity}` || app?.version !== plan.releaseIdentity) {
    throw new Error("Release plan does not contain the coordinated MentraOS product")
  }
  if (!Number.isSafeInteger(plan.native?.buildNumber) || plan.native.marketingVersion !== plan.familyBaseVersion) {
    throw new Error("Release plan has invalid native version metadata")
  }
}

function publication({status, coordinate, url, provenanceUrl, file}) {
  if (!STATUSES.has(status)) throw new Error(`Unsupported mobile publication status ${JSON.stringify(status)}`)
  return {
    status,
    coordinate,
    url: requireHttps(url, `${coordinate} URL`),
    provenanceUrl: requireHttps(provenanceUrl, `${coordinate} provenance URL`),
    sha256: sha256File(file),
    size: statSync(file).size,
  }
}

export function createAndroidRecord({plan, apk, apkUrl, aab, aabUrl, playTrack, storeStatus, provenanceUrl}) {
  validatePlan(plan)
  if (!playTrack) throw new Error("Google Play track is required")
  return {
    schemaVersion: 1,
    releaseSetId: plan.releaseSetId,
    publications: {
      mentraos: {
        "google-play": publication({
          status: storeStatus,
          coordinate: `com.mentra.mentra:${plan.native.buildNumber}:${playTrack}`,
          url: "https://play.google.com/console/",
          provenanceUrl,
          file: aab,
        }),
      },
    },
    artifacts: [
      publication({
        status: storeStatus,
        coordinate: plan.artifactNames.androidApp,
        url: apkUrl,
        provenanceUrl,
        file: apk,
      }),
      publication({
        status: storeStatus,
        coordinate: plan.artifactNames.androidStoreApp,
        url: aabUrl,
        provenanceUrl,
        file: aab,
      }),
    ],
  }
}

export function createIosRecord({plan, ipa, ipaUrl, testflightGroup, storeStatus, provenanceUrl}) {
  validatePlan(plan)
  if (!testflightGroup) throw new Error("TestFlight group is required")
  return {
    schemaVersion: 1,
    releaseSetId: plan.releaseSetId,
    publications: {
      mentraos: {
        "app-store-connect": publication({
          status: storeStatus,
          coordinate: `com.mentra.mentra:${plan.native.marketingVersion}:${plan.native.buildNumber}:${testflightGroup}`,
          url: "https://appstoreconnect.apple.com/apps",
          provenanceUrl,
          file: ipa,
        }),
      },
    },
    artifacts: [
      publication({
        status: storeStatus,
        coordinate: plan.artifactNames.iosApp,
        url: ipaUrl,
        provenanceUrl,
        file: ipa,
      }),
    ],
  }
}

export function mergeMobileRecords({plan, android, ios}) {
  validatePlan(plan)
  for (const [platform, record] of Object.entries({android, ios})) {
    if (record.releaseSetId !== plan.releaseSetId) throw new Error(`${platform} result belongs to another release set`)
  }
  return {
    schemaVersion: 1,
    releaseSetId: plan.releaseSetId,
    publications: {
      mentraos: {...android.publications.mentraos, ...ios.publications.mentraos},
    },
    artifacts: [...android.artifacts, ...ios.artifacts],
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
  const command = process.argv[2]
  const args = parseArgs(process.argv.slice(3))
  const plan = readJson(path.resolve(args.plan))
  let record
  if (command === "create-android") {
    record = createAndroidRecord({
      plan,
      apk: path.resolve(args.apk),
      apkUrl: args["apk-url"],
      aab: path.resolve(args.aab),
      aabUrl: args["aab-url"],
      playTrack: args["play-track"],
      storeStatus: args.status,
      provenanceUrl: args["provenance-url"],
    })
  } else if (command === "create-ios") {
    record = createIosRecord({
      plan,
      ipa: path.resolve(args.ipa),
      ipaUrl: args["ipa-url"],
      testflightGroup: args["testflight-group"],
      storeStatus: args.status,
      provenanceUrl: args["provenance-url"],
    })
  } else if (command === "merge") {
    record = mergeMobileRecords({plan, android: readJson(args.android), ios: readJson(args.ios)})
  } else {
    throw new Error(`Unknown command ${JSON.stringify(command)}`)
  }
  writeFileSync(args.output, serializeReleaseRecord(record))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
