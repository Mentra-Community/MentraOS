/**
 * Visual Width Utilities
 *
 * Calculates the visual width of text based on character types.
 * Used to ensure text fits within glasses display without overflow.
 *
 * Width ratios based on real-world testing on Even Realities G1:
 * - Latin characters (a-z, A-Z, 0-9): 1.0 unit
 * - CJK characters (Chinese, Japanese, Korean): 2.0 units
 * - Full-width characters: 2.0 units
 * - Emoji: 2.0 units
 *
 * The max safe visual width for glasses is ~44 units (tested with Latin text).
 */

/**
 * Check if a character is a CJK (Chinese, Japanese, Korean) character
 */
export function isCJKCharacter(char: string): boolean {
  const code = char.charCodeAt(0)
  return (
    // CJK Unified Ideographs (Chinese characters)
    (code >= 0x4e00 && code <= 0x9fff) ||
    // CJK Unified Ideographs Extension A
    (code >= 0x3400 && code <= 0x4dbf) ||
    // CJK Unified Ideographs Extension B-F (requires surrogate pair check)
    (code >= 0x20000 && code <= 0x2a6df) ||
    // CJK Compatibility Ideographs
    (code >= 0xf900 && code <= 0xfaff) ||
    // CJK Punctuation and Symbols
    (code >= 0x3000 && code <= 0x303f) ||
    // Hiragana (Japanese)
    (code >= 0x3040 && code <= 0x309f) ||
    // Katakana (Japanese)
    (code >= 0x30a0 && code <= 0x30ff) ||
    // Katakana Phonetic Extensions
    (code >= 0x31f0 && code <= 0x31ff) ||
    // Korean Hangul Syllables
    (code >= 0xac00 && code <= 0xd7af) ||
    // Korean Hangul Jamo
    (code >= 0x1100 && code <= 0x11ff) ||
    // Korean Hangul Compatibility Jamo
    (code >= 0x3130 && code <= 0x318f) ||
    // Bopomofo (Chinese phonetic)
    (code >= 0x3100 && code <= 0x312f) ||
    // CJK Radicals Supplement
    (code >= 0x2e80 && code <= 0x2eff) ||
    // Kangxi Radicals
    (code >= 0x2f00 && code <= 0x2fdf) ||
    // CJK Strokes
    (code >= 0x31c0 && code <= 0x31ef)
  )
}

/**
 * Check if a character is a full-width character (excluding CJK which is handled separately)
 */
export function isFullWidthCharacter(char: string): boolean {
  const code = char.charCodeAt(0)
  return (
    // Fullwidth ASCII variants
    (code >= 0xff01 && code <= 0xff5e) ||
    // Fullwidth brackets and symbols
    (code >= 0xff5f && code <= 0xff60) ||
    // Halfwidth and Fullwidth Forms (fullwidth portion)
    (code >= 0xffe0 && code <= 0xffe6)
  )
}

/**
 * Check if a character is an emoji
 * This is a simplified check - emojis are complex with combining characters
 */
export function isEmoji(char: string): boolean {
  const code = char.charCodeAt(0)
  return (
    // Emoticons
    (code >= 0x1f600 && code <= 0x1f64f) ||
    // Miscellaneous Symbols and Pictographs
    (code >= 0x1f300 && code <= 0x1f5ff) ||
    // Transport and Map Symbols
    (code >= 0x1f680 && code <= 0x1f6ff) ||
    // Symbols and Pictographs Extended-A
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    // Supplemental Symbols and Pictographs
    (code >= 0x1fa00 && code <= 0x1fa6f) ||
    // Dingbats
    (code >= 0x2700 && code <= 0x27bf) ||
    // Miscellaneous Symbols
    (code >= 0x2600 && code <= 0x26ff)
  )
}

/**
 * Width ratios for different character types
 * Based on real-world testing on Even Realities G1 glasses
 */
export const CharWidthRatios = {
  CJK: 2.0, // Chinese, Japanese, Korean characters
  FULL_WIDTH: 2.0, // Full-width Latin, symbols
  EMOJI: 2.0, // Emoji characters
  LATIN: 1.0, // Standard Latin, numbers, punctuation
} as const

/**
 * Get the visual width of a single character
 *
 * @param char - Single character to measure
 * @returns Visual width in units (1.0 = standard Latin character width)
 */
export function getCharWidth(char: string): number {
  if (!char || char.length === 0) return 0

  // Check in order of likelihood for transcription content
  if (isCJKCharacter(char)) {
    return CharWidthRatios.CJK
  }

  if (isFullWidthCharacter(char)) {
    return CharWidthRatios.FULL_WIDTH
  }

  if (isEmoji(char)) {
    return CharWidthRatios.EMOJI
  }

  // Default to Latin width for everything else
  return CharWidthRatios.LATIN
}

/**
 * Calculate the total visual width of a text string
 *
 * @param text - Text to measure
 * @returns Total visual width in units
 */
export function getTextVisualWidth(text: string): number {
  if (!text) return 0

  let totalWidth = 0
  for (const char of text) {
    totalWidth += getCharWidth(char)
  }
  return totalWidth
}

/**
 * Find the maximum number of characters that fit within a visual width limit
 *
 * @param text - Text to measure
 * @param maxVisualWidth - Maximum visual width allowed
 * @param startIndex - Starting index in text (default: 0)
 * @returns Number of characters that fit within the limit
 */
export function getCharsWithinVisualWidth(text: string, maxVisualWidth: number, startIndex: number = 0): number {
  if (!text || startIndex >= text.length) return 0

  let currentWidth = 0
  let charCount = 0

  for (let i = startIndex; i < text.length; i++) {
    const charWidth = getCharWidth(text[i])

    if (currentWidth + charWidth > maxVisualWidth) {
      break
    }

    currentWidth += charWidth
    charCount++
  }

  return charCount
}

/**
 * Visual width settings based on user preference
 * These are in visual width units (1 unit = 1 Latin character width)
 *
 * Hardware max: 576px
 * With mobile passthrough (no mobile wrapping), we use full width:
 * - Average Latin char = 12px → 576/12 = 48 chars
 * - For safety with mixed content, we use slightly conservative values
 *
 * CJK characters count as 2 units each, so max CJK chars = visual_width / 2
 */
export const VisualWidthSettings = {
  narrow: 40, // ~480px - conservative for mixed content
  medium: 48, // ~576px - full width for average Latin
  wide: 52, // ~576px+ - allows narrow chars to pack more
} as const

/**
 * Convert a width setting (0, 1, 2 or "narrow", "medium", "wide") to visual width units
 *
 * @param width - Width setting as number or string
 * @returns Visual width in units
 */
export function getVisualWidthForSetting(width: string | number): number {
  // Handle numeric enum values (0=Narrow, 1=Medium, 2=Wide)
  if (typeof width === "number") {
    switch (width) {
      case 0:
        return VisualWidthSettings.narrow
      case 1:
        return VisualWidthSettings.medium
      case 2:
        return VisualWidthSettings.wide
      default:
        // If it's already a visual width value, return as-is
        if (width > 2) {
          return width
        }
        return VisualWidthSettings.wide
    }
  }

  // Handle string values
  switch (width.toLowerCase()) {
    case "narrow":
    case "0":
      return VisualWidthSettings.narrow
    case "medium":
    case "1":
      return VisualWidthSettings.medium
    case "wide":
    case "2":
      return VisualWidthSettings.wide
    default:
      return VisualWidthSettings.wide
  }
}

/**
 * Safety margin to apply to visual width calculations
 * Set to 1.0 (no margin) - visual width calculations are accurate enough
 */
export const VISUAL_WIDTH_SAFETY_MARGIN = 1.0 // No safety margin - use full width
