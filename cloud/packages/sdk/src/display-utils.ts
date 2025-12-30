/**
 * Display Utils
 *
 * Glasses-agnostic, pixel-accurate text measurement and wrapping library
 * for smart glasses displays.
 *
 * @example
 * ```typescript
 * import {
 *   TextMeasurer,
 *   TextWrapper,
 *   DisplayHelpers,
 *   ScrollView,
 *   G1_PROFILE,
 *   createG1Toolkit
 * } from '@mentra/sdk/display-utils'
 *
 * // Quick start
 * const { wrapper } = createG1Toolkit()
 * const result = wrapper.wrap("Your text here")
 *
 * // Scrollable content
 * const scrollView = new ScrollView(measurer, wrapper)
 * scrollView.setContent("Very long text...")
 * scrollView.scrollDown()
 * const viewport = scrollView.getViewport()
 * ```
 */

// Re-export everything from local display-utils source
export {
  // Profiles
  type DisplayProfile,
  type FontMetrics,
  type UniformScriptWidths,
  type FallbackConfig,
  type DisplayConstraints,
  type ScriptType,
  G1_PROFILE,
  G1_PROFILE_LEGACY,
  G1_HYPHEN_WIDTH_PX,
  G1_SPACE_WIDTH_PX,

  // Measurer
  TextMeasurer,
  type CharMeasurement,
  type TextMeasurement,
  detectScript,
  isCJKCharacter,
  isKoreanCharacter,
  isUniformWidthScript,
  isUnsupportedScript,
  needsHyphenForBreak,
  SCRIPT_RANGES,

  // Wrapper
  TextWrapper,
  type WrapOptions,
  type WrapResult,
  type LineMetrics,
  type BreakMode,
  DEFAULT_WRAP_OPTIONS,

  // Helpers
  DisplayHelpers,
  type TruncateResult,
  type Page,
  type Chunk,

  // ScrollView
  ScrollView,
  type ScrollPosition,
  type ScrollViewport,

  // Factory functions
  createDisplayToolkit,
  createG1Toolkit,
  createG1LegacyToolkit,
} from "./display-utils/index"
