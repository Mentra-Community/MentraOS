export interface CliConfig {
  coreUrl: string
  storeUrl: string
  consoleUrl: string
  workosClientId: string
  workosApiBaseUrl: string
}

export function getConfig(): CliConfig {
  const workosClientId = process.env.MENTRA_WORKOS_CLIENT_ID || process.env.WORKOS_CLIENT_ID || ""
  const coreUrl = normalizeUrl(process.env.MENTRA_CORE_URL || "https://core.mentraglass.com")
  return {
    coreUrl,
    storeUrl: normalizeUrl(process.env.MENTRA_STORE_URL || deriveStoreUrl(coreUrl)),
    consoleUrl: normalizeUrl(process.env.MENTRA_CONSOLE_URL || "https://console2.mentraglass.com"),
    workosClientId,
    workosApiBaseUrl: normalizeUrl(process.env.WORKOS_API_BASE_URL || "https://api.workos.com"),
  }
}

/**
 * The Store a stored login belongs to.
 *
 * CLI credentials are scoped per Core, so the Store must follow the credential's
 * own Core rather than whatever Core this process defaults to — otherwise a
 * staging login sends its token to the production Store, and signing keys
 * (stored per Store) miss the slot they were saved under. An explicit
 * MENTRA_STORE_URL is operator intent for this run and still wins; a value
 * already persisted with the login beats re-deriving, so a deployment whose
 * Store is named unconventionally keeps working.
 */
export function resolveStoreUrlForCore(coreUrl: string, persistedStoreUrl?: string): string {
  const override = process.env.MENTRA_STORE_URL?.trim()
  if (override) return normalizeUrl(override)
  if (persistedStoreUrl) return persistedStoreUrl
  return deriveStoreUrl(coreUrl)
}

/** `URL.hostname` brackets IPv6 literals, so `[::1]` never equals `::1`. */
function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  return host === "localhost" || host === "127.0.0.1" || host === "::1"
}

export function deriveStoreUrl(coreUrl: string): string {
  const url = new URL(coreUrl)
  if (url.hostname === "core.mentraglass.com") {
    url.hostname = "store.mentraglass.com"
  } else if (url.hostname.startsWith("core.")) {
    url.hostname = url.hostname.replace(/^core\./, "store.")
  } else if (isLoopbackHostname(url.hostname) && url.port === "3000") {
    url.port = "3003"
  }
  return normalizeUrl(url.toString())
}

function normalizeUrl(value: string): string {
  const url = new URL(value)
  url.pathname = url.pathname.replace(/\/+$/, "")
  url.search = ""
  url.hash = ""
  return url.toString().replace(/\/$/, "")
}
