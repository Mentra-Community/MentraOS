#!/usr/bin/env node
// Allocates the one build number a coordinated run, a production promotion or
// the production example uses for its family: the next free sequence above
// every number already recorded for the family, either as a
// `mentra-build-number-<code>.json` marker in the family's build container or
// as an ASG client pair `mentra-live-asg-<code>-<fingerprint>.(apk|json)` in
// the shared ASG release (numbers taken before markers existed, seen on the
// 3.2.0 family: runs 34904296139 and 34904687939 collided with them). The
// caller passes the assets of both releases. Sequences restart at 1 for every
// family; see https://github.com/Mentra-Community/Mentra-Specs/blob/main/platform/releases/family-build-numbers/spec.md.
//
// A marker names the owner of the reservation (a coordinated run, a promotion
// attempt's candidate or lab, an example release). Two owners choosing the same
// number produce different bytes, so the immutable publisher refuses the
// second; the same owner retrying republishes identical bytes. An owner that
// finds its own marker among the downloaded ones reuses that number instead of
// allocating again, which keeps a partially published attempt consistent.
import {mkdirSync, readdirSync, readFileSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

import {BUILD_NUMBER_RELEASE_SEQUENCE_LIMIT, familyBuildNumberWindow} from "./release-family.mjs"

const MARKER_PATTERN = /^mentra-build-number-(\d+)\.json$/
const ASG_PAIR_PATTERN = /^mentra-live-asg-(\d+)-[0-9a-f]{64}\.(?:apk|json)$/
const OWNER_PATTERN = /^[a-z][a-z0-9-]*:[A-Za-z0-9._:-]{1,120}$/

export function markerAssetName(buildNumber) {
  return `mentra-build-number-${buildNumber}.json`
}

export function requireOwner(owner) {
  if (!OWNER_PATTERN.test(owner || "")) throw new Error(`Invalid build number owner ${JSON.stringify(owner)}`)
  return owner
}

export function recordedFamilyBuildNumbers(assets, baseVersion) {
  if (!Array.isArray(assets)) throw new Error("GitHub release assets must be an array")
  const window = familyBuildNumberWindow(baseVersion)
  const numbers = new Set()
  for (const asset of assets) {
    const match = MARKER_PATTERN.exec(asset?.name ?? "") ?? ASG_PAIR_PATTERN.exec(asset?.name ?? "")
    if (!match) continue
    const code = Number(match[1])
    if (code >= window.first && code <= window.last) numbers.add(code)
  }
  return [...numbers].sort((left, right) => left - right)
}

export function familyBuildNumberMarker({baseVersion, buildNumber, owner}) {
  const window = familyBuildNumberWindow(baseVersion)
  if (!Number.isSafeInteger(buildNumber) || buildNumber < window.first || buildNumber > window.last) {
    throw new Error(`Build number ${buildNumber} does not belong to family ${baseVersion}`)
  }
  return {
    schemaVersion: 1,
    kind: "mentra-family-build-number",
    familyBaseVersion: baseVersion,
    buildNumber,
    sequence: buildNumber - window.prefix,
    owner: requireOwner(owner),
  }
}

export function validateMarker(marker, baseVersion) {
  if (marker?.schemaVersion !== 1 || marker.kind !== "mentra-family-build-number")
    throw new Error("Not a family build number marker")
  if (marker.familyBaseVersion !== baseVersion) throw new Error(`Marker belongs to family ${marker.familyBaseVersion}`)
  return familyBuildNumberMarker({baseVersion, buildNumber: marker.buildNumber, owner: marker.owner})
}

// `markers` are the contents of markers already downloaded from the container
// (any subset; the caller decides which ones are worth reading). One owned by
// `owner` is this allocation's own earlier reservation and is reused.
export function allocateFamilyBuildNumber({assets, baseVersion, owner, markers = []}) {
  requireOwner(owner)
  const window = familyBuildNumberWindow(baseVersion)
  const owned = markers.map((marker) => validateMarker(marker, baseVersion)).filter((marker) => marker.owner === owner)
  if (owned.length > 1) throw new Error(`${owner} owns more than one build number of family ${baseVersion}`)
  if (owned.length === 1) {
    return {
      familyBaseVersion: baseVersion,
      buildNumber: owned[0].buildNumber,
      sequence: owned[0].sequence,
      owner,
      reused: true,
    }
  }
  const recorded = recordedFamilyBuildNumbers(assets, baseVersion)
  const buildNumber = recorded.length === 0 ? window.first : recorded.at(-1) + 1
  const sequence = buildNumber - window.prefix
  if (sequence > BUILD_NUMBER_RELEASE_SEQUENCE_LIMIT) {
    throw new Error(`Family ${baseVersion} has exhausted its release build numbers`)
  }
  return {familyBaseVersion: baseVersion, buildNumber, sequence, owner, reused: false}
}

export function readMarkersDirectory(directory) {
  if (!directory) return []
  return readdirSync(directory)
    .filter((name) => MARKER_PATTERN.test(name))
    .map((name) => JSON.parse(readFileSync(path.join(directory, name), "utf8")))
}

export function writeMarker(directory, marker) {
  mkdirSync(directory, {recursive: true})
  const file = path.join(directory, markerAssetName(marker.buildNumber))
  writeFileSync(file, `${JSON.stringify(marker, null, 2)}\n`)
  return file
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
  if (command === "allocate") {
    const result = allocateFamilyBuildNumber({
      assets: JSON.parse(readFileSync(path.resolve(args.assets), "utf8")),
      baseVersion: args["base-version"],
      owner: args.owner,
      markers: readMarkersDirectory(args["markers-dir"]),
    })
    writeFileSync(path.resolve(args.output), `${JSON.stringify(result, null, 2)}\n`)
    console.log(
      `${result.reused ? "Reusing" : "Allocated"} ${result.familyBaseVersion} build number ${result.buildNumber} (sequence ${result.sequence}) for ${result.owner}`,
    )
    return
  }
  if (command === "marker") {
    const marker = familyBuildNumberMarker({
      baseVersion: args["base-version"],
      buildNumber: Number(args["build-number"]),
      owner: args.owner,
    })
    console.log(writeMarker(path.resolve(args["output-dir"]), marker))
    return
  }
  throw new Error(`Unknown family build number command ${JSON.stringify(command)}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
