#!/usr/bin/env node
import {readFileSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

const ASSET_PATTERN = /^mentra-live-asg-(\d+)-([0-9a-f]{64})\.(apk|json)$/
// The legacy publisher allocated seconds since 2025-01-01 and had already crossed
// 50 million before this allocator replaced it. Keep the coordinated namespace
// permanently above that range so the first cutover build is always an upgrade.
const COORDINATED_VERSION_CODE_BASELINE = 100_000_000

export function allocateAsgVersion({assets, fingerprint, runNumber}) {
  if (!Array.isArray(assets)) throw new Error("GitHub release assets must be an array")
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new Error("Invalid ASG fingerprint")
  if (!Number.isSafeInteger(runNumber) || runNumber <= 0) throw new Error("runNumber must be a positive integer")

  const recognized = assets.flatMap((asset) => {
    const match = ASSET_PATTERN.exec(asset.name ?? "")
    if (!match) return []
    return [{id: asset.id, name: asset.name, versionCode: Number(match[1]), fingerprint: match[2], type: match[3]}]
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

  const maxRecordedVersionCode = recognized.reduce((maximum, asset) => Math.max(maximum, asset.versionCode), 0)
  const versionCode = Math.max(COORDINATED_VERSION_CODE_BASELINE + runNumber, maxRecordedVersionCode + 1)
  if (versionCode > 2_100_000_000) throw new Error("Allocated ASG versionCode exceeds the Android-safe range")
  return {
    exists: false,
    versionCode,
    apkAsset: `mentra-live-asg-${versionCode}-${fingerprint}.apk`,
    provenanceAsset: `mentra-live-asg-${versionCode}-${fingerprint}.json`,
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
    runNumber: Number(args["run-number"]),
  })
  writeFileSync(path.resolve(args.output), `${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
