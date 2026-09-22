import {SETTINGS, engine} from "@mentra/engine"
import {appRegistry} from "@mentra/engine-host-internal"

import {mentraCallPackageName, shouldHideMiniapp as shouldHideByPolicy} from "@/constants/miniapps"
import {deploymentStore} from "@/services/deployment/store"
import type {ActiveDeployment} from "@/services/deployment/types"

export function isDeploymentManagedCall(deployment: ActiveDeployment = deploymentStore.getActive()): boolean {
  return (
    deployment.kind === "workspace" &&
    deployment.manifest.features.nativeMeetings &&
    deployment.manifest.miniapps.managed.some((entry) => entry.packageName === mentraCallPackageName)
  )
}

/** Installation eligibility must not depend on the bundle already being on disk. */
export const shouldSkipMiniappInstall = (packageName: string): boolean => {
  const deployment = deploymentStore.getActive()
  if (packageName === mentraCallPackageName && deployment.kind === "workspace") {
    return !isDeploymentManagedCall(deployment)
  }
  return shouldHideByPolicy(packageName, undefined, {
    showIosCall: engine.settings.get(SETTINGS.show_mentra_call_ios.key) === true,
    showIosNotify: engine.settings.get(SETTINGS.show_notify_ios.key) === true,
  })
}

/** Also gate cached home/All Apps entries on the verified workspace release. */
export const shouldHideMiniapp = (packageName: string, version?: string): boolean => {
  if (shouldSkipMiniappInstall(packageName)) return true
  const deployment = deploymentStore.getActive()
  if (packageName !== mentraCallPackageName || deployment.kind !== "workspace") return false
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
