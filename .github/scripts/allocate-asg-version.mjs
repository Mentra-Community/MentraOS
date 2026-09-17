#!/usr/bin/env node
import {readFileSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {
  BUILD_NUMBER_RELEASE_SEQUENCE_LIMIT,
  familyBuildNumberPrefix,
  familyBuildNumberWindow,
} from "./release-family.mjs"

const ASSET_PATTERN = /^mentra-live-asg-(\d+)-([0-9a-f]{64})\.(apk|json)$/
// ASG version codes use the family build-number formula shared with the Mentra
// App (see release-family.mjs): MAJOR*100_000_000 + MINOR*1_000_000 +
// PATCH*10_000 + SEQUENCE. An ASG rebuilt in a coordinated run takes exactly
// the build number that run reserved for its family, so it carries the same
// number as the app built in that run; a fingerprint already built keeps its
// recorded code. Assets outside the family window belong to older schemes and
// are ignored.

export function asgVersionCodePrefix(baseVersion) {
  return familyBuildNumberPrefix(baseVersion)
}

// Reuse the published pair for this fingerprint, or take exactly the build
// number the run reserved for its family (the plan's native build number). A
// pull-request selection passes no build number: it only asks whether a
// coordinated pair can be reused.
export function allocateAsgVersion({assets, fingerprint, baseVersion, buildNumber = null}) {
  if (!Array.isArray(assets)) throw new Error("GitHub release assets must be an array")
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new Error("Invalid ASG fingerprint")
  const window = familyBuildNumberWindow(baseVersion)
  const recognized = assets.flatMap((asset) => {
    const match = ASSET_PATTERN.exec(asset.name ?? "")
    if (!match) return []
    const versionCode = Number(match[1])
    if (versionCode < window.first || versionCode > window.last) return []
    return [{id: asset.id, name: asset.name, versionCode, fingerprint: match[2], type: match[3]}]
  })
  const matching = recognized.filter((asset) => asset.fingerprint === fingerprint)
  const apks = matching.filter((asset) => asset.type === "apk")
  const provenance = matching.filter((asset) => asset.type === "json")
  if (apks.length > 1 || provenance.length > 1) throw new Error("Duplicate immutable ASG release assets found")
  if (apks.length === 1 && provenance.length === 1) {
    if (apks[0].versionCode !== provenance[0].versionCode) {
      throw new Error("ASG artifact and provenance use different version codes")
    }
    return {
      exists: true,
      versionCode: apks[0].versionCode,
      apkAsset: apks[0].name,
      provenanceAsset: provenance[0].name,
      orphanAssetIds: [],
    }
  }
  if (buildNumber === null) {
    return {
      exists: false,
      versionCode: null,
      apkAsset: null,
      provenanceAsset: null,
      orphanAssetIds: matching.map((asset) => asset.id),
    }
  }
  if (!Number.isSafeInteger(buildNumber) || buildNumber < window.first || buildNumber > window.last) {
    throw new Error(`Build number ${buildNumber} does not belong to base version ${baseVersion}`)
  }
  if (buildNumber - window.prefix > BUILD_NUMBER_RELEASE_SEQUENCE_LIMIT) {
    throw new Error(`Build number ${buildNumber} is outside the release band of base version ${baseVersion}`)
  }
  const taken = recognized.find((asset) => asset.versionCode === buildNumber && asset.fingerprint !== fingerprint)
  if (taken) {
    throw new Error(`ASG versionCode ${buildNumber} is already used by ${taken.name}`)
  }
  return {
    exists: false,
    versionCode: buildNumber,
    apkAsset: `mentra-live-asg-${buildNumber}-${fingerprint}.apk`,
    provenanceAsset: `mentra-live-asg-${buildNumber}-${fingerprint}.json`,
    orphanAssetIds: matching.map((asset) => asset.id),
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
  const result = allocateAsgVersion({
    assets: JSON.parse(readFileSync(path.resolve(args.assets), "utf8")),
    fingerprint: args.fingerprint,
    baseVersion: args["base-version"],
    buildNumber: args["build-number"] !== undefined ? Number(args["build-number"]) : null,
  })
  writeFileSync(path.resolve(args.output), `${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
