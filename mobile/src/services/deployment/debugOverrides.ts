import {engine, SETTINGS} from "@mentra/engine"

import {devServerHost, METRO_AUTO} from "@/utils/cloudClient/devHost"

import {coreEndpointOrigin, type CoreEndpointObservation} from "./endpointObservation"
import type {ActiveDeployment, DeploymentManifest} from "./types"

export function deploymentDebugScope(deployment: ActiveDeployment): string {
  return deployment.kind === "consumer"
    ? "consumer"
    : `workspace:${deployment.manifest.deploymentId}:${deployment.workspaceOrigin}`
}

export function deploymentDebugOverrides(deployment: ActiveDeployment): {core?: string; runtime?: string} {
  return readDeploymentDebugOverrides(deployment).overrides
}

function readDeploymentDebugOverrides(deployment: ActiveDeployment): {
  overrides: {core?: string; runtime?: string}
  scope: CoreEndpointObservation["overrideScope"]
} {
  const scope = engine.settings.get(SETTINGS.cloud_url_deployment.key)
  // Existing consumer overrides predate scoping. Never apply these to a workspace.
  if (scope !== deploymentDebugScope(deployment) && !(deployment.kind === "consumer" && !scope))
    return {overrides: {}, scope: "none"}
  const read = (key: string) => {
    const value = engine.settings.get(key)
    return typeof value === "string" ? value.trim() || undefined : undefined
  }
  return {
    overrides: {core: read(SETTINGS.cloud_core_url.key), runtime: read(SETTINGS.cloud_runtime_url.key)},
    scope: scope === deploymentDebugScope(deployment) ? "scoped" : "legacy-consumer",
  }
}

export function resolveDeploymentManifest(
  deployment: ActiveDeployment,
  onCoreResolved?: (observation: CoreEndpointObservation) => void,
): DeploymentManifest {
  const {overrides, scope} = readDeploymentDebugOverrides(deployment)
  const resolve = (override: string | undefined, baseline: string | null, port: number, core = false) => {
    let provenance: CoreEndpointObservation["provenance"] = "manifest"
    let value = baseline
    if (override && override !== METRO_AUTO) {
      value = override
      provenance = "override"
    } else if (override === METRO_AUTO) {
      const host = devServerHost()
      value = host ? `http://${host}:${port}` : baseline
      provenance = host ? "metro" : "metro-fallback"
    }
    if (core && onCoreResolved) {
      try {
        onCoreResolved({
          activeDeployment: deployment.kind,
          origin: coreEndpointOrigin(value),
          provenance,
          overrideScope: override ? scope : "none",
        })
      } catch {
        // A diagnostic callback must not change endpoint resolution or the request.
      }
    }
    return value
  }
  return {
    ...deployment.manifest,
    services: {
      coreUrl: resolve(overrides.core, deployment.manifest.services.coreUrl, 3000, true),
      runtimeUrl: resolve(overrides.runtime, deployment.manifest.services.runtimeUrl, 3001),
    },
  }
}

const CLEARED_DEBUG_OVERRIDES = {
  [SETTINGS.cloud_core_url.key]: "",
  [SETTINGS.cloud_runtime_url.key]: "",
  [SETTINGS.cloud_url_deployment.key]: "",
  [SETTINGS.ota_version_url.key]: "",
  [SETTINGS.cached_required_version.key]: "",
}

async function writeDebugOverrides(values: Record<string, unknown>): Promise<void> {
  const result = await engine.settings.setManyLocal(values)
  if (result.is_error()) throw result.error
}

export async function clearDeploymentDebugOverrides(): Promise<void> {
  await writeDebugOverrides(CLEARED_DEBUG_OVERRIDES)
}

/** Restore the previous configuration if clearing or persisting selection fails. */
export async function withClearedDeploymentDebugOverrides(commit: () => void): Promise<void> {
  const previous = Object.fromEntries(
    Object.keys(CLEARED_DEBUG_OVERRIDES).map((key) => [key, engine.settings.get(key)]),
  )
  try {
    await clearDeploymentDebugOverrides()
    commit()
  } catch (error) {
    try {
      await writeDebugOverrides(previous)
    } catch (restoreError) {
      throw new Error(
        `Deployment change failed (${String(error)}); previous debug settings could not be restored (${String(restoreError)}). Retry when device storage is available.`,
      )
    }
    throw error
  }
}

export async function saveDeploymentCloudOverrides(
  deployment: ActiveDeployment,
  urls: {core: string; runtime: string},
): Promise<void> {
  const result = await engine.settings.setManyLocal({
    [SETTINGS.cloud_core_url.key]: urls.core,
    [SETTINGS.cloud_runtime_url.key]: urls.runtime,
    [SETTINGS.cloud_url_deployment.key]: deploymentDebugScope(deployment),
    [SETTINGS.cached_required_version.key]: "",
  })
  if (result.is_error()) throw result.error
}
