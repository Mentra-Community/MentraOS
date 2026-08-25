#!/usr/bin/env node
import {readFileSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {serializeReleaseRecord} from "./release-family.mjs"
import {createEnginePackageArtifact, mergeReleaseResultRecords} from "./release-result-records.mjs"

export function assembleProductionReleaseResults({plan, npmRecords, native, promotion, enginePackage, assetBaseUrl}) {
  if (
    plan.channel !== "production" ||
    promotion.promotion?.selectedBetaReleaseSetId !== plan.promotion?.selectedBetaReleaseSetId
  ) {
    throw new Error("Production plan and promotion record do not select the same beta")
  }
  const merged = mergeReleaseResultRecords({plan, records: [...npmRecords, native, promotion]})
  merged.artifacts.push(
    createEnginePackageArtifact({
      plan,
      publications: merged.publications,
      packageFile: enginePackage,
      assetBaseUrl,
    }),
  )
  return {
    schemaVersion: 1,
    releaseSetId: plan.releaseSetId,
    promotion: promotion.promotion,
    publications: merged.publications,
    otaManifest: promotion.otaManifest,
    artifacts: merged.artifacts,
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

function readJson(file) {
  return JSON.parse(readFileSync(path.resolve(file), "utf8"))
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const result = assembleProductionReleaseResults({
    plan: readJson(args.plan),
    npmRecords: [args["npm-foundation"], args["npm-sdk"], args["npm-miniapp"], args["npm-engine"]].map(readJson),
    native: readJson(args.native),
    promotion: readJson(args.promotion),
    enginePackage: path.resolve(args["engine-package"]),
    assetBaseUrl: args["asset-base-url"],
  })
  writeFileSync(path.resolve(args.output), serializeReleaseRecord(result))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
