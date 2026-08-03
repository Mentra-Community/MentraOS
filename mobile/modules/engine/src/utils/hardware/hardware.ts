import {
  Capabilities,
  HardwareRequirement,
  HardwareType,
  HardwareRequirementLevel,
  DeviceTypes,
} from "../../types"
import {simulatedGlasses} from "../../types"

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
    if (hardwareType === HardwareType.EXIST) {
      if (capabilities.modelName === DeviceTypes.NONE) {
        return false
      }
      return true
    }

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
        const optionalHardware = result.missingOptional.map((req) => req.type.toLowerCase()).join(", ")
        return `This app works with your glasses but has optional features that require: ${optionalHardware}`
      }
      return "This app is fully compatible with your glasses"
    }

    const requiredHardware = result.missingRequired.map((req) => req.type.toLowerCase()).join(", ")

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
}
