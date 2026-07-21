import type {ClientApp} from "../types/applet"

const MAX_DIAGNOSTIC_STRING_LENGTH = 512
const MAX_DIAGNOSTIC_LIST_ITEMS = 100
const MAX_RECENT_MINIAPPS = 20

export interface MiniappManifestSnapshot {
  packageName: string
  name?: string
  version?: string
  sdkVersion?: string
  minHostVersion?: string
  type?: string
  entry?: {
    background?: string
    ui?: string
  }
  permissions: Array<{type: string; required?: boolean}>
  hardwareRequirements: Array<{type: string; level: string}>
  actionIds: string[]
}

export interface MiniappRuntimeAppSnapshot {
  packageName: string
  handshakeComplete: boolean
  subscriptions: string[]
  lastMessageAgeMs: number
  requestedLocationRate: string | null
  hasActiveSpeakerStream: boolean
  manifest?: MiniappManifestSnapshot
}

export interface MiniappRuntimeDiagnosticSnapshot {
  connectedApps: MiniappRuntimeAppSnapshot[]
  subscriptionsByStream: Record<string, string[]>
  resources: {
    display: Record<string, unknown>
    camera: Record<string, unknown>
    video: Record<string, unknown>
    stream: Record<string, unknown>
    cameraFov: Record<string, unknown>
  }
}

type ManifestFallback = {
  packageName: string
  name?: string
  version?: string
  type?: string
}

function boundedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.slice(0, MAX_DIAGNOSTIC_STRING_LENGTH)
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

function diagnosticPermissions(value: unknown): Array<{type: string; required?: boolean}> {
  if (!Array.isArray(value)) return []
  const permissions: Array<{type: string; required?: boolean}> = []
  for (const raw of value) {
    if (typeof raw === "string") {
      const type = boundedString(raw)
      if (type) permissions.push({type})
      continue
    }
    const permission = recordValue(raw)
    const type = boundedString(permission?.type)
    if (!type) continue
    permissions.push({
      type,
      ...(typeof permission?.required === "boolean" ? {required: permission.required} : {}),
    })
  }
  return permissions.slice(0, MAX_DIAGNOSTIC_LIST_ITEMS)
}

function diagnosticHardwareRequirements(value: unknown): Array<{type: string; level: string}> {
  if (!Array.isArray(value)) return []
  const requirements: Array<{type: string; level: string}> = []
  for (const raw of value) {
    const requirement = recordValue(raw)
    const type = boundedString(requirement?.type)
    const level = boundedString(requirement?.level)
    if (type && level) requirements.push({type, level})
  }
  return requirements.slice(0, MAX_DIAGNOSTIC_LIST_ITEMS)
}

function diagnosticActionIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((raw) => boundedString(typeof raw === "string" ? raw : recordValue(raw)?.id))
    .filter((id): id is string => id !== undefined)
    .sort()
    .slice(0, MAX_DIAGNOSTIC_LIST_ITEMS)
}

/**
 * Keep the routing/build fields from miniapp.json while excluding arbitrary
 * free-form manifest content from reports. Descriptions, URLs, and unknown
 * extension fields are intentionally omitted.
 */
export function buildMiniappManifestSnapshot(raw: unknown, fallback: ManifestFallback): MiniappManifestSnapshot {
  const manifest = recordValue(raw)
  const entry = recordValue(manifest?.entry)
  const packageName = boundedString(manifest?.packageName) ?? boundedString(fallback.packageName) ?? "unknown"
  const name = boundedString(manifest?.name) ?? boundedString(fallback.name)
  const version = boundedString(manifest?.version) ?? boundedString(fallback.version)
  const type = boundedString(manifest?.type) ?? boundedString(fallback.type)
  const background = boundedString(entry?.background)
  const ui = boundedString(entry?.ui)

  return {
    packageName,
    ...(name ? {name} : {}),
    ...(version ? {version} : {}),
    ...(boundedString(manifest?.sdkVersion) ? {sdkVersion: boundedString(manifest?.sdkVersion)} : {}),
    ...(boundedString(manifest?.minHostVersion) ? {minHostVersion: boundedString(manifest?.minHostVersion)} : {}),
    ...(type ? {type} : {}),
    ...(background || ui ? {entry: {...(background ? {background} : {}), ...(ui ? {ui} : {})}} : {}),
    permissions: diagnosticPermissions(manifest?.permissions),
    hardwareRequirements: diagnosticHardwareRequirements(manifest?.hardwareRequirements),
    actionIds: diagnosticActionIds(manifest?.actions ?? manifest?.actionIds),
  }
}

function executionMode(app: ClientApp): "built_in" | "dev_server" | "dev_snapshot" | "installed_bundle" {
  if (app.offline) return "built_in"
  if (app.isMiniappDev && app.devUrl && !app.version) return "dev_server"
  if (app.isMiniappDev) return "dev_snapshot"
  return "installed_bundle"
}

function safeReleaseIdentity(value: unknown): Record<string, string> | undefined {
  const identity = recordValue(value)
  if (!identity) return undefined
  const out: Record<string, string> = {}
  for (const key of ["source", "releaseId", "bundleSha256", "channel"] as const) {
    const field = boundedString(identity[key])
    if (field) out[key] = field
  }
  return Object.keys(out).length > 0 ? out : undefined
}

export function buildMiniappDiagnosticContext(input: {
  apps: ClientApp[]
  foregroundedPackage: string | null
  runtime: MiniappRuntimeDiagnosticSnapshot
  getLastOpenedAtMs: (app: ClientApp) => number
  getManifest: (app: ClientApp) => unknown
  getReleaseIdentity: (app: ClientApp) => unknown
}): Record<string, unknown> {
  const runtimeByPackage = new Map(input.runtime.connectedApps.map((app) => [app.packageName, app]))
  const appSnapshots = input.apps.map((app) => {
    const lastOpenedAtMs = input.getLastOpenedAtMs(app)
    const packageName = boundedString(app.packageName) ?? "unknown"
    return {
      packageName,
      name: boundedString(app.name) ?? packageName,
      version: boundedString(app.version) ?? null,
      executionMode: executionMode(app),
      running: app.running,
      foregrounded: app.packageName === input.foregroundedPackage,
      loading: app.loading,
      healthy: app.healthy,
      hidden: app.hidden,
      type: app.type,
      offline: app.offline,
      local: app.local,
      lastOpenedAtMs: Number.isFinite(lastOpenedAtMs) ? lastOpenedAtMs : 0,
    }
  })

  const recentlyInteracted = [...appSnapshots]
    .filter((app) => app.lastOpenedAtMs > 0)
    .sort((a, b) => b.lastOpenedAtMs - a.lastOpenedAtMs)
    .slice(0, MAX_RECENT_MINIAPPS)
    .map((app) => ({packageName: app.packageName, lastOpenedAtMs: app.lastOpenedAtMs}))

  const runningMiniapps = input.apps
    .filter((app) => app.running)
    .map((app) => {
      const runtime = runtimeByPackage.get(app.packageName)
      const releaseIdentity = safeReleaseIdentity(input.getReleaseIdentity(app))
      const packageName = boundedString(app.packageName) ?? "unknown"
      const manifest = buildMiniappManifestSnapshot(input.getManifest(app) ?? runtime?.manifest, {
        packageName,
        name: app.name,
        version: app.version,
        type: app.type,
      })
      return {
        packageName,
        version: boundedString(app.version) ?? manifest.version ?? null,
        executionMode: executionMode(app),
        foregrounded: app.packageName === input.foregroundedPackage,
        manifest,
        ...(releaseIdentity ? {releaseIdentity} : {}),
        runtime: runtime
          ? {
              handshakeComplete: runtime.handshakeComplete,
              subscriptions: runtime.subscriptions,
              lastMessageAgeMs: runtime.lastMessageAgeMs,
              requestedLocationRate: runtime.requestedLocationRate,
              hasActiveSpeakerStream: runtime.hasActiveSpeakerStream,
            }
          : null,
      }
    })

  return {
    apps: appSnapshots,
    installed: appSnapshots.map((app) => app.packageName),
    running: runningMiniapps.map((app) => app.packageName),
    foregroundedPackage: boundedString(input.foregroundedPackage) ?? null,
    mostRecentlyInteractedPackage: recentlyInteracted[0]?.packageName ?? null,
    recentlyInteracted,
    runningMiniapps,
  }
}
