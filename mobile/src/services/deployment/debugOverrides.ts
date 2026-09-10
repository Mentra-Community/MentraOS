import {engine, SETTINGS} from "@mentra/engine"

import {devServerHost, METRO_AUTO} from "@/utils/cloudClient/devHost"

import type {ActiveDeployment, DeploymentManifest} from "./types"

export function deploymentDebugScope(deployment: ActiveDeployment): string {
  return deployment.kind === "consumer"
    ? "consumer"
    : `workspace:${deployment.manifest.deploymentId}:${deployment.workspaceOrigin}`
}

export function deploymentDebugOverrides(deployment: ActiveDeployment): {core?: string; runtime?: string} {
  const scope = engine.settings.get(SETTINGS.cloud_url_deployment.key)
  // Existing consumer overrides predate scoping. Never apply these to a workspace.
  if (scope !== deploymentDebugScope(deployment) && !(deployment.kind === "consumer" && !scope)) return {}
  const read = (key: string) => {
    const value = engine.settings.get(key)
    return typeof value === "string" ? value.trim() || undefined : undefined
  }
  return {core: read(SETTINGS.cloud_core_url.key), runtime: read(SETTINGS.cloud_runtime_url.key)}
}

export function resolveDeploymentManifest(deployment: ActiveDeployment): DeploymentManifest {
  const overrides = deploymentDebugOverrides(deployment)
  const resolve = (override: string | undefined, baseline: string | null, port: number) => {
    if (!override) return baseline
    if (override !== METRO_AUTO) return override
    const host = devServerHost()
    return host ? `http://${host}:${port}` : baseline
  }
  return {
    ...deployment.manifest,
    services: {
      coreUrl: resolve(overrides.core, deployment.manifest.services.coreUrl, 3000),
      runtimeUrl: resolve(overrides.runtime, deployment.manifest.services.runtimeUrl, 3001),
    },
  }
}

export async function clearDeploymentDebugOverrides(): Promise<void> {
  const result = await engine.settings.setManyLocal({
    [SETTINGS.cloud_core_url.key]: "",
    [SETTINGS.cloud_runtime_url.key]: "",
    [SETTINGS.cloud_url_deployment.key]: "",
    [SETTINGS.ota_version_url.key]: "",
    [SETTINGS.cached_required_version.key]: "",
  })
  if (result.is_error()) throw result.error
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
