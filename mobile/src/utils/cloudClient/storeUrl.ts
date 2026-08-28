/** Derive the conventional Store endpoint without crossing identity origins. */
export function deriveStoreUrl(coreUrl: string): string {
  const url = new URL(coreUrl)
  if (url.hostname.startsWith("core.")) {
    url.hostname = url.hostname.replace(/^core\./, "store.")
  } else if (
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1") &&
    url.port === "3000"
  ) {
    url.port = "3003"
  }
  return url.toString().replace(/\/$/, "")
}
