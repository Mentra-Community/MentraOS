/**
 * Display profile for a specific glasses model.
 * All text measurement and wrapping derives from this configuration.
 */
export interface DisplayProfile {
  /** Unique identifier for this glasses model */
  id: string

  /** Human-readable name */
  name: string

  /** Display width in pixels */
  displayWidthPx: number

  /** Display height in pixels (if applicable) */
  displayHeightPx?: number

  /** Maximum number of lines that can be displayed */
  maxLines: number

  /** Maximum safe payload size in bytes (for BLE transmission) */
  maxPayloadBytes: number

  /** BLE chunk size for transmission */
  bleChunkSize: number

  /** Font metrics for text measurement */
  fontMetrics: FontMetrics

  /** Optional constraints */
  constraints?: DisplayConstraints
}

/**
 * Font metrics for pixel-accurate text measurement.
 */
export interface FontMetrics {
  /**
   * Map of character to glyph width in pixels.
   * Keys are single characters.
   */
  glyphWidths: Map<string, number>

  /** Default glyph width for unmapped characters */
  defaultGlyphWidth: number

  /**
   * Formula to convert glyph width to rendered pixel width.
   * G1 example: (glyphWidth + 1) * 2
   */
  renderFormula: (glyphWidth: number) => number

  /**
   * Uniform-width scripts - verified to render all characters at same width.
   * These are NOT averages - they are the actual uniform width in RENDERED pixels.
   */
  uniformScripts: UniformScriptWidths

  /**
   * Fallback configuration for unmapped characters.
   */
  fallback: FallbackConfig
}

/**
 * Uniform width scripts - these scripts render all characters at the same width.
 * Values are in RENDERED pixels (after applying renderFormula if applicable).
 * Verified through hardware testing.
 */
export interface UniformScriptWidths {
  /** Chinese, Japanese Kanji - all chars same width */
  cjk: number
  /** Japanese Hiragana - all chars same width */
  hiragana: number
  /** Japanese Katakana - all chars same width */
  katakana: number
  /** Korean Hangul - all chars same width */
  korean: number
  /** Russian, etc. - all chars same width */
  cyrillic: number
}

/**
 * Fallback strategy for unmapped characters.
 */
export interface FallbackConfig {
  /**
   * Max known Latin width for safe fallback (in rendered pixels).
   * Using max ensures we never overflow (worst case: slight under-utilization).
   */
  latinMaxWidth: number

  /** What to do with completely unknown characters */
  unknownBehavior: "useLatinMax" | "throw" | "filter"
}

/**
 * Optional display constraints.
 */
export interface DisplayConstraints {
  /** Minimum characters before allowing hyphen break */
  minCharsBeforeHyphen?: number

  /** Characters that should not appear at start of line (kinsoku) */
  noStartChars?: string[]

  /** Characters that should not appear at end of line (kinsoku) */
  noEndChars?: string[]
}

/**
 * Script type for character classification.
 */
export type ScriptType =
  | "latin"
  | "cjk"
  | "hiragana"
  | "katakana"
  | "korean"
  | "cyrillic"
  | "numbers"
  | "punctuation"
  | "unsupported"
