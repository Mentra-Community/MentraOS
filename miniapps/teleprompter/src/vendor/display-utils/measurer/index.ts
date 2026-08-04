/**
 * Text Measurer Module
 *
 * Provides pixel-accurate text measurement based on display profiles.
 * All measurements are in actual rendered pixels, not abstract units.
 */

// Main class
export { TextMeasurer } from "./TextMeasurer"
export type { CharMeasurement, TextMeasurement } from "./TextMeasurer"

// Script detection utilities
export {
  detectScript,
  isCJKCharacter,
  isKoreanCharacter,
  isUniformWidthScript,
  isUnsupportedScript,
  needsHyphenForBreak,
  SCRIPT_RANGES,
} from "./script-detection"
