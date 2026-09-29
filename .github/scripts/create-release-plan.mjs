#!/usr/bin/env node
import {readFileSync, writeFileSync} from "node:fs"
import path from "node:path"

import {
  channelForBranch,
  createReleasePlan,
  familyBuildNumber,
  loadReleaseFamily,
  serializeReleaseRecord,
} from "./release-family.mjs"

function parseArgs(args) {
  const values = {}
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]
    const value = args[index + 1]
    if (!option?.startsWith("--") || value === undefined) throw new Error("Expected --name value pairs")
    const name = option.slice(2)
    if (values[name] !== undefined) throw new Error(`Duplicate option --${name}`)
    values[name] = value
  }
  return values
}

const args = parseArgs(process.argv.slice(2))
const channel = args.channel || channelForBranch(args.branch)
const sequence = channel === "production" ? undefined : Number(args.sequence)
const otaInputs = args["ota-inputs"] ? JSON.parse(readFileSync(path.resolve(args["ota-inputs"]), "utf8")) : {}
const family = loadReleaseFamily({requireVersionMirrors: args["require-version-mirrors"] === "true"})
if ((args["native-build-sequence"] === undefined) === (args["native-build-number"] === undefined)) {
  throw new Error("Pass exactly one of --native-build-sequence (a coordinated run number) or --native-build-number")
}
const nativeBuildNumber =
  args["native-build-sequence"] !== undefined
    ? familyBuildNumber(family.familyBaseVersion, Number(args["native-build-sequence"]))
    : Number(args["native-build-number"])
const plan = createReleasePlan({
  family,
  channel,
  sequence,
  sourceCommit: args["source-commit"],
  nativeBuildNumber,
  otaInputs,
  // Keep dev APK/AAB downloads while dev uploads to internal Play are paused.
  uploadGooglePlay: channel !== "dev",
  publicBetaTestflight: args["public-beta-testflight"] === "true",
  ...(args["play-track"] ? {playTrack: args["play-track"]} : {}),
})
const output = path.resolve(args.output || "release-plan.json")
writeFileSync(output, serializeReleaseRecord(plan))
console.log(`Wrote ${plan.releaseSetId} plan to ${output}`)
