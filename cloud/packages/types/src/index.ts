/**
 * @mentra/types - Shared types for MentraOS
 *
 * IMPORTANT: Uses explicit exports for Bun compatibility
 * DO NOT use `export *` - Bun runtime can't handle type re-exports
 * See: cloud/issues/todo/sdk-type-exports/README.md
 *
 * Pattern:
 * - Enums (runtime values) → export { ... }
 * - Types/Interfaces (compile-time only) → export type { ... }
 */

// ============================================================================
// Enums (runtime values)
// ============================================================================

export {HardwareType, HardwareRequirementLevel, DeviceTypes} from "./enums"

// ============================================================================
// Hardware types (compile-time only)
// ============================================================================

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

// not a type:
export {HARDWARE_CAPABILITIES, getModelCapabilities} from "./hardware"

// ============================================================================
// Applet types (compile-time only)
// ============================================================================

export type {AppletType, AppPermissionType, AppletPermission, AppletInterface} from "./applet"

// ============================================================================
// CLI types (compile-time only)
// ============================================================================

export type {GlassesInfo} from "./device"

// ============================================================================
// CLI types (compile-time only)
// ============================================================================

export type {
  CLIApiKey,
  CLIApiKeyListItem,
  GenerateCLIKeyRequest,
  GenerateCLIKeyResponse,
  UpdateCLIKeyRequest,
  CLITokenPayload,
  CLICredentials,
  Cloud,
} from "./cli"
