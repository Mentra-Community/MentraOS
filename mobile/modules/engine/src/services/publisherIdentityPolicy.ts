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
    throw new Error(`Production miniapp ${input.packageName} has no verified publisher signature`)
  }
  if (input.system && input.buildPinnedFingerprint !== input.candidateFingerprint) {
    throw new Error(`SYSTEM miniapp ${input.packageName} publisher does not match this Mentra App build`)
  }
  if (input.installedFingerprint && input.installedFingerprint !== input.candidateFingerprint) {
    throw new Error(`Publisher signature mismatch for installed miniapp ${input.packageName}`)
  }
}
