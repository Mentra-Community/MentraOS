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
 * Every install source follows this rule: QR and manual release installs,
 * bundled and deployment-managed installs, and development builds from a local
 * address. There is no first-party, QR or system-package bypass.
 */
export function assertPublisherIdentityPolicy(input: {
  packageName: string
  candidateFingerprint?: string
  installedFingerprint?: string | null
}): void {
  if (!input.candidateFingerprint) {
    // Nothing signed is installed, so there is no identity to break. An
    // unsigned bundle may never displace one that carries a verified publisher.
    if (!input.installedFingerprint) return
    throw new Error(`Unsigned bundle cannot replace signed miniapp ${input.packageName}; uninstall it first`)
  }

  if (input.installedFingerprint && input.installedFingerprint !== input.candidateFingerprint) {
    throw new Error(
      `Publisher signature mismatch for installed miniapp ${input.packageName}; uninstall it to install a build from another publisher`,
    )
  }
}
