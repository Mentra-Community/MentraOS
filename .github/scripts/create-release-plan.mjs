#!/usr/bin/env node
import {readFileSync, writeFileSync} from "node:fs"
import path from "node:path"

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
  nativeBuildNumber: Number(args["native-build-number"]),
  otaInputs,
})
const output = path.resolve(args.output || "release-plan.json")
writeFileSync(output, serializeReleaseRecord(plan))
console.log(`Wrote ${plan.releaseSetId} plan to ${output}`)
