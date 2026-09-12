import type {IslandConfigValues} from "../runtime/bootstrap"

export type CloudEndpoints = {core?: string; store?: string; runtime: string}

/** Explicit reconnect pins win; clearing a pin resumes the live host resolver. */
export function resolveCloudEndpoints(config: IslandConfigValues, override: CloudEndpoints | null): CloudEndpoints {
  if (override) return withDerivedStore(override)
  if (config.resolveCloudEndpoints) return withDerivedStore(config.resolveCloudEndpoints())
  const runtime = config.runtimeUrl === null ? "" : config.runtimeUrl?.trim() || "http://localhost:3001"
  if (!runtime) throw new Error("cloudClient: Runtime endpoint is not configured")
  const core = config.coreUrl === null ? undefined : config.coreUrl?.trim() || "http://localhost:3000"
  const store = config.storeUrl === null ? undefined : config.storeUrl?.trim() || undefined
  return withDerivedStore({...(core ? {core} : {}), ...(store ? {store} : {}), runtime})
}

/**
 * The Store is deployed alongside Core, so a deployment that names only Core
 * still gets its matching Store. A Core-free deployment has no Store to derive;
 * callers that need one surface that as an explicit error.
 */
function withDerivedStore(endpoints: CloudEndpoints): CloudEndpoints {
  if (endpoints.store || !endpoints.core) return endpoints
  return {...endpoints, store: deriveStoreUrl(endpoints.core)}
}

export function deriveStoreUrl(core: string): string {
  const url = new URL(core)
  if (url.hostname === "core.mentraglass.com") return "https://store.mentraglass.com"
  if (url.hostname.startsWith("core.")) url.hostname = url.hostname.replace(/^core\./, "store.")
  // Port 3000 is the local Core convention regardless of which interface reaches
  // it; its matching local Store listens on 3003.
  else if (url.protocol === "http:" && url.port === "3000") url.port = "3003"
  return url.origin
}

export function scopeCloudUrlOverrides(
  current: {scope: unknown; core?: string; runtime?: string},
  scope: string,
  update: {core?: string; runtime?: string},
): {core: string; runtime: string} {
  const sameScope = current.scope === scope || (!current.scope && scope === "consumer")
  return {
    core: update.core ?? (sameScope ? (current.core ?? "") : ""),
    runtime: update.runtime ?? (sameScope ? (current.runtime ?? "") : ""),
  }
}
