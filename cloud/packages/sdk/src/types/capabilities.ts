/**
 * @fileoverview Capability Discovery Types
 *
 * Re-exports capability types from @mentra/types to maintain backward compatibility.
 * All capability types are now defined in @mentra/types to avoid circular dependencies.
 */

export type {
  CameraCapabilities,
  DisplayCapabilities,
  MicrophoneCapabilities,
  SpeakerCapabilities,
  IMUCapabilities,
  ButtonCapabilities,
  LightCapabilities,
  PowerCapabilities,
  Capabilities,
} from "@mentra/types";
