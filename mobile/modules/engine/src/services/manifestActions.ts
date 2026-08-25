import type {DeclaredAction} from "../types/applet"

/**
 * Normalize manifest actions defensively for installed and dev-sideloaded
 * bundles. Input and output schemas are passed through as opaque JSON Schema.
 */
export function normalizeManifestActions(raw: unknown): DeclaredAction[] {
  if (!Array.isArray(raw)) return []
  const out: DeclaredAction[] = []
  for (const a of raw as Array<{
    id?: unknown
    description?: unknown
    parameters?: unknown
    outputSchema?: unknown
    activation?: unknown
    audience?: unknown
  }>) {
    if (a && typeof a.id === "string" && typeof a.description === "string") {
      out.push({
        id: a.id,
        description: a.description,
        ...(a.parameters && typeof a.parameters === "object" && !Array.isArray(a.parameters)
          ? {parameters: a.parameters as Record<string, unknown>}
          : {}),
        ...(a.outputSchema && typeof a.outputSchema === "object" && !Array.isArray(a.outputSchema)
          ? {outputSchema: a.outputSchema as Record<string, unknown>}
          : {}),
        activation: a.activation === "transient" ? "transient" : "user",
        audience: a.audience === "host" ? "host" : "system",
      })
    }
  }
  return out
}

/** Project only miniapp-callable actions; host scheduling stays undiscoverable. */
export function projectSystemActions(actions: readonly DeclaredAction[]): Array<Omit<DeclaredAction, "audience">> {
  return actions
    .filter((action) => action.audience === "system")
    .map(({audience: _audience, ...action}) => action)
}
