/**
 * Display Service
 *
 * Provides pixel-accurate text wrapping and display processing for smart glasses.
 * Uses the same display-utils library as the cloud for consistent rendering.
 *
 * @example
 * ```typescript
 * import { displayProcessor } from '@/services/display'
 *
 * // Set device model when glasses connect
 * displayProcessor.setDeviceModel("Even Realities G1")
 *
 * // Process display events
 * const processed = displayProcessor.processDisplayEvent(rawEvent)
 * ```
 */

// Main DisplayProcessor
export {
  DisplayProcessor,
  displayProcessor,
  type DeviceModel,
  type DisplayLayoutType,
  type DisplayEvent,
  type ProcessedDisplayEvent,
  type DisplayProcessorOptions,
} from "./DisplayProcessor"

// Re-export display-utils for direct access if needed
export {
  // Profiles
  type DisplayProfile,
  G1_PROFILE,
  G1_PROFILE_LEGACY,
  G1_HYPHEN_WIDTH_PX,
  G1_SPACE_WIDTH_PX,
  Z100_PROFILE,
  Z100_HYPHEN_WIDTH_PX,
  Z100_SPACE_WIDTH_PX,
  NEX_PROFILE,
  NEX_HYPHEN_WIDTH_PX,
  NEX_SPACE_WIDTH_PX,

  // Measurer
  TextMeasurer,
  type CharMeasurement,
  type TextMeasurement,
  detectScript,
  isCJKCharacter,
  isKoreanCharacter,

  // Wrapper
  TextWrapper,
  type WrapOptions,
  type WrapResult,
  type LineMetrics,
  type BreakMode,
  DEFAULT_WRAP_OPTIONS,

  // Helpers
  DisplayHelpers,
  ScrollView,

  // Factory functions
  createDisplayToolkit,
  createG1Toolkit,
  createG1LegacyToolkit,
  createZ100Toolkit,
  createNexToolkit,
} from "@mentra/display-utils"
