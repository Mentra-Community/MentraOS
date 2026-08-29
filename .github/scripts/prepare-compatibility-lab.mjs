#!/usr/bin/env node
import {readFileSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {createReleasePlan, loadReleaseFamily, serializeReleaseRecord} from "./release-family.mjs"
import {validatePromotionRecord} from "./production-promotion-state.mjs"

export function prepareCompatibilityLabPlan({root, record, previousPlan}) {
  validatePromotionRecord(record)
  if (record.state !== "selected") throw new Error("Compatibility lab can only be prepared from selected")
  if (
    previousPlan.channel !== "production" ||
    previousPlan.sourceCommit !== record.coordinates.currentMentraApp.sourceCommit ||
    previousPlan.native?.marketingVersion !== record.coordinates.currentMentraApp.ios.marketingVersion
  ) {
    throw new Error("Current production release plan does not match the public Mentra App provenance")
  }
  const buildNumber = record.coordinates.compatibilityLab.ios.buildNumber
  if (buildNumber !== record.coordinates.compatibilityLab.android.buildNumber) {
    throw new Error("Compatibility lab platforms must share one allocated build number")
  }
  const plan = createReleasePlan({
    family: loadReleaseFamily({rootDir: root, requireVersionMirrors: true}),
    channel: "beta",
    sequence: buildNumber,
    sourceCommit: record.coordinates.currentMentraApp.sourceCommit,
    nativeBuildNumber: buildNumber,
    otaInputs: previousPlan.otaInputs,
  })
  plan.compatibilityLab = {
    promotionId: record.promotionId,
    targetCloudSource: record.source.mentraosCommit,
    runtimeLabel: `${plan.releaseIdentity}-COMPATIBILITY-LAB-NOT-FOR-PRODUCTION`,
    nonPromotable: true,
    iosDistribution: "testflight-internal-only",
    androidDistribution: "google-play-internal-app-sharing",
  }
  return plan
}

function parseArgs(args) {
  const values = {}
  for (let index = 0; index < args.length; index += 2) {
    if (!args[index]?.startsWith("--") || args[index + 1] === undefined) throw new Error("Expected --name value pairs")
    values[args[index].slice(2)] = args[index + 1]
  }
  return values
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const plan = prepareCompatibilityLabPlan({
    root: path.resolve(args.root),
    record: JSON.parse(readFileSync(path.resolve(args.record), "utf8")),
    previousPlan: JSON.parse(readFileSync(path.resolve(args["previous-plan"]), "utf8")),
  })
  writeFileSync(path.resolve(args.output), serializeReleaseRecord(plan))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
