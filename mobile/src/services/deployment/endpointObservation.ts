/** Fixed public facts only; custom endpoints must never become diagnostic text or hashes. */
export type CoreEndpointObservation = {
  activeDeployment: "consumer" | "workspace"
  origin: "official-dev" | "official-staging" | "official-prod" | "custom" | "unknown"
  provenance: "manifest" | "override" | "metro" | "metro-fallback"
  overrideScope: "none" | "scoped" | "legacy-consumer"
}

export function coreEndpointOrigin(value: string | null): CoreEndpointObservation["origin"] {
  try {
    if (!value) return "unknown"
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") return "unknown"
    if (!url.username && !url.password && !url.search && !url.hash && /^\/*$/.test(url.pathname)) {
      if (url.origin === "https://core.dev.us-west-2.mentraglass.com") return "official-dev"
      if (url.origin === "https://core.staging.us-west-2.mentraglass.com") return "official-staging"
      if (url.origin === "https://core.us-west-2.mentraglass.com" || url.origin === "https://core.mentraglass.com")
        return "official-prod"
    }
    return "custom"
  } catch {
    return "unknown"
  }
}
