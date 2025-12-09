import {
  Capabilities,
  HardwareRequirement,
  HardwareType,
  HardwareRequirementLevel,
} from "@/../../cloud/packages/types/src"
import {simulatedGlasses} from "@/../../cloud/packages/types/src/hardware"

/**
 * Result of a hardware compatibility check
 */
export interface CompatibilityResult {
  isCompatible: boolean
  missingRequired: HardwareRequirement[]
  missingOptional: HardwareRequirement[]
  warnings: string[]
}

/**
 * Service for checking hardware compatibility between apps and glasses
 */
export class HardwareCompatibility {
  /**
   * Check if app is compatible with given device capabilities
   * @param app The app to check
   * @param capabilities The device capabilities (null if no device connected)
   * @returns Detailed compatibility result
   */
  static checkCompatibility(
    hardwareRequirements: HardwareRequirement[],
    capabilities: Capabilities | null,
  ): CompatibilityResult {
    const result: CompatibilityResult = {
      isCompatible: true,
      missingRequired: [],
      missingOptional: [],
      warnings: [],
    }

    // If no hardware requirements specified, app is compatible with any hardware
    if (hardwareRequirements.length === 0) {
      return result
    }

    // If no capabilities available assume simulated glasses:
    if (!capabilities) {
      capabilities = simulatedGlasses
    }

    // Check each hardware requirement
    for (const requirement of hardwareRequirements) {
      const hasHardware = this.checkHardwareAvailable(requirement.type, capabilities!)
      if (!hasHardware) {
        if (requirement.level === HardwareRequirementLevel.REQUIRED) {
          result.missingRequired.push(requirement)
          result.isCompatible = false
        } else {
          result.missingOptional.push(requirement)
        }
      }
    }

    return result
  }

  /**
   * Check if specific hardware is available in capabilities
   * @param hardwareType The type of hardware to check
   * @param capabilities The device capabilities
   * @returns true if hardware is available
   */
  private static checkHardwareAvailable(hardwareType: HardwareType, capabilities: Capabilities): boolean {
    switch (hardwareType) {
      case HardwareType.CAMERA:
        return capabilities.hasCamera

      case HardwareType.DISPLAY:
        return capabilities.hasDisplay

      case HardwareType.MICROPHONE:
        return capabilities.hasMicrophone

      case HardwareType.SPEAKER:
        return capabilities.hasSpeaker

      case HardwareType.IMU:
        return capabilities.hasIMU

      case HardwareType.BUTTON:
        return capabilities.hasButton

      case HardwareType.LIGHT:
        return capabilities.hasLight

      case HardwareType.WIFI:
        return capabilities.hasWifi

      default:
        // Unknown hardware type - assume not available
        return false
    }
  }

  /**
   * Get human-readable compatibility message
   * @param result The compatibility check result
   * @returns User-friendly message about compatibility
   */
  static getCompatibilityMessage(result: CompatibilityResult): string {
    if (result.isCompatible) {
      if (result.missingOptional.length > 0) {
        const optionalHardware = result.missingOptional.map(req => req.type.toLowerCase()).join(", ")
        return `This app works with your glasses but has optional features that require: ${optionalHardware}`
      }
      return "This app is fully compatible with your glasses"
    }

    const requiredHardware = result.missingRequired.map(req => req.type.toLowerCase()).join(", ")

    if (result.missingRequired.length === 1) {
      return `This app requires a ${requiredHardware} which is not available on your connected glasses`
    } else {
      return `This app requires the following hardware which is not available on your connected glasses: ${requiredHardware}`
    }
  }

  /**
   * Get detailed compatibility messages including descriptions
   * @param result The compatibility check result
   * @returns Array of detailed messages
   */
  static getDetailedMessages(result: CompatibilityResult): string[] {
    const messages: string[] = []

    // Add warnings first
    messages.push(...result.warnings)

    // Add missing required hardware
    for (const req of result.missingRequired) {
      let message = `❌ Missing required ${req.type.toLowerCase()}`
      if (req.description) {
        message += `: ${req.description}`
      }
      messages.push(message)
    }

    // Add missing optional hardware
    for (const req of result.missingOptional) {
      let message = `⚠️ Missing optional ${req.type.toLowerCase()}`
      if (req.description) {
        message += `: ${req.description}`
      }
      messages.push(message)
    }

    return messages
  }

  // /**
  //  * Check if an array of apps are compatible with given capabilities
  //  * @param apps Array of apps to check
  //  * @param capabilities Device capabilities
  //  * @returns Map of app packageName to compatibility result
  //  */
  // static checkMultipleApps(apps: AppI[], capabilities: Capabilities | null): Map<string, CompatibilityResult> {
  //   const results = new Map<string, CompatibilityResult>()

  //   for (const app of apps) {
  //     results.set(app.packageName, this.checkCompatibility(app, capabilities))
  //   }

  //   return results
  // }

  // /**
  //  * Filter apps by compatibility
  //  * @param apps Array of apps to filter
  //  * @param capabilities Device capabilities
  //  * @param includeOptional Whether to include apps with missing optional hardware
  //  * @returns Array of compatible apps
  //  */
  // static filterCompatibleApps(apps: AppI[], capabilities: Capabilities | null, includeOptional = true): AppI[] {
  //   return apps.filter(app => {
  //     const result = this.checkCompatibility(app, capabilities)
  //     return result.isCompatible || (includeOptional && result.missingRequired.length === 0)
  //   })
  // }

  // /**
  //  * Get hardware requirements summary for an app
  //  * @param app The app
  //  * @returns Human-readable summary of hardware requirements
  //  */
  // static getRequirementsSummary(app: AppI): string {
  //   if (!app.hardwareRequirements || app.hardwareRequirements.length === 0) {
  //     return "No specific hardware requirements"
  //   }

  //   const required = app.hardwareRequirements
  //     .filter(req => req.level === HardwareRequirementLevel.REQUIRED)
  //     .map(req => req.type.toLowerCase())

  //   const optional = app.hardwareRequirements
  //     .filter(req => req.level === HardwareRequirementLevel.OPTIONAL)
  //     .map(req => req.type.toLowerCase())

  //   const parts: string[] = []

  //   if (required.length > 0) {
  //     parts.push(`Requires: ${required.join(", ")}`)
  //   }

  //   if (optional.length > 0) {
  //     parts.push(`Optional: ${optional.join(", ")}`)
  //   }

  //   return parts.join(" | ")
  // }
}
