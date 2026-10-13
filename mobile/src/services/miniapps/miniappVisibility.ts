import {SETTINGS, engine} from "@mentra/engine"
import {appRegistry} from "@mentra/engine-host-internal"

import {
  linkLingoPackageName,
  mentraCallPackageName,
  shouldHideMiniapp as shouldHideByPolicy,
} from "@/constants/miniapps"
import {isMiniappDevelopmentAllowed} from "@/services/deployment/miniappDevelopmentPolicy"
import {deploymentStore} from "@/services/deployment/store"
import type {ActiveDeployment} from "@/services/deployment/types"

/** LinkLingo is available only while the local Super Mode setting is enabled. */
export const isSuperModeMiniappAllowed = (packageName: string): boolean =>
  packageName !== linkLingoPackageName || engine.settings.get(SETTINGS.super_mode.key) === true

export function isDeploymentManagedCall(deployment: ActiveDeployment = deploymentStore.getActive()): boolean {
  return (
    deployment.kind === "workspace" &&
    deployment.manifest.features.nativeMeetings &&
    deployment.manifest.miniapps.managed.some((entry) => entry.packageName === mentraCallPackageName)
  )
}

/** Installation eligibility must not depend on the bundle already being on disk. */
export const shouldSkipMiniappInstall = (packageName: string): boolean => {
  if (!isSuperModeMiniappAllowed(packageName)) return true
  const deployment = deploymentStore.getActive()
  if (packageName === mentraCallPackageName && deployment.kind === "workspace") {
    return !isDeploymentManagedCall(deployment)
  }
  return shouldHideByPolicy(packageName, undefined, {
    showIosNotify: engine.settings.get(SETTINGS.show_notify_ios.key) === true,
  })
}

/**
 * Also gate cached home/All Apps entries on the verified workspace release. A
 * developer Call (a scanned dev build or a release-QR install) stands in for it
 * where development is allowed, matching the engine's policy.
 */
export const shouldHideMiniapp = (packageName: string, version?: string, options?: {dev?: boolean}): boolean => {
  if (shouldSkipMiniappInstall(packageName)) return true
  const deployment = deploymentStore.getActive()
  if (packageName !== mentraCallPackageName || deployment.kind !== "workspace") return false
  const developerBuild =
    options?.dev ||
    version?.startsWith("dev-") ||
    (version !== undefined && appRegistry.getReleaseIdentity(packageName, version)?.source === "direct_download")
  if (developerBuild) return !isMiniappDevelopmentAllowed(deployment)
  const entry = deployment.manifest.miniapps.managed.find((item) => item.packageName === packageName)
  if (!entry || (version !== undefined && version !== entry.version)) return true
  const identity = appRegistry.getReleaseIdentity(packageName, entry.version)
  return (
    !appRegistry.getInstalledVersions(packageName).includes(entry.version) ||
    identity?.source !== "deployment_manifest" ||
    identity.deploymentId !== deployment.manifest.deploymentId ||
    identity.deploymentOrigin !== deployment.workspaceOrigin ||
    identity.bundleSha256 !== entry.sha256.toLowerCase()
  )
}
