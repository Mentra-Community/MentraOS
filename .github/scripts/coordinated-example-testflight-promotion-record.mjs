#!/usr/bin/env node
import {readFileSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {serializeReleaseRecord} from "./release-family.mjs"

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`)
  return value
}

export function createExampleTestflightPromotionRecord({
  plan,
  betaManifest,
  appId,
  bundleId,
  buildId,
  groupId,
  groupName,
  installUrl,
  provenanceUrl,
}) {
  const betaTestflight = betaManifest?.starterKit?.testflight
  if (
    plan?.channel !== "production" ||
    plan.promotion?.selectedBetaReleaseSetId !== betaManifest?.releaseSetId ||
    plan.promotion?.selectedBetaIdentity !== betaManifest?.releaseIdentity ||
    betaTestflight?.releaseSetId !== betaManifest.releaseSetId ||
    betaTestflight.build?.processingState !== "VALID" ||
    betaTestflight.version?.marketingVersion !== plan.native?.marketingVersion ||
    betaTestflight.version?.buildNumber !== plan.native?.buildNumber
  ) {
    throw new Error("Selected beta TestFlight build does not match the production plan")
  }
  if (buildId !== betaTestflight.build.id) throw new Error("Promoted TestFlight build differs from the selected beta")
  if (appId !== "6792839366" || appId !== betaTestflight.app?.id) throw new Error("Unexpected App Store Connect app")
  if (bundleId !== "com.mentra.bluetoothsdkexample" || bundleId !== betaTestflight.app?.bundleId) {
    throw new Error("Unexpected example app bundle ID")
  }
  if (groupName !== "Mentra Production Public") throw new Error("Unexpected production TestFlight group")
  if (!/^https:\/\/testflight\.apple\.com\/join\//.test(installUrl || "")) {
    throw new Error("Production TestFlight group must have a public invitation link")
  }
  if (!/^https:\/\//.test(provenanceUrl || "")) throw new Error("TestFlight provenance URL must use HTTPS")

  return {
    schemaVersion: 1,
    releaseSetId: plan.releaseSetId,
    releaseIdentity: plan.releaseIdentity,
    channel: "production",
    selectedBetaReleaseSetId: betaManifest.releaseSetId,
    selectedBetaIdentity: betaManifest.releaseIdentity,
    app: {id: appId, bundleId},
    version: {
      marketingVersion: plan.native.marketingVersion,
      buildNumber: plan.native.buildNumber,
    },
    build: {
      id: buildId,
      processingState: "VALID",
      sourceTestflightProvenanceUrl: requiredString(betaTestflight.provenanceUrl, "beta TestFlight provenance URL"),
    },
    group: {id: requiredString(groupId, "production TestFlight group ID"), name: groupName},
    distribution: {audience: "external", status: "available", reviewState: "APPROVED", installUrl},
    provenanceUrl,
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
  const record = createExampleTestflightPromotionRecord({
    plan: JSON.parse(readFileSync(path.resolve(args.plan), "utf8")),
    betaManifest: JSON.parse(readFileSync(path.resolve(args["beta-manifest"]), "utf8")),
    appId: args["app-id"],
    bundleId: args["bundle-id"],
    buildId: args["build-id"],
    groupId: args["group-id"],
    groupName: args["group-name"],
    installUrl: args["install-url"],
    provenanceUrl: args["provenance-url"],
  })
  writeFileSync(path.resolve(args.output), serializeReleaseRecord(record))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
