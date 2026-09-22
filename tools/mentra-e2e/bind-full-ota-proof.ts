#!/usr/bin/env bun
import {parseArgs} from "node:util"
import {open} from "node:fs/promises"
import {dirname} from "node:path"
import {bindFullOtaProof} from "./runner/full-ota-proof"
import {absolute, json, reference, requireThat} from "./runner/day1-local-io"

export async function main(args: string[]) {
  const {values, positionals} = parseArgs({args, options: {config: {type: "string"}, sha256: {type: "string"}}})
  requireThat(
    positionals.length === 0 && values.config && values.sha256,
    "Usage: bun tools/mentra-e2e/bind-full-ota-proof.ts --config /private/binding.json --sha256 SHA256",
  )
  const input = await json({path: values.config, sha256: values.sha256}, true)
  requireThat(input.schemaVersion === 1, "Expected full OTA binding inputs schema 1")
  const result = await bindFullOtaProof(input)
  const outputPath = absolute(input.output)
  const file = await open(outputPath, "wx", 0o600)
  try {
    await file.writeFile(JSON.stringify(result, null, 2) + "\n")
    await file.sync()
  } finally {
    await file.close()
  }
  const directory = await open(dirname(outputPath), "r")
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
  const output = await reference(outputPath)
  console.log(
    JSON.stringify({status: "offline-proof-bound", output, hardwareStarted: false, hardwareQualification: "not-run"}),
  )
}

if (import.meta.main)
  main(Bun.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : "Proof binding failed")
    process.exitCode = 1
  })
