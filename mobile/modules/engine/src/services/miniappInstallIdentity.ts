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
