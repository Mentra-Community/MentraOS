/** The immutable APK configuration carries the same embedded baseline used by the resolver. */
export function packagedBackendTarget(extra: Record<string, unknown> | undefined, environmentUrl?: string): string {
  const baseline = environmentUrl?.trim() || "https://core.dev.us-west-2.mentraglass.com"
  const target = extra?.mentraBackendTarget
  if (target === undefined) return baseline
  if (
    !target ||
    typeof target !== "object" ||
    !("schemaVersion" in target) ||
    target.schemaVersion !== 1 ||
    !("coreUrl" in target) ||
    typeof target.coreUrl !== "string"
  )
    throw new Error("Invalid packaged backend target")
  const url = new URL(target.coreUrl)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Packaged backend target must be a credential-free HTTP service URL")
  if (target.coreUrl !== baseline) throw new Error("Packaged backend target differs from its compiled build baseline")
  // Config metadata witnesses the inlined baseline; it cannot select a later
  // Expo override. Existing workspace/debug resolver overrides remain separate.
  return baseline
}
