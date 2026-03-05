/**
 * @mentra/types - Hardware capability types
 */

import { evenRealitiesG1 } from "./capabilities/even-realities-g1";
import { mentraLive } from "./capabilities/mentra-live";
import { simulatedGlasses } from "./capabilities/simulated-glasses";
import { vuzixZ100 } from "./capabilities/vuzix-z100";
import { none } from "./capabilities/none";
import { DeviceTypes, HardwareRequirementLevel, HardwareType } from "./enums";

/**
 * Hardware requirement for an app
 * Specifies what hardware components an app needs
 */
export interface HardwareRequirement {
  type: HardwareType;
  level: HardwareRequirementLevel;
  description?: string; // Why this hardware is needed
}

/**
 * Camera capabilities
 */
export interface CameraCapabilities {
  resolution?: { width: number; height: number };
  hasHDR?: boolean;
  hasFocus?: boolean;
  video: {
    canRecord: boolean;
    canStream: boolean;
    supportedStreamTypes?: string[];
    supportedResolutions?: { width: number; height: number }[];
  };
}

/**
 * Display capabilities
 */
export interface DisplayCapabilities {
  count?: number;
  isColor?: boolean;
  color?: string; // e.g., "green", "full_color", "pallet"
  canDisplayBitmap?: boolean;
  resolution?: { width: number; height: number };
  fieldOfView?: { horizontal?: number; vertical?: number };
  maxTextLines?: number;
  adjustBrightness?: boolean;
}

/**
 * Microphone capabilities
 */
export interface MicrophoneCapabilities {
  count?: number;
  hasVAD?: boolean; // Voice Activity Detection
}

/**
 * Speaker capabilities
 */
export interface SpeakerCapabilities {
  count?: number;
  isPrivate?: boolean; // e.g., bone conduction
}

/**
 * IMU (Inertial Measurement Unit) capabilities
 */
export interface IMUCapabilities {
  axisCount?: number;
  hasAccelerometer?: boolean;
  hasCompass?: boolean;
  hasGyroscope?: boolean;
}

/**
 * Button capabilities
 */
export interface ButtonCapabilities {
  count?: number;
  buttons?: {
    type: "press" | "swipe1d" | "swipe2d";
    events: string[]; // e.g., "press", "double_press", "long_press", "swipe_up", "swipe_down"
    isCapacitive?: boolean;
  }[];
}

/**
 * Light capabilities
 */
export interface LightCapabilities {
  count?: number;
  lights?: {
    id: string; // Unique identifier for the LED (e.g., "privacy", "user_feedback")
    purpose: "privacy" | "user_feedback" | "general"; // LED purpose/function
    isFullColor: boolean;
    color?: string; // e.g., "white", "rgb"
    position?: "front_facing" | "user_facing" | "side" | "unknown"; // LED physical position
  }[];
}

/**
 * Power capabilities
 */
export interface PowerCapabilities {
  hasExternalBattery: boolean; // e.g., a case or puck
}

/**
 * Device hardware capabilities
 * Complete information about what hardware a device has
 */
export interface Capabilities {
  modelName: string;

  // Camera capabilities
  hasCamera: boolean;
  camera: CameraCapabilities | null;

  // Display capabilities
  hasDisplay: boolean;
  display: DisplayCapabilities | null;

  // Microphone capabilities
  hasMicrophone: boolean;
  microphone: MicrophoneCapabilities | null;

  // Speaker capabilities
  hasSpeaker: boolean;
  speaker: SpeakerCapabilities | null;

  // IMU capabilities
  hasIMU: boolean;
  imu: IMUCapabilities | null;

  // Button capabilities
  hasButton: boolean;
  button: ButtonCapabilities | null;

  // Light capabilities
  hasLight: boolean;
  light: LightCapabilities | null;

  // Power capabilities
  power: PowerCapabilities;

  // WiFi capability
  hasWifi: boolean;
}

/**
 * Hardware capability profiles for supported glasses models
 * Key: model_name string (e.g., "Even Realities G1", "Mentra Live")
 * Value: Capabilities object defining device features
 */
export const HARDWARE_CAPABILITIES: Record<string, Capabilities> = {
  [evenRealitiesG1.modelName]: evenRealitiesG1,
  [mentraLive.modelName]: mentraLive,
  [simulatedGlasses.modelName]: simulatedGlasses,
  [vuzixZ100.modelName]: vuzixZ100,
  [none.modelName]: none,
};

export const getModelCapabilities = (deviceType: DeviceTypes): Capabilities => {
  const modelName = deviceType as string;
  if (!HARDWARE_CAPABILITIES[modelName]) {
    return HARDWARE_CAPABILITIES[DeviceTypes.NONE];
  }
  return HARDWARE_CAPABILITIES[modelName];
};

// export * from "./capabilities"
export { simulatedGlasses, evenRealitiesG1, mentraLive, vuzixZ100 };
