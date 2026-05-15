/**
 * Island shared types — copied verbatim from @mentra/types so the module is
 * self-contained. Keep these in sync with cloud/packages/types/src when the
 * canonical types change. The capability profiles also live here under
 * ./capabilities/.
 */

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
