/**
 * @mentra/types - Shared enums for MentraOS
 * These are runtime values (not pure types)
 */

/**
 * Hardware component types that apps can require
 */
export enum HardwareType {
  CAMERA = "CAMERA",
  DISPLAY = "DISPLAY",
  MICROPHONE = "MICROPHONE",
  SPEAKER = "SPEAKER",
  IMU = "IMU",
  BUTTON = "BUTTON",
  LIGHT = "LIGHT",
  WIFI = "WIFI",
}

/**
 * Levels of hardware requirements
 */
export enum HardwareRequirementLevel {
  REQUIRED = "REQUIRED", // App cannot function without this hardware
  OPTIONAL = "OPTIONAL", // App has enhanced features with this hardware
}

export enum DeviceTypes {
  SIMULATED = "Simulated Glasses",
  G1 = "Even Realities G1",
  LIVE = "Mentra Live",
  MACH1 = "Mentra Mach1",
  Z100 = "Vuzix Z100",
  NEX = "Mentra Display",
  FRAME = "Brilliant Frame",
}
