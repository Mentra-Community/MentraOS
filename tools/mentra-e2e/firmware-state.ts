#!/usr/bin/env bun
import {createHash} from "node:crypto"
import {constants} from "node:fs"
import {open} from "node:fs/promises"
import {resolve} from "node:path"
import {parseArgs} from "node:util"
import {
  assertFirmwareState,
  normalizeBesVersion,
  parseFirmwareProfile,
  type FirmwareArtifact,
  type FirmwareFixture,
  type FirmwareObservation,
  type FirmwareProfile,
} from "./runner/firmware-profile"
import {normalizeFirmware} from "./runner/ota-state"

const HELP = `Offline firmware profile tools; no fetching, device access or installation.

bun firmware-state.ts freeze --manifest FILE --manifest-url HTTPS --manifest-sha256 SHA256 --output PROFILE.json
bun firmware-state.ts verify --profile PROFILE.json --fixture FILE --observation FILE --output RESULT.json

freeze checks the exact local manifest bytes against the supplied digest.
verify compares supplied JSON observations with the frozen profile and physical fixture.
It does not collect hardware evidence or establish that referenced evidence files are authentic.
Observations must be at most 30 seconds old. Output files are never overwritten.
`

const MAX_INPUT_BYTES = 4 * 1024 * 1024
const HASH = /^[a-f0-9]{64}$/
const CID = /^[a-f0-9]{32}$/i
const BLUETOOTH = /^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/i
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}

async function input(path: string) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) throw new Error("Input must be a regular file of at most 4 MiB")
    const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1)
    let size = 0
    while (size <= MAX_INPUT_BYTES) {
      const {bytesRead} = await handle.read(buffer, size, buffer.length - size, size)
      if (!bytesRead) break
      size += bytesRead
    }
    if (size > MAX_INPUT_BYTES) throw new Error("Input grew beyond the 4 MiB limit")
    const bytes = buffer.subarray(0, size)
    return {bytes, sha256: sha256(bytes)}
  } finally {
    await handle.close()
  }
}

function json(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes))
}

function object(value: unknown, name: string, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`)
  const row = value as Record<string, unknown>
  if (Object.keys(row).some((key) => !keys.includes(key))) throw new Error(`${name} contains an unsupported field`)
  return row
}

function text(value: unknown, name: string, pattern?: RegExp): string {
  if (typeof value !== "string" || !value.trim() || (pattern && !pattern.test(value)))
    throw new Error(`${name} is missing or invalid`)
  return value
}

function timestamp(value: unknown, name: string) {
  const at = text(value, name)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(at) || !Number.isFinite(Date.parse(at)))
    throw new Error(`${name} must be a UTC timestamp`)
  return at
}

function positiveInteger(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`)
  return value
}

function boolean(value: unknown, name: string) {
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`)
  return value
}

function artifact(value: unknown): FirmwareArtifact {
  const row = object(value, "Artifact", ["url", "sha256", "size"])
  const url = new URL(text(row.url, "Artifact URL"))
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new Error("Artifact URL must use HTTPS without credentials or a fragment")
  return {
    url: url.href,
    sha256: text(row.sha256, "Artifact SHA-256", HASH),
    ...(row.size === undefined ? {} : {size: positiveInteger(row.size, "Artifact size")}),
  }
}

function profile(value: unknown): FirmwareProfile {
  const row = object(value, "Profile", ["manifest", "asg", "bes", "mtk"])
  const asg = object(row.asg, "ASG profile", ["versionCode", "artifact"])
  const bes = object(row.bes, "BES profile", ["version", "artifact"])
  const mtk = object(row.mtk, "MTK profile", ["version", "artifact"])
  const besVersion = normalizeBesVersion(bes.version)
  const mtkVersion = normalizeFirmware(text(mtk.version, "MTK version"))
  const mtkArtifact = artifact(mtk.artifact)
  if (mtkArtifact.size === undefined || mtkArtifact.size > 1024 * 1024 * 1024)
    throw new Error("MTK full OTA profile needs a size up to 1 GiB")
  if (bes.version !== besVersion || mtk.version !== mtkVersion)
    throw new Error("Profile versions must use the normalized freeze output")
  return {
    manifest: artifact(row.manifest),
    asg: {versionCode: positiveInteger(asg.versionCode, "ASG versionCode"), artifact: artifact(asg.artifact)},
    bes: {version: besVersion, artifact: artifact(bes.artifact)},
    mtk: {version: mtkVersion, artifact: mtkArtifact},
  }
}

function fixture(value: unknown): FirmwareFixture {
  const row = object(value, "Fixture", ["usb", "cid", "bluetooth", "serials"])
  if (!Array.isArray(row.serials) || !row.serials.length) throw new Error("Fixture serials must be a nonempty array")
  return {
    usb: text(row.usb, "Fixture USB path"),
    cid: text(row.cid, "Fixture CID", CID),
    bluetooth: text(row.bluetooth, "Fixture Bluetooth address", BLUETOOTH),
    serials: row.serials.map((serial) => text(serial, "Fixture serial alias")),
  }
}

function observation(value: unknown): FirmwareObservation {
  const row = object(value, "Observation", [
    "at",
    "evidence",
    "usb",
    "cid",
    "bluetooth",
    "serial",
    "bootId",
    "bootCompleted",
    "firmware",
    "asgVersion",
    "activeApkSha256",
    "bes",
    "updateIdle",
    "appConnected",
  ])
  const bes = object(row.bes, "BES observation", ["version", "at", "bootId", "evidence"])
  const firmware = text(row.firmware, "Observed MTK version")
  const besVersion = text(bes.version, "Observed BES version")
  normalizeFirmware(firmware)
  normalizeBesVersion(besVersion)
  return {
    at: timestamp(row.at, "Observation time"),
    evidence: text(row.evidence, "Observation evidence reference"),
    usb: text(row.usb, "Observed USB path"),
    cid: text(row.cid, "Observed CID", CID),
    bluetooth: text(row.bluetooth, "Observed Bluetooth address", BLUETOOTH),
    serial: text(row.serial, "Observed serial"),
    bootId: text(row.bootId, "Observed boot ID", UUID),
    bootCompleted: boolean(row.bootCompleted, "Boot completion"),
    firmware,
    asgVersion: positiveInteger(row.asgVersion, "Observed ASG version"),
    activeApkSha256: text(row.activeApkSha256, "Active APK SHA-256", HASH),
    bes: {
      version: besVersion,
      at: timestamp(bes.at, "BES observation time"),
      bootId: text(bes.bootId, "BES boot ID", UUID),
      evidence: text(bes.evidence, "BES evidence reference"),
    },
    updateIdle: boolean(row.updateIdle, "Update idle state"),
    appConnected: boolean(row.appConnected, "App connection state"),
  }
}

async function writeNew(path: string, value: unknown) {
  const handle = await open(path, "wx", 0o600)
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n")
    await handle.sync()
  } finally {
    await handle.close()
  }
}

export async function firmwareStateCli(args: string[]): Promise<number> {
  if (!args.length || args[0] === "--help") {
    console.log(HELP)
    return 0
  }
  const command = args[0]
  const keys =
    command === "freeze"
      ? ["manifest", "manifest-url", "manifest-sha256", "output"]
      : command === "verify"
        ? ["profile", "fixture", "observation", "output"]
        : undefined
  if (!keys) throw new Error("Expected freeze or verify; see --help")
  const {values, tokens} = parseArgs({
    args: args.slice(1),
    options: {...Object.fromEntries(keys.map((key) => [key, {type: "string" as const}])), help: {type: "boolean"}},
    allowPositionals: false,
    strict: true,
    tokens: true,
  })
  const seen = new Set<string>()
  for (const token of tokens)
    if (token.kind === "option") {
      if (seen.has(token.name)) throw new Error(`Duplicate --${token.name}`)
      seen.add(token.name)
    }
  if (values.help) {
    console.log(HELP)
    return 0
  }
  const value = (key: string) => text((values as Record<string, unknown>)[key], `--${key}`)
  for (const key of keys) value(key)
  const output = resolve(value("output"))
  if (command === "freeze") {
    const manifest = await input(value("manifest"))
    const frozen = parseFirmwareProfile(manifest.bytes, {
      url: value("manifest-url"),
      sha256: value("manifest-sha256"),
      size: manifest.bytes.byteLength,
    })
    await writeNew(output, frozen)
    console.log(
      JSON.stringify({
        mode: "offline-profile-freeze",
        status: "passed",
        output,
        manifest: frozen.manifest,
        scope: "Checked local bytes against caller-supplied selection; no remote or hardware verification.",
      }),
    )
    return 0
  }
  const [selected, physical, observed] = await Promise.all([
    input(value("profile")),
    input(value("fixture")),
    input(value("observation")),
  ])
  const checkedAt = new Date().toISOString()
  const assertions = assertFirmwareState(
    profile(json(selected.bytes)),
    fixture(json(physical.bytes)),
    observation(json(observed.bytes)),
    Date.parse(checkedAt),
  )
  const passed = assertions.every((assertion) => assertion.status === "passed")
  const report = {
    schemaVersion: 1,
    mode: "offline-assertion",
    scope: "Compares supplied local JSON; does not contact hardware or verify evidence-file contents.",
    checkedAt,
    inputs: {profileSha256: selected.sha256, fixtureSha256: physical.sha256, observationSha256: observed.sha256},
    status: passed ? "passed" : "failed",
    assertions,
  }
  await writeNew(output, report)
  console.log(
    JSON.stringify({
      mode: report.mode,
      status: report.status,
      output,
      failed: assertions.filter((row) => row.status === "failed").map((row) => row.id),
    }),
  )
  return passed ? 0 : 1
}

if (import.meta.main) {
  try {
    process.exitCode = await firmwareStateCli(process.argv.slice(2))
  } catch (error) {
    console.error(`Offline firmware check failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
