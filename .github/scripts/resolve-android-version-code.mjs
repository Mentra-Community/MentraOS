#!/usr/bin/env node
// The Android version code a coordinated build carries on Google Play.
//
// Play refuses a release on a track whose served release has a higher version
// code, and the family formula sits below the codes the `beta` and `internal`
// tracks served before the formula existed (310000212 and 900000002; see
// notes/superpowers/specs/2026-09-14-family-build-numbers.md). Until a family
// passes those floors, a build for a testing track takes the track's highest
// code plus one; iOS and the ASG client keep the family number. Production
// keeps the family number: preparation already requires it above the served
// production release. Internal App Sharing has no floor.
import {readFileSync, writeFileSync} from "node:fs"
import path from "node:path"
import {fileURLToPath} from "node:url"

const FAMILY_NUMBER_TRACKS = new Set(["production", "internal-app-sharing"])

export function resolveAndroidVersionCode({planBuildNumber, track, trackCodes = []}) {
  if (!Number.isSafeInteger(planBuildNumber) || planBuildNumber < 1) {
    throw new Error(`Invalid plan build number ${JSON.stringify(planBuildNumber)}`)
  }
  if (typeof track !== "string" || track.length === 0) throw new Error("A Google Play track is required")
  const codes = trackCodes.map((code) => Number(code))
  if (codes.some((code) => !Number.isSafeInteger(code) || code < 1)) {
    throw new Error(`Track ${track} reports an invalid version code`)
  }
  if (FAMILY_NUMBER_TRACKS.has(track) || codes.length === 0) {
    return {versionCode: planBuildNumber, source: "family"}
  }
  const floor = Math.max(...codes)
  if (floor < planBuildNumber) return {versionCode: planBuildNumber, source: "family"}
  return {versionCode: floor + 1, source: "track-floor", floor}
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
  const plan = JSON.parse(readFileSync(path.resolve(args.plan), "utf8"))
  const trackCodes = args.codes ? JSON.parse(readFileSync(path.resolve(args.codes), "utf8")) : []
  const result = resolveAndroidVersionCode({planBuildNumber: plan.native.buildNumber, track: args.track, trackCodes})
  writeFileSync(path.resolve(args.output), `${JSON.stringify(result, null, 2)}\n`)
  console.log(
    result.source === "family"
      ? `Android version code ${result.versionCode} (the family build number)`
      : `Android version code ${result.versionCode} (track ${args.track} serves ${result.floor}, above the family build number ${plan.native.buildNumber})`,
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
