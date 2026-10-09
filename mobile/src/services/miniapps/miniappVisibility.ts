import {SETTINGS, engine} from "@mentra/engine"
import {appRegistry} from "@mentra/engine-host-internal"

import {
  linkLingoPackageName,
  mentraCallPackageName,
  shouldHideMiniapp as shouldHideByPolicy,
} from "@/constants/miniapps"
import {deploymentStore} from "@/services/deployment/store"
import type {ActiveDeployment} from "@/services/deployment/types"

/** LinkLingo is available only while the local Super Mode setting is enabled. */
export const isSuperModeMiniappAllowed = (packageName: string): boolean =>
  packageName !== linkLingoPackageName || engine.settings.get(SETTINGS.super_mode.key) === true

export function isDeploymentManagedCall(deployment: ActiveDeployment = deploymentStore.getActive()): boolean {
  return (
    deployment.kind === "organization" &&
    deployment.manifest.features.nativeMeetings &&
    deployment.manifest.miniapps.managed.some((entry) => entry.packageName === mentraCallPackageName)
  )
}

/** Installation eligibility must not depend on the bundle already being on disk. */
export const shouldSkipMiniappInstall = (packageName: string): boolean => {
  if (!isSuperModeMiniappAllowed(packageName)) return true
  const deployment = deploymentStore.getActive()
  if (packageName === mentraCallPackageName && deployment.kind === "organization") {
    return !isDeploymentManagedCall(deployment)
  }
  return shouldHideByPolicy(packageName, undefined, {
    showIosCall: engine.settings.get(SETTINGS.show_mentra_call_ios.key) === true,
    showIosNotify: engine.settings.get(SETTINGS.show_notify_ios.key) === true,
  })
}

/**
 * Also gate cached home/All Apps entries on the verified organization release. A
 * scanned developer Call stands in for it only in super mode, matching the
 * engine's `isDevMiniappAllowed`.
 */
export const shouldHideMiniapp = (packageName: string, version?: string, options?: {dev?: boolean}): boolean => {
  if (shouldSkipMiniappInstall(packageName)) return true
  const deployment = deploymentStore.getActive()
  if (packageName !== mentraCallPackageName || deployment.kind !== "organization") return false
  if (options?.dev || version?.startsWith("dev-")) return engine.settings.get(SETTINGS.super_mode.key) !== true
  const entry = deployment.manifest.miniapps.managed.find((item) => item.packageName === packageName)
  if (!entry || (version !== undefined && version !== entry.version)) return true
  const identity = appRegistry.getReleaseIdentity(packageName, entry.version)
  return (
    !appRegistry.getInstalledVersions(packageName).includes(entry.version) ||
    identity?.source !== "deployment_manifest" ||
    identity.deploymentId !== deployment.manifest.deploymentId ||
    identity.deploymentOrigin !== deployment.organizationOrigin ||
    identity.bundleSha256 !== entry.sha256.toLowerCase()
  )
}
