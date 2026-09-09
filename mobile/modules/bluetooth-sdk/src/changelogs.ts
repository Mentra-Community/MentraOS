import type {ReleaseChangelog} from "./BluetoothSdk.types"
import {GENERATED_RELEASE_CHANGELOGS} from "./generated/changelogCatalog"
import {BLUETOOTH_SDK_RELEASE_METADATA} from "./generated/releaseMetadata"

const BASE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+].*)?$/

function baseVersion(version: string, label: string): string {
  const match = BASE_VERSION_PATTERN.exec(version.trim())
  if (!match) throw new Error(`${label} must be a semantic version such as 3.1.0, 3.1.0-dev.4, or 3.1.0-beta.2`)
  return `${match[1]}.${match[2]}.${match[3]}`
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number)
  const b = right.split(".").map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

/**
 * Return authored release notes crossed between two product versions, newest first.
 * The target release is always included, including transitions within one base train.
 */
export function getReleaseChangelogs(fromVersion?: string | null, toVersion?: string | null): ReleaseChangelog[] {
  const fallbackTarget = BLUETOOTH_SDK_RELEASE_METADATA.familyBaseVersion ?? GENERATED_RELEASE_CHANGELOGS[0]?.version
  if (!fallbackTarget && !toVersion) return []
  const target = baseVersion(toVersion ?? fallbackTarget, "toVersion")
  if (!GENERATED_RELEASE_CHANGELOGS.some(({version}) => version === target)) {
    throw new Error(`No changelog is bundled for target version ${target}`)
  }
  if (!fromVersion) {
    return GENERATED_RELEASE_CHANGELOGS.filter(({version}) => version === target).map((entry) => ({...entry}))
  }

  const source = baseVersion(fromVersion, "fromVersion")
  const direction = compareVersions(target, source)
  return GENERATED_RELEASE_CHANGELOGS.filter(({version}) => {
    if (direction === 0) return version === target
    if (direction > 0) return compareVersions(version, source) > 0 && compareVersions(version, target) <= 0
    return compareVersions(version, source) < 0 && compareVersions(version, target) >= 0
  }).map((entry) => ({...entry}))
}
