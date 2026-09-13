#!/usr/bin/env node
import {readFileSync, writeFileSync} from "node:fs"
import path from "node:path"

import {nativeBuildNumberForFamily} from "./native-build-numbers.mjs"
import {channelForBranch, createReleasePlan, loadReleaseFamily, serializeReleaseRecord} from "./release-family.mjs"

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
const plan = createReleasePlan({
  family,
  channel,
  sequence,
  sourceCommit: args["source-commit"],
  nativeBuildNumber:
    args["native-build-number"] === undefined
      ? nativeBuildNumberForFamily(family.familyBaseVersion, sequence)
      : Number(args["native-build-number"]),
  otaInputs,
  // Keep dev APK/AAB downloads while dev uploads to internal Play are paused.
  uploadGooglePlay: channel !== "dev",
  publicBetaTestflight: args["public-beta-testflight"] === "true",
})
const output = path.resolve(args.output || "release-plan.json")
writeFileSync(output, serializeReleaseRecord(plan))
console.log(`Wrote ${plan.releaseSetId} plan to ${output}`)
