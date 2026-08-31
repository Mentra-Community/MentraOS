/** Derive the conventional Store endpoint without crossing identity origins. */
export function deriveStoreUrl(coreUrl: string): string {
  const url = new URL(coreUrl)
  if (url.hostname.startsWith("core.")) {
    url.hostname = url.hostname.replace(/^core\./, "store.")
  } else if (url.protocol === "http:" && url.port === "3000") {
    // METRO_AUTO resolves to the laptop's LAN address on physical phones, not
    // localhost. Port 3000 is the local Core convention regardless of which
    // interface reaches it; its matching local Store listens on 3003.
    url.port = "3003"
  }
  return url.toString().replace(/\/$/, "")
}

export function selectStoreUrl(input: {
  storeOverrideUrl?: string
  coreOverrideUrl?: string
  envStoreUrl?: string
  resolvedCoreUrl: string
}): string {
  if (input.storeOverrideUrl) return input.storeOverrideUrl
  // Existing installs may have a persisted two-service Core/Runtime profile
  // from before Store was independently configurable. Keep that identity
  // profile same-environment instead of allowing the baked Store env to win.
  if (input.coreOverrideUrl) return deriveStoreUrl(input.coreOverrideUrl)
  if (input.envStoreUrl) return input.envStoreUrl
  return deriveStoreUrl(input.resolvedCoreUrl)
}
