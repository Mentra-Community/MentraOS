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
    // A workspace-managed release is authorized by the SHA-256 its deployment
    // manifest pins, fetched from an already-validated workspace origin — a
    // separate root of trust from a publisher signature. It still may not claim
    // a SYSTEM identity, nor take over a package that already carries a verified
    // publisher, so an unsigned manifest bundle can never displace a signed one.
    if (input.source === "deployment_manifest" && !input.system && !input.installedFingerprint) return
    throw new Error(`Production miniapp ${input.packageName} has no verified publisher signature`)
  }
  if (input.system && input.buildPinnedFingerprint !== input.candidateFingerprint) {
    throw new Error(`SYSTEM miniapp ${input.packageName} publisher does not match this Mentra App build`)
  }
  if (input.installedFingerprint && input.installedFingerprint !== input.candidateFingerprint) {
    throw new Error(`Publisher signature mismatch for installed miniapp ${input.packageName}`)
  }
}
