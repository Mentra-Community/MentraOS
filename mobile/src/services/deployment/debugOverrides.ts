import {engine, SETTINGS} from "@mentra/engine"

import {devServerHost, METRO_AUTO} from "@/utils/cloudClient/devHost"
import {deriveStoreUrl} from "@/utils/cloudClient/storeUrl"

import type {ActiveDeployment, DeploymentManifest} from "./types"

export function deploymentDebugScope(deployment: ActiveDeployment): string {
  return deployment.kind === "consumer"
    ? "consumer"
    : `workspace:${deployment.manifest.deploymentId}:${deployment.workspaceOrigin}`
}

export function deploymentDebugOverrides(deployment: ActiveDeployment): {
  core?: string
  store?: string
  runtime?: string
} {
  const scope = engine.settings.get(SETTINGS.cloud_url_deployment.key)
  // Existing consumer overrides predate scoping. Never apply these to a workspace.
  if (scope !== deploymentDebugScope(deployment) && !(deployment.kind === "consumer" && !scope)) return {}
  const read = (key: string) => {
    const value = engine.settings.get(key)
    return typeof value === "string" ? value.trim() || undefined : undefined
  }
  return {
    core: read(SETTINGS.cloud_core_url.key),
    store: read(SETTINGS.cloud_store_url.key),
    runtime: read(SETTINGS.cloud_runtime_url.key),
  }
}

export function resolveDeploymentManifest(deployment: ActiveDeployment): DeploymentManifest {
  const overrides = deploymentDebugOverrides(deployment)
  const resolve = (override: string | undefined, baseline: string | null, port: number) => {
    if (!override) return baseline
    if (override !== METRO_AUTO) return override
    const host = devServerHost()
    return host ? `http://${host}:${port}` : baseline
  }
  const coreUrl = resolve(overrides.core, deployment.manifest.services.coreUrl, 3000)
  // A Core override moves the whole identity environment, so Store follows it
  // rather than stranding on the manifest baseline. A Store override still wins,
  // and an override that resolved to nothing leaves the manifest untouched.
  const coreMoved = Boolean(coreUrl) && coreUrl !== deployment.manifest.services.coreUrl
  const storeUrl = overrides.store
    ? resolve(overrides.store, deployment.manifest.services.storeUrl ?? null, 3003)
    : coreMoved
      ? deriveStoreUrl(coreUrl!)
      : deployment.manifest.services.storeUrl
  return {
    ...deployment.manifest,
    services: {
      coreUrl,
      storeUrl,
      runtimeUrl: resolve(overrides.runtime, deployment.manifest.services.runtimeUrl, 3001),
    },
  }
}

const CLEARED_DEBUG_OVERRIDES = {
  [SETTINGS.cloud_core_url.key]: "",
  [SETTINGS.cloud_store_url.key]: "",
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
  urls: {core: string; store?: string; runtime: string},
): Promise<void> {
  const result = await engine.settings.setManyLocal({
    [SETTINGS.cloud_core_url.key]: urls.core,
    // Omitted means "follow Core", which is exactly what an empty override does.
    [SETTINGS.cloud_store_url.key]: urls.store ?? "",
    [SETTINGS.cloud_runtime_url.key]: urls.runtime,
    [SETTINGS.cloud_url_deployment.key]: deploymentDebugScope(deployment),
    [SETTINGS.cached_required_version.key]: "",
  })
  if (result.is_error()) throw result.error
}
