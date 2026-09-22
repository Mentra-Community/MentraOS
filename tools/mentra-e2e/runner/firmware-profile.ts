import {createHash} from "node:crypto"
import {normalizeFirmware} from "./ota-state"

export type FirmwareArtifact = {url: string; sha256: string; size?: number}
export type FirmwareProfile = {
  manifest: FirmwareArtifact
  asg: {versionCode: number; artifact: FirmwareArtifact}
  bes: {version: string; artifact: FirmwareArtifact}
  mtk: {version: string; artifact: FirmwareArtifact}
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a manifest object")
  return value as Record<string, unknown>
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("Expected a complete SHA-256")
  return value
}

function https(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected an HTTPS artifact URL")
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new Error("Expected an HTTPS artifact URL without credentials or a fragment")
  return url.href
}

function artifact(value: unknown, urlKey = "url", sizeKey = "size"): FirmwareArtifact {
  const row = object(value)
  const size = row[sizeKey]
  if (size !== undefined && (!Number.isSafeInteger(size) || (size as number) <= 0))
    throw new Error("Artifact size must be a positive integer")
  return {url: https(row[urlKey]), sha256: digest(row.sha256), ...(size === undefined ? {} : {size: size as number})}
}

export function normalizeBesVersion(value: unknown): string {
  if (typeof value !== "string" || !/^\d{1,5}(\.\d{1,5}){3}$/.test(value))
    throw new Error("Expected a four-component BES version")
  return value.split(".").map(Number).join(".")
}

/** The caller authenticates the build receipt and its effective manifest URL.
 * Freeze the exact manifest bytes once; do not resolve latest during a run. */
export function parseFirmwareProfile(bytes: Uint8Array, manifest: FirmwareArtifact): FirmwareProfile {
  const source = artifact(manifest)
  if (source.sha256 !== createHash("sha256").update(bytes).digest("hex"))
    throw new Error("OTA manifest bytes differ from the frozen selection")
  if (source.size !== undefined && source.size !== bytes.byteLength)
    throw new Error("OTA manifest size differs from the frozen selection")
  const value = object(JSON.parse(new TextDecoder().decode(bytes)))
  const asg = object(object(value.apps)["com.mentra.asg_client"])
  const bes = object(value.bes_firmware)
  const mtk = object(value.mtk_full_ota)
  if (!Number.isSafeInteger(asg.versionCode) || (asg.versionCode as number) <= 0)
    throw new Error("ASG target needs a positive versionCode")
  if (typeof mtk.end_firmware !== "string") throw new Error("MTK full OTA target is missing")
  // Match the app's full-image eligibility rules; a patch is not a recovery image.
  if (
    mtk.start_firmware !== undefined ||
    !Number.isSafeInteger(mtk.size) ||
    (mtk.size as number) <= 0 ||
    (mtk.size as number) > 1024 * 1024 * 1024
  )
    throw new Error("MTK full OTA needs a size up to 1 GiB and no source firmware")
  return {
    manifest: source,
    asg: {versionCode: asg.versionCode as number, artifact: artifact(asg, "apkUrl", "apkSize")},
    bes: {version: normalizeBesVersion(bes.version), artifact: artifact(bes)},
    mtk: {version: normalizeFirmware(mtk.end_firmware), artifact: artifact(mtk)},
  }
}

export type FirmwareFixture = {
  usb: string
  cid: string
  bluetooth: string
  /** Explicit aliases may include the nonunique January serial; USB + CID still must match. */
  serials: string[]
}

export type FirmwareObservation = {
  at: string
  evidence: string
  usb: string
  cid: string
  bluetooth: string
  serial: string
  bootId: string
  bootCompleted: boolean
  firmware: string
  asgVersion: number
  activeApkSha256: string
  bes: {version: string; at: string; bootId: string; evidence: string}
  updateIdle: boolean
  appConnected: boolean
}

export type FirmwareAssertion = {
  id: string
  expected: unknown
  actual: unknown
  status: "passed" | "failed"
  evidence: string | null
}

function normalized(value: unknown, parse: (value: string) => string): string | null {
  if (typeof value !== "string") return null
  try {
    return parse(value)
  } catch {
    return null
  }
}

/** Compares fresh independent observations, never a command's exit status.
 * Package hashes describe update files, not installed BES/MTK partitions. Only
 * the active ASG APK can be compared directly with its published APK digest. */
export function assertFirmwareState(
  profile: FirmwareProfile,
  fixture: FirmwareFixture,
  observed: Partial<FirmwareObservation>,
  now = Date.now(),
  maxAgeMs = 30000,
): FirmwareAssertion[] {
  if (!Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs <= 0)
    throw new Error("Freshness check needs a valid time and positive age bound")
  if (
    !fixture.usb ||
    !/^[a-f0-9]{32}$/i.test(fixture.cid) ||
    !/^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/i.test(fixture.bluetooth) ||
    !fixture.serials.length ||
    fixture.serials.some((serial) => !serial || typeof serial !== "string")
  )
    throw new Error("Fixture needs physical USB, immutable CID, Bluetooth identity and allowed serial aliases")
  const results: FirmwareAssertion[] = []
  const evidence = typeof observed.evidence === "string" && observed.evidence.trim() ? observed.evidence : null
  const check = (id: string, expected: unknown, actual: unknown, passed: boolean, reference = evidence) => {
    results.push({
      id,
      expected,
      actual: actual ?? null,
      status: passed && reference ? "passed" : "failed",
      evidence: reference,
    })
  }
  const fresh = (at: unknown) => {
    const age = typeof at === "string" ? now - Date.parse(at) : NaN
    return Number.isFinite(age) && age >= 0 && age <= maxAgeMs
  }
  check("observation.fresh", `observed within ${maxAgeMs} ms`, observed.at, fresh(observed.at))
  check("identity.usb", fixture.usb, observed.usb, observed.usb === fixture.usb)
  check(
    "identity.cid",
    fixture.cid.toLowerCase(),
    observed.cid,
    observed.cid?.toLowerCase() === fixture.cid.toLowerCase(),
  )
  check(
    "identity.bluetooth",
    fixture.bluetooth.toUpperCase(),
    observed.bluetooth,
    observed.bluetooth?.toUpperCase() === fixture.bluetooth.toUpperCase(),
  )
  check("identity.serial", fixture.serials, observed.serial, fixture.serials.includes(observed.serial ?? ""))
  check(
    "boot.id",
    "nonempty UUID",
    observed.bootId,
    typeof observed.bootId === "string" && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(observed.bootId),
  )
  check("boot.completed", true, observed.bootCompleted, observed.bootCompleted === true)
  check(
    "firmware.mtk",
    profile.mtk.version,
    observed.firmware,
    normalized(observed.firmware, normalizeFirmware) === profile.mtk.version,
  )
  check(
    "firmware.asg.version",
    profile.asg.versionCode,
    observed.asgVersion,
    observed.asgVersion === profile.asg.versionCode,
  )
  check(
    "firmware.asg.active-apk",
    profile.asg.artifact.sha256,
    observed.activeApkSha256,
    observed.activeApkSha256 === profile.asg.artifact.sha256,
  )
  const besEvidence =
    typeof observed.bes?.evidence === "string" && observed.bes.evidence.trim() ? observed.bes.evidence : null
  check(
    "firmware.bes.version",
    profile.bes.version,
    observed.bes?.version,
    normalized(observed.bes?.version, normalizeBesVersion) === profile.bes.version,
    besEvidence,
  )
  check(
    "firmware.bes.fresh",
    `response within ${maxAgeMs} ms from this boot`,
    observed.bes?.at,
    fresh(observed.bes?.at) && !!observed.bootId && observed.bes?.bootId === observed.bootId,
    besEvidence,
  )
  check("update.idle", true, observed.updateIdle, observed.updateIdle === true)
  check("app.connected", true, observed.appConnected, observed.appConnected === true)
  return results
}
