#!/usr/bin/env node
import {createHash} from "node:crypto"
import {readFileSync, writeFileSync} from "node:fs"
import path from "node:path"

import {serializeReleaseRecord} from "./release-family.mjs"

const input = path.resolve(process.argv[2] || "asg_client/ota_manifests/firmware_live.json")
const output = path.resolve(process.argv[3] || "ota-release-inputs.json")
const bytes = readFileSync(input)
const manifest = JSON.parse(bytes.toString("utf8"))

if (!Array.isArray(manifest.mtk_patches) || !manifest.bes_firmware) {
  throw new Error(`${input} must contain mtk_patches and bes_firmware`)
}

const result = {
  firmwareManifest: {
    path: path.relative(process.cwd(), input),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  },
  mtkPatches: manifest.mtk_patches,
  besFirmware: manifest.bes_firmware,
}

writeFileSync(output, serializeReleaseRecord(result))
console.log(`Wrote OTA release inputs to ${output}`)
