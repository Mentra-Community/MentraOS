import {DeviceTypes} from "@mentra/engine"

import {deploymentStore} from "./store"

const MODEL_IDS: Record<string, string> = {
  [DeviceTypes.LIVE]: "mentra-live",
  [DeviceTypes.G1]: "even-realities-g1",
  [DeviceTypes.G2]: "even-realities-g2",
  [DeviceTypes.MACH1]: "mentra-mach1",
  [DeviceTypes.Z100]: "vuzix-z100",
  [DeviceTypes.NEX]: "mentra-display",
  [DeviceTypes.NIMO]: "nimo",
}

export function deploymentGlassesModelId(deviceModel: string, ar99ProjectName?: string): string | null {
  if (deviceModel === DeviceTypes.AR99) {
    const project = ar99ProjectName?.trim().toLowerCase()
    return project ? `ar99:${project}` : null
  }
  return MODEL_IDS[deviceModel] ?? null
}

export function isGlassesModelAllowedByDeployment(deviceModel: string, ar99ProjectName?: string): boolean {
  // The manifest restricts pairable hardware. Simulated Glasses is an
  // on-phone preview and must remain available when no physical model is
  // selected or permitted.
  if (deviceModel === DeviceTypes.SIMULATED) return true

  const deployment = deploymentStore.getActive()
  if (deployment.kind === "consumer") return true
  const allowed = deployment.manifest.glasses.allowedModelsOverride
  if (allowed === null) return true
  const modelId = deploymentGlassesModelId(deviceModel, ar99ProjectName)
  return modelId !== null && allowed.includes(modelId)
}
