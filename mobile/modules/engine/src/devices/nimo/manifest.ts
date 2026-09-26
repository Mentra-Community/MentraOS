import {
  compareNimoVersions,
  parseNimoFirmwareDetail,
  parseNimoVersion,
  type NimoCompatibleFirmware,
} from "./firmwareVersion"

export interface NimoFirmwareManifest {
  readonly schemaVersion: 1
  readonly releaseId: string
  readonly hardwareId: string
  readonly target: NimoCompatibleFirmware & {readonly peerVersion: string}
  readonly compatible: readonly NimoCompatibleFirmware[]
  /** Explicit source versions supported by this release, not a semver wildcard. */
  readonly upgradeFrom: readonly string[]
  readonly artifact: {readonly url: string; readonly sha256: string; readonly size: number}
  readonly releaseNotes: string
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid NIMO manifest object")
  return value as Record<string, unknown>
}

function string(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 8192) throw new Error("Invalid NIMO manifest string")
  return value
}

function identity(value: unknown): NimoCompatibleFirmware {
  const data = object(value)
  const fullVersion = string(data.fullVersion)
  const packedVersion = string(data.packedVersion)
  if (fullVersion.length > 512) throw new Error("NIMO firmware identity is too long")
  const detail = parseNimoFirmwareDetail(fullVersion)
  const packed = parseNimoVersion(packedVersion)
  if (!detail || !packed || compareNimoVersions(detail.version, packed) !== 0)
    throw new Error("NIMO full and packed firmware identities disagree")
  return {fullVersion, packedVersion}
}

export function parseNimoManifest(value: unknown): NimoFirmwareManifest {
  const data = object(value)
  if (data.schemaVersion !== 1) throw new Error("Unsupported NIMO firmware manifest")
  const target = object(data.target)
  const targetIdentity = identity(target)
  const hardwareId = string(data.hardwareId)
  const peerVersion = string(target.peerVersion)
  if (!/^[0-9a-f]{8}$/.test(hardwareId) || !/^[0-9a-f]{4}$/.test(peerVersion))
    throw new Error("Invalid NIMO hardware or peer identity")
  if (
    !Array.isArray(data.compatible) ||
    data.compatible.length > 64 ||
    !Array.isArray(data.upgradeFrom) ||
    data.upgradeFrom.length > 64
  )
    throw new Error("Invalid NIMO compatibility policy")
  const compatible = data.compatible.map(identity)
  if (
    !compatible.some(
      (item) => item.fullVersion === targetIdentity.fullVersion && item.packedVersion === targetIdentity.packedVersion,
    )
  )
    throw new Error("NIMO target must be included in compatible firmware identities")
  const targetVersion = parseNimoVersion(targetIdentity.packedVersion)!
  const upgradeFrom = data.upgradeFrom.map((value) => {
    const source = string(value)
    const version = parseNimoVersion(source)
    if (!version || compareNimoVersions(version, targetVersion) >= 0)
      throw new Error("NIMO manifest cannot authorize reflash or downgrade")
    return source
  })
  const artifact = object(data.artifact)
  const url = new URL(string(artifact.url))
  const sha256 = string(artifact.sha256)
  if (url.protocol !== "https:" || url.username || url.password || url.hash || !/^[0-9a-f]{64}$/.test(sha256))
    throw new Error("NIMO firmware requires a pinned HTTPS artifact")
  if (
    !Number.isSafeInteger(artifact.size) ||
    (artifact.size as number) < 1 ||
    (artifact.size as number) > 32 * 1024 * 1024
  )
    throw new Error("Invalid NIMO firmware size")
  if (data.releaseNotes !== undefined && (typeof data.releaseNotes !== "string" || data.releaseNotes.length > 65536))
    throw new Error("Invalid NIMO release notes")
  return {
    schemaVersion: 1,
    releaseId: string(data.releaseId),
    hardwareId,
    target: {...targetIdentity, peerVersion},
    compatible,
    upgradeFrom,
    artifact: {url: url.toString(), sha256, size: artifact.size as number},
    releaseNotes: (data.releaseNotes as string | undefined) ?? "",
  }
}
