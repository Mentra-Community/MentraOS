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

function requireSize(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} size must be a positive integer`)
  }
}

if (manifest.bes_firmware.size !== undefined) requireSize(manifest.bes_firmware.size, "bes_firmware")
if (manifest.mtk_full_ota) requireSize(manifest.mtk_full_ota.size, "mtk_full_ota")
manifest.mtk_patches.forEach((patch, index) => {
  if (patch.size !== undefined) requireSize(patch.size, `mtk_patches[${index}]`)
})

const result = {
  firmwareManifest: {
    path: path.relative(process.cwd(), input),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  },
  mtkPatches: manifest.mtk_patches,
  ...(manifest.mtk_full_ota ? {mtkFullOta: manifest.mtk_full_ota} : {}),
  besFirmware: manifest.bes_firmware,
}

writeFileSync(output, serializeReleaseRecord(result))
console.log(`Wrote OTA release inputs to ${output}`)
