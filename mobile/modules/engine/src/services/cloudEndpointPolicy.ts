import type {IslandConfigValues} from "../runtime/bootstrap"

// The host addresses Core and Runtime only. A Store is reached by its own
// miniapp, which holds its own credential and resolves its own backend.
export type CloudEndpoints = {core?: string; runtime: string}

/** Explicit reconnect pins win; clearing a pin resumes the live host resolver. */
export function resolveCloudEndpoints(config: IslandConfigValues, override: CloudEndpoints | null): CloudEndpoints {
  if (override) return override
  if (config.resolveCloudEndpoints) return config.resolveCloudEndpoints()
  const runtime = config.runtimeUrl === null ? "" : config.runtimeUrl?.trim() || "http://localhost:3001"
  if (!runtime) throw new Error("cloudClient: Runtime endpoint is not configured")
  const core = config.coreUrl === null ? undefined : config.coreUrl?.trim() || "http://localhost:3000"
  return {...(core ? {core} : {}), runtime}
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
