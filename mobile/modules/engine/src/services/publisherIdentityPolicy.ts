/**
 * Publisher identity is opt-in, and opting in is sticky.
 *
 * A package with no recorded publisher accepts any bundle, signed or not, so a
 * developer carries a signing key only once they have somewhere durable to keep
 * it. The first signed bundle a package accepts records its key, and from then
 * on every later update must present the same one — a one-way door, because the
 * signature envelope has no rotation chain.
 *
 * Provenance is a separate gate and is always enforced: SYSTEM identity comes
 * from `canInstallMiniappRelease`, never from a signature.
 */
export function assertPublisherIdentityPolicy(input: {
  packageName: string
  source?: string
  candidateFingerprint?: string
  installedFingerprint?: string | null
  buildPinnedFingerprint?: string
  system: boolean
}): void {
  if (input.source === "dev_snapshot") return

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
