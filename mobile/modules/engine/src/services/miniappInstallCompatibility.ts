import type {Capabilities} from "../types"
import {HardwareCompatibility} from "../utils/hardware"
import {checkManifestVersions} from "./manifestVersionGate"
import {validateManifestHardwareRequirements} from "./validateInstallBundle"

export type MiniappInstallCompatibility =
  | {compatible: true}
  | {compatible: false; blocker: "host" | "sdk" | "hardware"; reason: string}

/** One host-owned compatibility decision shared by Store preflight and ZIP activation. */
export function checkMiniappInstallCompatibility(
  manifest: {sdkVersion?: string; minHostVersion?: string; hardwareRequirements?: unknown},
  policy: {hostVersion: string; supportedSdkRange: string; hardwareCapabilities: Capabilities},
): MiniappInstallCompatibility {
  const versionCompatibility = checkManifestVersions(manifest, policy)
  if (!versionCompatibility.ok) {
    return {
      compatible: false,
      blocker: versionCompatibility.blocker,
      reason: versionCompatibility.reason,
    }
  }
  let hardwareRequirements
  try {
    hardwareRequirements = validateManifestHardwareRequirements(manifest.hardwareRequirements)
  } catch (error) {
    return {
      compatible: false,
      blocker: "hardware",
      reason: error instanceof Error ? error.message : "Invalid hardware requirements",
    }
  }
  const hardwareCompatibility = HardwareCompatibility.checkCompatibility(
    hardwareRequirements,
    policy.hardwareCapabilities,
  )
  if (!hardwareCompatibility.isCompatible) {
    return {
      compatible: false,
      blocker: "hardware",
      reason: HardwareCompatibility.getCompatibilityMessage(hardwareCompatibility),
    }
  }
  return {compatible: true}
}
