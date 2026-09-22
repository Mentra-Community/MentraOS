import {SETTINGS, engine} from "@mentra/engine"

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

/** Read on every decision so installation and debug UI changes share one policy. */
export const shouldHideMiniapp = (packageName: string): boolean => {
  const deployment = deploymentStore.getActive()
  if (packageName === mentraCallPackageName && deployment.kind === "workspace") {
    return !isDeploymentManagedCall(deployment)
  }
  return shouldHideByPolicy(packageName, undefined, {
    showIosCall: engine.settings.get(SETTINGS.show_mentra_call_ios.key) === true,
    showIosNotify: engine.settings.get(SETTINGS.show_notify_ios.key) === true,
  })
}
