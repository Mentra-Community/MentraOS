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

export function deriveStoreUrl(coreUrl: string): string {
  const url = new URL(coreUrl)
  if (url.hostname === "core.mentraglass.com") {
    url.hostname = "store.mentraglass.com"
  } else if (url.hostname.startsWith("core.")) {
    url.hostname = url.hostname.replace(/^core\./, "store.")
  } else if (
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1") &&
    url.port === "3000"
  ) {
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
