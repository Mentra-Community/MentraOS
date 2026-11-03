import type {Capabilities, HardwareType} from "../types"
import {HardwareCompatibility} from "../utils/hardware"
import {checkManifestVersions} from "./manifestVersionGate"
import {validateManifestHardwareRequirements} from "./validateInstallBundle"

export type MiniappInstallCompatibility =
  | {compatible: true}
  | {compatible: false; blocker: "host" | "sdk" | "hardware"; reason: string}

/** What the phone itself can run: the Mentra App version and the Mentra Miniapp SDK range it supports. */
export interface MiniappVersionPolicy {
  hostVersion: string
  supportedSdkRange: string
}

export interface MiniappCompatibilityPolicy extends MiniappVersionPolicy {
  hardwareCapabilities: Capabilities
}

export type MiniappPhoneCompatibility =
  | {compatible: true}
  | {compatible: false; blocker: "host" | "sdk"; reason: string}

/**
 * Whether the phone can run a release: `minHostVersion` and `sdkVersion` only. This is the rule installs and updates
 * (from a link, a system miniapp, a Fleet assignment or the updater) refuse by. `hardwareRequirements` describe the
 * glasses, which are not always paired when a miniapp installs, so they never refuse an install: see
 * {@link missingRequiredHardware} and the launch check.
 */
export function checkMiniappRunsOnPhone(
  manifest: {sdkVersion?: string; minHostVersion?: string},
  policy: MiniappVersionPolicy,
): MiniappPhoneCompatibility {
  const versions = checkManifestVersions(manifest, policy)
  return versions.ok ? {compatible: true} : {compatible: false, blocker: versions.blocker, reason: versions.reason}
}

/**
 * The required hardware these glasses lack (with no glasses paired, all of it). Optional hardware is not listed;
 * requirements that don't parse are left to the install's own validation.
 */
export function missingRequiredHardware(hardwareRequirements: unknown, capabilities: Capabilities): HardwareType[] {
  let requirements
  try {
    requirements = validateManifestHardwareRequirements(hardwareRequirements)
  } catch {
    return []
  }
  const missing = HardwareCompatibility.checkCompatibility(requirements, capabilities).missingRequired
  return [...new Set(missing.map((requirement) => requirement.type))]
}

/** The full compatibility report against the paired glasses, for callers that only report it (`checkInstallCompatibility`). */
export function checkMiniappInstallCompatibility(
  manifest: {sdkVersion?: string; minHostVersion?: string; hardwareRequirements?: unknown},
  policy: MiniappCompatibilityPolicy,
): MiniappInstallCompatibility {
  const versionCompatibility = checkManifestVersions(manifest, policy)
  if (!versionCompatibility.ok) {
    return {compatible: false, blocker: versionCompatibility.blocker, reason: versionCompatibility.reason}
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
