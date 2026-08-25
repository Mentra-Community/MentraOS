#!/usr/bin/env node
import {readFileSync, writeFileSync} from "node:fs"
import path from "node:path"

import {finalizeReleaseManifest, serializeReleaseRecord} from "./release-family.mjs"

function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing --${name}`)
  return process.argv[index + 1]
}

const plan = JSON.parse(readFileSync(path.resolve(option("plan")), "utf8"))
const results = JSON.parse(readFileSync(path.resolve(option("results")), "utf8"))
const manifest = finalizeReleaseManifest({plan, results, completedAt: option("completed-at")})
const output = path.resolve(option("output"))
writeFileSync(output, serializeReleaseRecord(manifest))
console.log(`Wrote completed ${manifest.releaseSetId} manifest to ${output}`)
