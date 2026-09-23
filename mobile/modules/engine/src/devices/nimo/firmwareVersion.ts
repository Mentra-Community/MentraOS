export type NimoVersion = readonly [number, number, number, number]

/** NIMO packs four components into 4/7/9/12 bits; its OTA TLV version is a different representation. */
export function parseNimoVersion(value: string): NimoVersion | null {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(value)) return null
  const parts = value.split(".").map(Number)
  if (parts.some((part, index) => !Number.isSafeInteger(part) || part < 0 || part > [15, 127, 511, 4095][index]!))
    return null
  return parts as unknown as NimoVersion
}

export function parseNimoFirmwareDetail(value: string): {version: NimoVersion; full: string} | null {
  const match = /^FW-VERSION-v(\d+\.\d+\.\d+\.\d+)-([A-Za-z0-9][A-Za-z0-9._-]*)$/.exec(value)
  const version = match && parseNimoVersion(match[1]!)
  return version ? {version, full: value} : null
}

export function compareNimoVersions(left: NimoVersion, right: NimoVersion): number {
  for (let index = 0; index < 4; index++) {
    if (left[index] !== right[index]) return left[index]! < right[index]! ? -1 : 1
  }
  return 0
}

export interface NimoCompatibleFirmware {
  readonly fullVersion: string
  readonly packedVersion: string
}

export type NimoCompatibility = "compatible" | "upgrade-required" | "unknown"

/** Only explicitly supported identities are operational. A numerically newer unknown build is not a downgrade offer. */
export function nimoCompatibility(
  observed: {fullVersion: string; packedVersion: string},
  compatible: readonly NimoCompatibleFirmware[],
  upgradeFrom: readonly string[],
): NimoCompatibility {
  const detail = parseNimoFirmwareDetail(observed.fullVersion)
  const packed = parseNimoVersion(observed.packedVersion)
  if (!detail || !packed || compareNimoVersions(detail.version, packed) !== 0) return "unknown"
  if (
    compatible.some(
      (item) => item.fullVersion === observed.fullVersion && item.packedVersion === observed.packedVersion,
    )
  )
    return "compatible"
  return upgradeFrom.includes(observed.packedVersion) ? "upgrade-required" : "unknown"
}
