/**
 * Display Profiles
 *
 * Hardware-specific configurations for smart glasses displays.
 * Each profile defines display dimensions, font metrics, and constraints.
 */

// Types
export type {
  DisplayProfile,
  FontMetrics,
  UniformScriptWidths,
  FallbackConfig,
  DisplayConstraints,
  ScriptType,
} from "./types"

// G1 Profiles
export {G1_PROFILE, G1_PROFILE_LEGACY, G1_HYPHEN_WIDTH_PX, G1_SPACE_WIDTH_PX} from "./g1"
