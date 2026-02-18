/**
 * G1 Glasses Glyph Width Data
 *
 * Complete glyph width mapping from G1FontLoaderKt for accurate text width calculations.
 * Used for cloud-side text wrapping to match glasses display behavior.
 *
 * Formula: pixel_width = (glyph_width + 1) × 2
 */

// Hardware constants
export const DISPLAY_WIDTH_PX = 576 // Verified hardware max width
export const MAX_SAFE_BYTES = 390 // Safe total payload (crashes at ~400)
export const MAX_BLE_CHUNK_SIZE = 176 // BLE packet size limit
export const MAX_LINES = 5 // Max lines per screen

/**
 * Complete Latin glyph width map from G1FontLoaderKt
 * Key: character, Value: glyph width in pixels (before formula applied)
 */
export const LATIN_GLYPH_WIDTHS: Record<string, number> = {
  // Space and punctuation
  " ": 2,
  "!": 1,
  '"': 2,
  "#": 6,
  "$": 5,
  "%": 6,
  "&": 7,
  "'": 1,
  "(": 2,
  ")": 2,
  "*": 3,
  "+": 4,
  ",": 1,
  "-": 4,
  ".": 1,
  "/": 3,

  // Numbers
  "0": 5,
  "1": 3,
  "2": 5,
  "3": 5,
  "4": 5,
  "5": 5,
  "6": 5,
  "7": 5,
  "8": 5,
  "9": 5,

  // More punctuation
  ":": 1,
  ";": 1,
  "<": 4,
  "=": 4,
  ">": 4,
  "?": 5,
  "@": 7,

  // Uppercase letters
  "A": 6,
  "B": 5,
  "C": 5,
  "D": 5,
  "E": 4,
  "F": 4,
  "G": 5,
  "H": 5,
  "I": 2,
  "J": 3,
  "K": 5,
  "L": 4,
  "M": 7,
  "N": 5,
  "O": 5,
  "P": 5,
  "Q": 5,
  "R": 5,
  "S": 5,
  "T": 5,
  "U": 5,
  "V": 6,
  "W": 7,
  "X": 6,
  "Y": 6,
  "Z": 5,

  // Brackets and special
  "[": 2,
  "\\": 3,
  "]": 2,
  "^": 4,
  "_": 3,
  "`": 2,

  // Lowercase letters
  "a": 5,
  "b": 4,
  "c": 4,
  "d": 4,
  "e": 4,
  "f": 4,
  "g": 4,
  "h": 4,
  "i": 1,
  "j": 2,
  "k": 4,
  "l": 1,
  "m": 7,
  "n": 4,
  "o": 4,
  "p": 4,
  "q": 4,
  "r": 3,
  "s": 4,
  "t": 3,
  "u": 5,
  "v": 5,
  "w": 7,
  "x": 5,
  "y": 5,
  "z": 4,

  // More special characters
  "{": 3,
  "|": 1,
  "}": 3,
  "~": 7,

  // Extended Latin (accented characters)
  "À": 6,
  "Á": 6,
  "Â": 6,
  "Ä": 6,
  "Ç": 5,
  "È": 4,
  "É": 4,
  "Ê": 4,
  "Ë": 4,
  "Í": 2,
  "Î": 3,
  "Ï": 3,
  "Ñ": 5,
  "Ó": 5,
  "Ô": 5,
  "Ö": 5,
  "Ù": 5,
  "Ú": 5,
  "Û": 5,
  "Ü": 5,
  "Ÿ": 6,

  // Lowercase accented
  "à": 5,
  "á": 5,
  "â": 5,
  "ä": 5,
  "ç": 4,
  "è": 4,
  "é": 4,
  "ê": 4,
  "ë": 4,
  "í": 2,
  "î": 3,
  "ï": 3,
  "ñ": 4,
  "ó": 4,
  "ô": 4,
  "ö": 4,
  "ù": 5,
  "ú": 5,
  "û": 5,
  "ü": 5,
  "ÿ": 5,

  // German special
  "ß": 4,
  "ẞ": 5,
}

/**
 * CJK (Chinese/Japanese/Korean) pixel widths per character
 * These are already in rendered pixels (not glyph width)
 */
export const CJK_PIXEL_WIDTHS = {
  chinese_simple: 18, // 一, 的, 丨 - max 32 chars
  chinese_complex: 16, // 國 - max 36 chars
  japanese_hiragana: 18, // あ, こ - max 32 chars
  japanese_katakana: 18, // ア, コ - max 32 chars
  japanese_kanji: 18, // 日, 本 - max 32 chars
  korean_hangul: 24, // 가, 한 - max 24 chars
} as const

/**
 * Cyrillic pixel width (already in rendered pixels)
 */
export const CYRILLIC_PIXEL_WIDTH = 18 // max 32 chars

/**
 * Default glyph width for unknown Latin characters
 */
export const DEFAULT_LATIN_GLYPH_WIDTH = 5

/**
 * Default pixel width for unknown characters
 */
export const DEFAULT_PIXEL_WIDTH = 12

/**
 * Script detection ranges (Unicode code points)
 */
export const SCRIPT_RANGES = {
  // CJK Unified Ideographs (Chinese/Japanese Kanji)
  cjk_unified: {start: 0x4e00, end: 0x9fff},

  // CJK Extension A
  cjk_ext_a: {start: 0x3400, end: 0x4dbf},

  // Japanese Hiragana
  hiragana: {start: 0x3040, end: 0x309f},

  // Japanese Katakana
  katakana: {start: 0x30a0, end: 0x30ff},

  // Korean Hangul Syllables
  hangul: {start: 0xac00, end: 0xd7af},

  // Korean Hangul Jamo
  hangul_jamo: {start: 0x1100, end: 0x11ff},

  // Cyrillic
  cyrillic: {start: 0x0400, end: 0x04ff},

  // Arabic (not supported)
  arabic: {start: 0x0600, end: 0x06ff},

  // Hebrew (not supported)
  hebrew: {start: 0x0590, end: 0x05ff},

  // Thai (not supported)
  thai: {start: 0x0e00, end: 0x0e7f},

  // Emoji ranges (not supported)
  emoji_misc: {start: 0x1f300, end: 0x1f9ff},
  emoji_faces: {start: 0x1f600, end: 0x1f64f},
} as const

/**
 * Supported script types
 */
export type ScriptType =
  | "latin"
  | "chinese"
  | "japanese_hiragana"
  | "japanese_katakana"
  | "japanese_kanji"
  | "korean"
  | "cyrillic"
  | "unsupported"

/**
 * Detect the script type of a character
 */
export function detectScript(char: string): ScriptType {
  const code = char.charCodeAt(0)

  // Check CJK ranges
  if (
    (code >= SCRIPT_RANGES.cjk_unified.start && code <= SCRIPT_RANGES.cjk_unified.end) ||
    (code >= SCRIPT_RANGES.cjk_ext_a.start && code <= SCRIPT_RANGES.cjk_ext_a.end)
  ) {
    return "chinese" // Could be Chinese or Japanese Kanji
  }

  // Japanese Hiragana
  if (code >= SCRIPT_RANGES.hiragana.start && code <= SCRIPT_RANGES.hiragana.end) {
    return "japanese_hiragana"
  }

  // Japanese Katakana
  if (code >= SCRIPT_RANGES.katakana.start && code <= SCRIPT_RANGES.katakana.end) {
    return "japanese_katakana"
  }

  // Korean Hangul
  if (
    (code >= SCRIPT_RANGES.hangul.start && code <= SCRIPT_RANGES.hangul.end) ||
    (code >= SCRIPT_RANGES.hangul_jamo.start && code <= SCRIPT_RANGES.hangul_jamo.end)
  ) {
    return "korean"
  }

  // Cyrillic
  if (code >= SCRIPT_RANGES.cyrillic.start && code <= SCRIPT_RANGES.cyrillic.end) {
    return "cyrillic"
  }

  // Unsupported scripts
  if (
    (code >= SCRIPT_RANGES.arabic.start && code <= SCRIPT_RANGES.arabic.end) ||
    (code >= SCRIPT_RANGES.hebrew.start && code <= SCRIPT_RANGES.hebrew.end) ||
    (code >= SCRIPT_RANGES.thai.start && code <= SCRIPT_RANGES.thai.end) ||
    (code >= SCRIPT_RANGES.emoji_misc.start && code <= SCRIPT_RANGES.emoji_misc.end) ||
    (code >= SCRIPT_RANGES.emoji_faces.start && code <= SCRIPT_RANGES.emoji_faces.end)
  ) {
    return "unsupported"
  }

  // Default to Latin (includes ASCII, extended Latin, etc.)
  return "latin"
}

/**
 * Get the glyph width for a Latin character
 */
export function getLatinGlyphWidth(char: string): number {
  return LATIN_GLYPH_WIDTHS[char] ?? DEFAULT_LATIN_GLYPH_WIDTH
}

/**
 * Calculate rendered pixel width for a single character
 * Uses the G1 formula: (glyph_width + 1) × 2 for Latin
 */
export function getCharPixelWidth(char: string): number {
  const script = detectScript(char)

  switch (script) {
    case "latin": {
      const glyphWidth = getLatinGlyphWidth(char)
      return (glyphWidth + 1) * 2
    }

    case "chinese":
    case "japanese_kanji":
      return CJK_PIXEL_WIDTHS.chinese_simple // 18px

    case "japanese_hiragana":
      return CJK_PIXEL_WIDTHS.japanese_hiragana // 18px

    case "japanese_katakana":
      return CJK_PIXEL_WIDTHS.japanese_katakana // 18px

    case "korean":
      return CJK_PIXEL_WIDTHS.korean_hangul // 24px

    case "cyrillic":
      return CYRILLIC_PIXEL_WIDTH // 18px

    case "unsupported":
      return DEFAULT_PIXEL_WIDTH // Will likely not render

    default:
      return DEFAULT_PIXEL_WIDTH
  }
}

/**
 * Calculate total pixel width for a string
 */
export function calculateTextWidth(text: string): number {
  let width = 0
  for (const char of text) {
    width += getCharPixelWidth(char)
  }
  return width
}

/**
 * Calculate byte size in UTF-8
 */
export function calculateByteSize(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * Check if a character is supported by the G1 glasses
 */
export function isCharSupported(char: string): boolean {
  return detectScript(char) !== "unsupported"
}

/**
 * Check if a string contains only supported characters
 */
export function isTextSupported(text: string): boolean {
  for (const char of text) {
    if (!isCharSupported(char)) {
      return false
    }
  }
  return true
}

/**
 * Get unsupported characters in a string
 */
export function getUnsupportedChars(text: string): string[] {
  const unsupported: string[] = []
  for (const char of text) {
    if (!isCharSupported(char) && !unsupported.includes(char)) {
      unsupported.push(char)
    }
  }
  return unsupported
}

/**
 * Analyze a string for display metrics
 */
export interface TextAnalysis {
  text: string
  charCount: number
  pixelWidth: number
  byteSize: number
  fitsOneLine: boolean
  isSupported: boolean
  unsupportedChars: string[]
  dominantScript: ScriptType
  exceedsByteLimit: boolean
}

export function analyzeText(text: string): TextAnalysis {
  const charCount = text.length
  const pixelWidth = calculateTextWidth(text)
  const byteSize = calculateByteSize(text)
  const unsupportedChars = getUnsupportedChars(text)

  // Determine dominant script
  const scriptCounts: Record<ScriptType, number> = {
    latin: 0,
    chinese: 0,
    japanese_hiragana: 0,
    japanese_katakana: 0,
    japanese_kanji: 0,
    korean: 0,
    cyrillic: 0,
    unsupported: 0,
  }

  for (const char of text) {
    const script = detectScript(char)
    scriptCounts[script]++
  }

  let dominantScript: ScriptType = "latin"
  let maxCount = 0
  for (const [script, count] of Object.entries(scriptCounts)) {
    if (count > maxCount) {
      maxCount = count
      dominantScript = script as ScriptType
    }
  }

  return {
    text,
    charCount,
    pixelWidth,
    byteSize,
    fitsOneLine: pixelWidth <= DISPLAY_WIDTH_PX,
    isSupported: unsupportedChars.length === 0,
    unsupportedChars,
    dominantScript,
    exceedsByteLimit: byteSize > MAX_SAFE_BYTES,
  }
}

/**
 * Get maximum characters per line for a script
 */
export function getMaxCharsPerLine(script: ScriptType): number {
  switch (script) {
    case "latin":
      return 48 // Average Latin (varies 36-144 based on char width)
    case "chinese":
    case "japanese_kanji":
    case "japanese_hiragana":
    case "japanese_katakana":
      return 32
    case "korean":
      return 24
    case "cyrillic":
      return 32
    default:
      return 36 // Conservative fallback
  }
}

/**
 * Get safe characters per line (accounting for byte limits)
 */
export function getSafeCharsPerLine(script: ScriptType): number {
  switch (script) {
    case "latin":
      return 48
    case "chinese":
    case "japanese_kanji":
    case "japanese_hiragana":
    case "japanese_katakana":
      return 26 // 26 × 3 bytes × 5 lines = 390 bytes
    case "korean":
      return 22 // 22 × 3 bytes × 5 lines = 330 bytes
    case "cyrillic":
      return 32
    default:
      return 26
  }
}
