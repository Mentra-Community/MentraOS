import semver from "semver"

export interface MiniappInstallExpectations {
  packageName?: string
  version?: string
  rejectExistingVersion?: boolean
}

export function miniappInstallIdentityError(
  manifest: {packageName: string; version: string},
  expected?: MiniappInstallExpectations,
): string | null {
  if (expected?.packageName && manifest.packageName !== expected.packageName) {
    return `Bundle package mismatch: expected ${expected.packageName}, got ${manifest.packageName}`
  }
  if (expected?.version && manifest.version !== expected.version) {
    return `Bundle version mismatch: expected ${expected.version}, got ${manifest.version}`
  }
  return null
}

/** One release rule for every delivery source: reinstall or upgrade, never downgrade. */
export function assertMiniappUpdateVersion(packageName: string, version: string, installedVersions: string[]): void {
  // Live development snapshots are sessions, not installed release versions.
  if (version.startsWith("dev-")) return
  if (!semver.valid(version)) throw new Error(`Invalid miniapp version: ${version}`)
  const newer = installedVersions.filter((installed) => semver.valid(installed) && semver.gt(installed, version))
  newer.sort(semver.rcompare)
  if (newer.length > 0) {
    throw new Error(`Cannot install ${packageName}@${version}: version ${newer[0]} is already installed`)
  }
}
