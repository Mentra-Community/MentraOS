/** Engine capability types and profiles. Miniapp manifest requirement types
 * are re-exported from @mentra/miniapp, their canonical owner. */

// Enums (runtime values)
export {HardwareType, HardwareRequirementLevel, DeviceTypes, ControllerTypes} from "./enums"

// Hardware types
export type {
  HardwareRequirement,
  CameraCapabilities,
  DisplayCapabilities,
  MicrophoneCapabilities,
  SpeakerCapabilities,
  IMUCapabilities,
  ButtonCapabilities,
  LightCapabilities,
  PowerCapabilities,
  Capabilities,
} from "./hardware"

export {
  HARDWARE_CAPABILITIES,
  getModelCapabilities,
  simulatedGlasses,
  evenRealitiesG1,
  evenRealitiesG2,
  mentraLive,
  vuzixZ100,
  mentraDisplay,
} from "./hardware"

// Applet types
export type {AppletType, AppPermissionType, AppletPermission, AppletInterface, ClientApp} from "./applet"
