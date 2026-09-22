// The official Store is one production service. Its current hostname is temporary;
// Core's environment and npm's release tag do not select a different catalog.
export const DEFAULT_STORE_URL = "https://store.dev.us-west-2.mentraglass.com"

export interface CliConfig {
  storeUrl: string
  consoleUrl: string
  workosClientId: string
  workosApiBaseUrl: string
}

export function getConfig(): CliConfig {
  return {
    storeUrl: normalizeUrl(process.env.MENTRA_STORE_URL || DEFAULT_STORE_URL),
    consoleUrl: normalizeUrl(process.env.MENTRA_CONSOLE_URL || "https://console2.dev.mentraglass.com"),
    workosClientId: process.env.MENTRA_WORKOS_CLIENT_ID || process.env.WORKOS_CLIENT_ID || "",
    workosApiBaseUrl: normalizeUrl(process.env.WORKOS_API_BASE_URL || "https://api.workos.com"),
  }
}

export function normalizeUrl(value: string): string {
  const url = new URL(value)
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Store URLs must use HTTP or HTTPS without embedded credentials")
  }
  url.pathname = url.pathname.replace(/\/+$/, "")
  url.search = ""
  url.hash = ""
  return url.toString().replace(/\/$/, "")
}
