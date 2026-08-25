#!/usr/bin/env node
import {createHash} from "node:crypto"
import {readFileSync, statSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {serializeReleaseRecord} from "./release-family.mjs"

function mergeRecords(plan, records) {
  const publications = {}
  const artifacts = []
  for (const record of records) {
    if (record.releaseSetId !== plan.releaseSetId) throw new Error("Production record belongs to another release set")
    for (const [member, targets] of Object.entries(record.publications || {})) {
      publications[member] ||= {}
      for (const [target, publication] of Object.entries(targets)) {
        if (publications[member][target]) throw new Error(`Duplicate production publication ${member}:${target}`)
        publications[member][target] = publication
      }
    }
    artifacts.push(...(record.artifacts || []))
  }
  for (const [member, definition] of Object.entries(plan.members)) {
    for (const target of definition.publishTargets) {
      if (!publications[member]?.[target]) throw new Error(`Missing production publication ${member}:${target}`)
    }
  }
  return {publications, artifacts}
}

export function assembleProductionReleaseResults({plan, npmRecords, native, promotion, enginePackage, assetBaseUrl}) {
  if (
    plan.channel !== "production" ||
    promotion.promotion?.selectedBetaReleaseSetId !== plan.promotion?.selectedBetaReleaseSetId
  ) {
    throw new Error("Production plan and promotion record do not select the same beta")
  }
  const merged = mergeRecords(plan, [...npmRecords, native, promotion])
  const enginePublication = merged.publications["@mentra/engine"]?.npm
  const bytes = readFileSync(enginePackage)
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  if (sha256 !== enginePublication?.sha256) throw new Error("Stable Engine release asset differs from npm publication")
  merged.artifacts.push({
    status: enginePublication.status,
    coordinate: plan.artifactNames.enginePackage,
    url: `${assetBaseUrl}/${plan.artifactNames.enginePackage}`,
    sha256,
    size: statSync(enginePackage).size,
    provenanceUrl: enginePublication.provenanceUrl,
  })
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
