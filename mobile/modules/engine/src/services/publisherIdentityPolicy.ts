/**
 * Publisher identity follows the Android signing model. The package name is the
 * identity, and the recorded publisher key decides which bundles may replace it.
 *
 * A package with no recorded publisher accepts any bundle, signed or not, so a
 * developer carries a signing key only once they have somewhere durable to keep
 * it. The first signed bundle a package accepts records its key, and from then
 * on every later bundle must present the same one — a one-way door, because the
 * signature envelope has no rotation chain. An unsigned bundle never replaces a
 * signed install; the user uninstalls first, which clears the recorded key.
 *
 * Every install source follows this rule, development snapshots included. Live
 * development code served by a dev server is unsigned, so it may only run under
 * a package that has no recorded publisher (see
 * {@link assertUnsignedDevBuildAllowed}).
 *
 * Provenance is a separate gate and is always enforced: SYSTEM identity comes
 * from `canInstallMiniappRelease`, never from a signature.
 */
export function assertPublisherIdentityPolicy(input: {
  packageName: string
  candidateFingerprint?: string
  installedFingerprint?: string | null
  buildPinnedFingerprint?: string
  system: boolean
}): void {
  if (!input.candidateFingerprint) {
    // Nothing signed is installed, so there is no identity to break. An
    // unsigned bundle may never displace one that carries a verified publisher.
    if (!input.installedFingerprint) return
    throw new Error(`Unsigned bundle cannot replace signed miniapp ${input.packageName}`)
  }

  // A build that pins a SYSTEM publisher only accepts that publisher. Builds
  // that ship their bundled miniapps unsigned pin nothing and skip this.
  if (input.system && input.buildPinnedFingerprint && input.buildPinnedFingerprint !== input.candidateFingerprint) {
    throw new Error(`SYSTEM miniapp ${input.packageName} publisher does not match this Mentra App build`)
  }

  if (input.installedFingerprint && input.installedFingerprint !== input.candidateFingerprint) {
    throw new Error(`Publisher signature mismatch for installed miniapp ${input.packageName}`)
  }
}

/** Live development code was refused because the package is installed with a publisher signature. */
export class SignedMiniappDevBuildError extends Error {
  constructor(readonly packageName: string) {
    super(`${packageName} is installed with a publisher signature. Uninstall it before running a development build.`)
    this.name = "SignedMiniappDevBuildError"
  }
}

/**
 * A live development build runs unsigned code under its manifest package name,
 * so it follows the unsigned-bundle rule: allowed when the package is not
 * installed or is installed unsigned, refused while a publisher key is recorded.
 */
export function assertUnsignedDevBuildAllowed(input: {
  packageName: string
  installedFingerprint?: string | null
}): void {
  if (input.installedFingerprint) throw new SignedMiniappDevBuildError(input.packageName)
}
