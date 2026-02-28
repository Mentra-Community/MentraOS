import type { DisplayProfile, ScriptType } from "../profiles/types"
import { detectScript, isUniformWidthScript } from "./script-detection"

/**
 * Character measurement result with detailed breakdown.
 */
export interface CharMeasurement {
  /** The character measured */
  char: string
  /** Width in rendered pixels */
  widthPx: number
  /** The script type of the character */
  script: ScriptType
  /** Whether width came from glyph map (true) or fallback (false) */
  fromGlyphMap: boolean
}

/**
 * Text measurement result with detailed breakdown.
 */
export interface TextMeasurement {
  /** The text measured */
  text: string
  /** Total width in rendered pixels */
  totalWidthPx: number
  /** Number of characters */
  charCount: number
  /** Per-character measurements (optional, for debugging) */
  chars?: CharMeasurement[]
}

/**
 * Measures text width in pixels based on a DisplayProfile.
 * All measurements are in actual rendered pixels, not abstract units.
 *
 * Key features:
 * - Pixel-perfect measurement for mapped characters
 * - Uniform-width handling for CJK, Korean, Cyrillic
 * - Safe fallback for unmapped Latin characters
 * - Caching for performance
 */
export class TextMeasurer {
  private readonly profile: DisplayProfile
  private readonly charCache: Map<string, number> = new Map()

  constructor(profile: DisplayProfile) {
    this.profile = profile
    // Pre-populate cache with known glyphs
    this.buildCharCache()
  }

  /**
   * Pre-compute rendered widths for all known glyphs.
   */
  private buildCharCache(): void {
    const { glyphWidths, renderFormula } = this.profile.fontMetrics

    for (const [char, glyphWidth] of glyphWidths.entries()) {
      const renderedWidth = renderFormula(glyphWidth)
      this.charCache.set(char, renderedWidth)
    }
  }

  /**
   * Measure the total pixel width of a text string.
   *
   * @param text - The text to measure
   * @returns Width in rendered pixels
   */
  measureText(text: string): number {
    if (!text || text.length === 0) {
      return 0
    }

    let totalWidth = 0
    for (const char of text) {
      totalWidth += this.measureChar(char)
    }
    return totalWidth
  }

  /**
   * Measure text with detailed breakdown of each character.
   *
   * @param text - The text to measure
   * @returns Detailed measurement result
   */
  measureTextDetailed(text: string): TextMeasurement {
    if (!text || text.length === 0) {
      return {
        text: "",
        totalWidthPx: 0,
        charCount: 0,
        chars: [],
      }
    }

    const chars: CharMeasurement[] = []
    let totalWidth = 0

    for (const char of text) {
      const script = detectScript(char)
      const widthPx = this.measureChar(char)
      const fromGlyphMap = this.profile.fontMetrics.glyphWidths.has(char)

      chars.push({
        char,
        widthPx,
        script,
        fromGlyphMap,
      })

      totalWidth += widthPx
    }

    return {
      text,
      totalWidthPx: totalWidth,
      charCount: chars.length,
      chars,
    }
  }

  /**
   * Measure a single character's pixel width.
   *
   * IMPORTANT: This is PIXEL-PERFECT measurement, not averaging!
   * - Mapped characters: exact width from glyph map
   * - Uniform scripts (CJK, Korean, Cyrillic): verified uniform width
   * - Unmapped Latin: MAX width fallback (safe, never overflow)
   *
   * @param char - Single character to measure
   * @returns Width in rendered pixels
   */
  measureChar(char: string): number {
    if (!char || char.length === 0) {
      return 0
    }

    // Check cache first (includes pre-computed glyph map entries)
    const cached = this.charCache.get(char)
    if (cached !== undefined) {
      return cached
    }

    // Calculate width based on script type
    const width = this.calculateCharWidth(char)

    // Cache for future lookups
    this.charCache.set(char, width)

    return width
  }

  /**
   * Calculate character width (called when not in cache).
   */
  private calculateCharWidth(char: string): number {
    const { fontMetrics } = this.profile
    const { uniformScripts, fallback, renderFormula, glyphWidths } = fontMetrics

    // 1. Check explicit glyph map (pixel-perfect for Latin)
    const glyphWidth = glyphWidths.get(char)
    if (glyphWidth !== undefined) {
      return renderFormula(glyphWidth)
    }

    // 2. Uniform-width scripts (verified monospace - NOT averages!)
    const script = detectScript(char)

    switch (script) {
      case "cjk":
        return uniformScripts.cjk // ALL CJK chars are exactly this width
      case "hiragana":
        return uniformScripts.hiragana // ALL Hiragana chars are exactly this width
      case "katakana":
        return uniformScripts.katakana // ALL Katakana chars are exactly this width
      case "korean":
        return uniformScripts.korean // ALL Korean chars are exactly this width
      case "cyrillic":
        return uniformScripts.cyrillic // ALL Cyrillic chars are exactly this width
    }

    // 3. Unmapped Latin or unknown: use MAX width (safe fallback)
    // This guarantees we NEVER overflow - worst case is slight under-utilization
    return fallback.latinMaxWidth
  }

  /**
   * Get the raw glyph width (before render formula).
   * Returns undefined for unmapped characters.
   *
   * @param char - Single character
   * @returns Glyph width in pixels, or undefined if not in glyph map
   */
  getGlyphWidth(char: string): number | undefined {
    return this.profile.fontMetrics.glyphWidths.get(char)
  }

  /**
   * Check if text fits within a pixel width.
   *
   * @param text - Text to check
   * @param maxWidthPx - Maximum width in pixels
   * @returns true if text fits
   */
  fitsInWidth(text: string, maxWidthPx: number): boolean {
    return this.measureText(text) <= maxWidthPx
  }

  /**
   * Find how many characters fit within a pixel width.
   *
   * @param text - Text to measure
   * @param maxWidthPx - Maximum width in pixels
   * @param startIndex - Starting index (default: 0)
   * @returns Number of characters that fit
   */
  charsThatFit(text: string, maxWidthPx: number, startIndex: number = 0): number {
    if (!text || startIndex >= text.length) {
      return 0
    }

    let currentWidth = 0
    let count = 0

    // Use Array.from to handle surrogate pairs correctly
    const chars = Array.from(text).slice(startIndex)

    for (const char of chars) {
      const charWidth = this.measureChar(char)

      if (currentWidth + charWidth > maxWidthPx) {
        break
      }

      currentWidth += charWidth
      count++
    }

    return count
  }

  /**
   * Find the pixel position of a character index in text.
   *
   * @param text - Text to measure
   * @param index - Character index
   * @returns Pixel offset from start of text
   */
  getPixelOffset(text: string, index: number): number {
    if (!text || index <= 0) {
      return 0
    }

    const chars = Array.from(text).slice(0, index)
    let offset = 0

    for (const char of chars) {
      offset += this.measureChar(char)
    }

    return offset
  }

  /**
   * Detect the script type of a character.
   *
   * @param char - Single character
   * @returns Script type
   */
  detectScript(char: string): ScriptType {
    return detectScript(char)
  }

  /**
   * Check if a character is from a uniform-width script.
   *
   * @param char - Single character
   * @returns true if character is from CJK, Korean, or Cyrillic
   */
  isUniformWidth(char: string): boolean {
    return isUniformWidthScript(char)
  }

  /**
   * Get the display profile.
   */
  getProfile(): DisplayProfile {
    return this.profile
  }

  /**
   * Get the display width in pixels.
   */
  getDisplayWidthPx(): number {
    return this.profile.displayWidthPx
  }

  /**
   * Get the maximum number of lines.
   */
  getMaxLines(): number {
    return this.profile.maxLines
  }

  /**
   * Get the maximum payload size in bytes.
   */
  getMaxPayloadBytes(): number {
    return this.profile.maxPayloadBytes
  }

  /**
   * Calculate the UTF-8 byte size of text.
   *
   * @param text - Text to measure
   * @returns Byte size
   */
  getByteSize(text: string): number {
    return new TextEncoder().encode(text).length
  }

  /**
   * Get the width of a hyphen character in rendered pixels.
   */
  getHyphenWidth(): number {
    return this.measureChar("-")
  }

  /**
   * Get the width of a space character in rendered pixels.
   */
  getSpaceWidth(): number {
    return this.measureChar(" ")
  }

  /**
   * Clear the character cache.
   * Useful if profile metrics change at runtime.
   */
  clearCache(): void {
    this.charCache.clear()
    this.buildCharCache()
  }
}
