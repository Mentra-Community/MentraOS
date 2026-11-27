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

/**
 * The one update rule: what a miniapp's URL serves replaces the installed release when it is another build, whatever
 * the two versions are. A build is its ZIP, identified by its SHA-256. A release installed before hashes were recorded
 * counts as the build its URL serves at the same version.
 */
export function isServedBuildInstalled(
  installed: {version: string; bundleSha256?: string},
  served: {version: string; bundleSha256: string},
): boolean {
  if (!installed.bundleSha256) return installed.version === served.version
  return installed.bundleSha256.toLowerCase() === served.bundleSha256.toLowerCase()
}

/**
 * A release would replace a development build, which only the person replaces (`AppRegistry.isDevelopmentBuild`):
 * the install is refused and the development build stays.
 */
export class DevelopmentBuildInstalledError extends Error {
  constructor(readonly packageName: string) {
    super(`${packageName} runs a development build, which only the person replaces`)
    this.name = "DevelopmentBuildInstalledError"
  }
}
