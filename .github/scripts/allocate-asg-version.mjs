#!/usr/bin/env node
import {readFileSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

const ASSET_PATTERN = /^mentra-live-asg-(\d+)-([0-9a-f]{64})\.(apk|json)$/
// ASG version codes are derived from the family base version so the code and
// the versionName describe the same release: MAJOR*100_000_000 +
// MINOR*1_000_000 + PATCH*10_000 + SEQUENCE, where SEQUENCE counts the distinct
// ASG builds of that base version (1..9999). Two legacy namespaces sit below
// it: the original publisher allocated seconds since 2025-01-01 (below 60
// million) and the first coordinated allocator used 100_000_000 + run number.
// Requiring MAJOR >= 2 keeps every derived code above both, so the first
// derived build of any family is still an upgrade for every glasses in the
// field, and MAJOR <= 20 keeps it inside the Android-safe range.
const BASE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
const MAJOR_WEIGHT = 100_000_000
const MINOR_WEIGHT = 1_000_000
const PATCH_WEIGHT = 10_000
const MAX_SEQUENCE = PATCH_WEIGHT - 1

export function asgVersionCodePrefix(baseVersion) {
  const match = BASE_VERSION_PATTERN.exec(baseVersion || "")
  if (!match) throw new Error(`ASG base version ${JSON.stringify(baseVersion)} must be a plain X.Y.Z version`)
  const [major, minor, patch] = match.slice(1).map(Number)
  if (major < 2 || major > 20) throw new Error(`ASG base version major ${major} must be between 2 and 20`)
  if (minor > 99 || patch > 99) throw new Error("ASG base version minor and patch must be at most 99")
  return major * MAJOR_WEIGHT + minor * MINOR_WEIGHT + patch * PATCH_WEIGHT
}

export function allocateAsgVersion({assets, fingerprint, baseVersion}) {
  if (!Array.isArray(assets)) throw new Error("GitHub release assets must be an array")
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new Error("Invalid ASG fingerprint")
  const prefix = asgVersionCodePrefix(baseVersion)
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
    // The versionName is part of the fingerprint, so a complete pair for this
    // fingerprint was built for this base version and must carry its prefix.
    if (apks[0].versionCode - prefix < 1 || apks[0].versionCode - prefix > MAX_SEQUENCE) {
      throw new Error(`Existing ASG versionCode ${apks[0].versionCode} does not belong to base version ${baseVersion}`)
    }
    return {
      exists: true,
      versionCode: apks[0].versionCode,
      apkAsset: apks[0].name,
      provenanceAsset: provenance[0].name,
      orphanAssetIds: [],
    }
  }
  const usedSequences = recognized
    .map((asset) => asset.versionCode - prefix)
    .filter((sequence) => sequence >= 1 && sequence <= MAX_SEQUENCE)
  const sequence = usedSequences.length === 0 ? 1 : Math.max(...usedSequences) + 1
  if (sequence > MAX_SEQUENCE) throw new Error(`Base version ${baseVersion} has exhausted its ASG version codes`)
  const versionCode = prefix + sequence
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
    baseVersion: args["base-version"],
  })
  writeFileSync(path.resolve(args.output), `${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
