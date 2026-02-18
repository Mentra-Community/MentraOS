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

// Z100 Profile
export {Z100_PROFILE, Z100_HYPHEN_WIDTH_PX, Z100_SPACE_WIDTH_PX} from "./z100"

// Mentra Nex Profile (a.k.a. Mentra Display)
export {NEX_PROFILE, NEX_HYPHEN_WIDTH_PX, NEX_SPACE_WIDTH_PX} from "./nex"
