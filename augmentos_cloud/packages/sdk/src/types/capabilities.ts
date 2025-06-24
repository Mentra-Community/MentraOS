/**
 * @fileoverview Capability Discovery Types
 *
 * Defines the structure for device capability profiles that TPAs can query
 * to determine what hardware and software features are available on the
 * connected smart glasses.
 */

export interface CameraCapabilities {
  resolution?: { width: number; height: number; };
  hasHDR?: boolean;
  hasFocus?: boolean;
  video: {
    canRecord: boolean;
    canStream: boolean;
    supportedStreamTypes?: string[];
    supportedResolutions?: { width: number; height: number; }[];
  };
}

export interface ScreenCapabilities {
  count?: number;
  isColor?: boolean;
  color?: string; // e.g., "green", "full_color", "pallet"
  canDisplayBitmap?: boolean;
  resolution?: { width: number; height: number; };
  fieldOfView?: { horizontal?: number; vertical?: number; };
  maxTextLines?: number;
  adjustBrightness?: boolean;
}

export interface MicrophoneCapabilities {
  count?: number;
  hasVAD?: boolean; // Voice Activity Detection
}

export interface SpeakerCapabilities {
  count?: number;
  isPrivate?: boolean; // e.g., bone conduction
}

export interface IMUCapabilities {
  axisCount?: number;
  hasAccelerometer?: boolean;
  hasCompass?: boolean;
  hasGyroscope?: boolean;
}

export interface ButtonCapabilities {
  count?: number;
  buttons?: {
    type: 'press' | 'swipe1d' | 'swipe2d';
    events: string[]; // e.g., "press", "double_press", "long_press", "swipe_up", "swipe_down"
    isCapacitive?: boolean;
  }[];
}

export interface LightCapabilities {
  count?: number;
  lights?: {
    isFullColor: boolean;
    color?: string; // e.g., "white", "rgb"
  }[];
}

export interface PowerCapabilities {
  hasExternalBattery: boolean; // e.g., a case or puck
}

export interface Capabilities {
  modelName: string;

  // Camera capabilities
  hasCamera: boolean;
  camera: CameraCapabilities | null;

  // Screen capabilities
  hasScreen: boolean;
  screen: ScreenCapabilities | null;

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

  // WiFi capabilities
  hasWifi: boolean;
}