/** Hardware components that a miniapp can declare in its manifest. */
export enum HardwareType {
  CAMERA = "CAMERA",
  DISPLAY = "DISPLAY",
  MICROPHONE = "MICROPHONE",
  SPEAKER = "SPEAKER",
  IMU = "IMU",
  BUTTON = "BUTTON",
  LIGHT = "LIGHT",
  WIFI = "WIFI",
  EXIST = "EXIST",
}

/** Whether a missing component prevents the miniapp from running. */
export enum HardwareRequirementLevel {
  REQUIRED = "REQUIRED",
  OPTIONAL = "OPTIONAL",
}

/** One hardware requirement from a miniapp manifest. */
export interface HardwareRequirement {
  type: HardwareType
  level: HardwareRequirementLevel
  description?: string
}
