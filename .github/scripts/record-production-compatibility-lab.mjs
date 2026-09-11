#!/usr/bin/env node
import {readFileSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {releaseRecordSha256, serializeReleaseRecord} from "./release-family.mjs"
import {validatePromotionRecord} from "./production-promotion-state.mjs"

function fail(message) {
  throw new Error(`Invalid production compatibility lab result: ${message}`)
}

function requireHttps(value, label) {
  let url
  try {
    url = new URL(value)
  } catch {
    fail(`${label} must be an HTTPS URL`)
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    fail(`${label} must be credential-free HTTPS without a fragment`)
  }
  return url.toString()
}

function requireSha256(value, label) {
  if (!/^[0-9a-f]{64}$/.test(value || "")) fail(`${label} must be a lowercase SHA-256 digest`)
  return value
}

export function createCompatibilityLabEvidence({record, plan, mobile, internalSharing, createdAt, provenanceUrl}) {
  validatePromotionRecord(record)
  if (record.state !== "selected") fail("promotion must still be selected")
  if (record.evidence.some((item) => item.kind === "staging-mobile-n-compatibility-lab")) {
    fail("compatibility lab evidence is already recorded")
  }
  const lab = plan.compatibilityLab
  const buildNumber = record.coordinates.compatibilityLab.ios.buildNumber
  const expectedReleaseSet = `mentra-${plan.releaseIdentity}`
  if (
    plan.channel !== "beta" ||
    plan.sourceCommit !== record.coordinates.currentMentraApp.sourceCommit ||
    plan.native?.marketingVersion !== record.coordinates.currentMentraApp.ios.marketingVersion ||
    plan.native?.buildNumber !== buildNumber ||
    plan.releaseSetId !== expectedReleaseSet ||
    lab?.promotionId !== record.promotionId ||
    lab?.targetCloudSource !== record.source.mentraosCommit ||
    lab?.nonPromotable !== true ||
    lab?.iosDistribution !== "testflight-internal-only" ||
    lab?.androidDistribution !== "google-play-internal-app-sharing"
  ) {
    fail("release plan is not the frozen non-promotable lab plan")
  }
  if (mobile.releaseSetId !== plan.releaseSetId) fail("mobile result belongs to another release plan")
  const apple = mobile.publications?.mentraos?.["app-store-connect"]
  const google = mobile.publications?.mentraos?.["google-play"]
  const expectedApple = `com.mentra.mentra:${plan.native.marketingVersion}:${buildNumber}:Mentra Compatibility Lab`
  const expectedGoogle = `com.mentra.mentra:${buildNumber}:internal-app-sharing`
  if (apple?.coordinate !== expectedApple || apple.status !== "published") {
    fail("App Store Connect result does not identify the exact compatibility-lab build and group")
  }
  if (google?.coordinate !== expectedGoogle || google.status !== "published") {
    fail("Google Play result does not identify the exact internal-sharing build")
  }
  const aab = mobile.artifacts?.find((artifact) => artifact.coordinate === plan.artifactNames?.androidStoreApp)
  const ipa = mobile.artifacts?.find((artifact) => artifact.coordinate === plan.artifactNames?.iosApp)
  if (!aab || !ipa) fail("mobile result is missing exact AAB or IPA evidence")
  const aabSha256 = requireSha256(aab.sha256, "AAB digest")
  const ipaSha256 = requireSha256(ipa.sha256, "IPA digest")
  if (requireSha256(internalSharing.sha256, "internal-sharing digest") !== aabSha256) {
    fail("Google Play internal-sharing digest does not match the built AAB")
  }
  if (
    typeof internalSharing.certificateFingerprint !== "string" ||
    internalSharing.certificateFingerprint.length > 200 ||
    !/^[A-Fa-f0-9:]+$/.test(internalSharing.certificateFingerprint)
  ) {
    fail("Google Play did not return a valid signing certificate fingerprint")
  }
  if (Number.isNaN(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) {
    fail("createdAt must be an ISO-8601 UTC timestamp")
  }
  return {
    schemaVersion: 1,
    kind: "mentra-production-compatibility-lab",
    promotionId: record.promotionId,
    releaseIdentity: record.releaseIdentity,
    createdAt,
    provenanceUrl: requireHttps(provenanceUrl, "provenanceUrl"),
    source: {
      mobileNCommit: plan.sourceCommit,
      cloudNPlusOneCommit: lab.targetCloudSource,
    },
    target: {environment: "staging", runtimeLabel: lab.runtimeLabel},
    plan: {releaseSetId: plan.releaseSetId, sha256: releaseRecordSha256(plan)},
    ios: {
      bundleId: "com.mentra.mentra",
      marketingVersion: plan.native.marketingVersion,
      buildNumber,
      distribution: lab.iosDistribution,
      testflightGroup: "Mentra Compatibility Lab",
      internalOnly: true,
      ipaSha256,
      provenanceUrl: requireHttps(apple.provenanceUrl, "Apple publication provenance"),
    },
    android: {
      packageName: "com.mentra.mentra",
      marketingVersion: plan.native.marketingVersion,
      buildNumber,
      distribution: lab.androidDistribution,
      downloadUrl: requireHttps(internalSharing.downloadUrl, "Google internal-sharing downloadUrl"),
      aabSha256,
      certificateFingerprint: internalSharing.certificateFingerprint,
      provenanceUrl: requireHttps(google.provenanceUrl, "Google publication provenance"),
    },
  }
}

function parseArgs(args) {
  const values = {}
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index]?.startsWith("--") || args[index + 1] === undefined) throw new Error("Expected --name value pairs")
    values[args[index].slice(2)] = args[index + 1]
  }
  return values
}

function readJson(file) {
  return JSON.parse(readFileSync(path.resolve(file), "utf8"))
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const result = createCompatibilityLabEvidence({
    record: readJson(args.record),
    plan: readJson(args.plan),
    mobile: readJson(args.mobile),
    internalSharing: readJson(args["internal-sharing"]),
    createdAt: args["created-at"],
    provenanceUrl: args["provenance-url"],
  })
  writeFileSync(path.resolve(args.output), serializeReleaseRecord(result))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
