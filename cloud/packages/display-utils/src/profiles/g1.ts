import {DisplayProfile} from "./types"

/**
 * Complete G1 glyph widths from G1FontLoaderKt
 * These are GLYPH widths - multiply using renderFormula to get rendered pixels.
 * Rendered width = (glyphWidth + 1) * 2
 */
const G1_GLYPH_WIDTHS: Record<string, number> = {
  // Punctuation & Symbols
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
  "-": 4, // Hyphen: 4px glyph → 10px rendered (CRITICAL for breaking!)
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

  // Uppercase
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

  // Brackets & special
  "[": 2,
  "\\": 3,
  "]": 2,
  "^": 4,
  "_": 3,
  "`": 2,

  // Lowercase
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

  // More special
  "{": 3,
  "|": 1,
  "}": 3,
  "~": 7,
}

/**
 * Even Realities G1 Smart Glasses Display Profile
 *
 * Verified through empirical testing with actual hardware.
 * See: line-width-debug-tool/line-width-spec.md
 */
export const G1_PROFILE: DisplayProfile = {
  id: "even-realities-g1",
  name: "Even Realities G1",

  // Display dimensions
  displayWidthPx: 576,
  maxLines: 5,

  // BLE constraints
  maxPayloadBytes: 390,
  bleChunkSize: 176,

  // Font metrics
  fontMetrics: {
    // Glyph widths from G1FontLoaderKt
    glyphWidths: new Map(Object.entries(G1_GLYPH_WIDTHS)),

    // Default glyph width for unmapped Latin characters (use max to be safe)
    defaultGlyphWidth: 7,

    // Rendered width = (glyphWidth + 1) * 2
    renderFormula: (glyphWidth: number) => (glyphWidth + 1) * 2,

    // Uniform-width scripts - ALL characters in these scripts render at this exact width
    // These are verified values in RENDERED pixels, NOT averages
    uniformScripts: {
      cjk: 18, // ALL Chinese/Japanese Kanji chars = 18px (verified)
      hiragana: 18, // ALL Hiragana chars = 18px (verified)
      katakana: 18, // ALL Katakana chars = 18px (verified)
      korean: 24, // ALL Korean Hangul chars = 24px (verified)
      cyrillic: 18, // ALL Cyrillic chars = 18px (verified)
    },

    // Fallback for unmapped Latin characters
    // Uses MAX width to guarantee no overflow (safe under-utilization)
    fallback: {
      latinMaxWidth: 16, // Max Latin = 'm', 'w' at (7+1)*2 = 16px
      unknownBehavior: "useLatinMax",
    },
  },

  constraints: {
    minCharsBeforeHyphen: 3,
    // Kinsoku: Characters that should not appear at start of line
    noStartChars: [".", ",", "!", "?", ":", ";", ")", "]", "}", "。", "，", "！", "？", "：", "；", "）", "】", "」"],
    // Kinsoku: Characters that should not appear at end of line
    noEndChars: ["(", "[", "{", "（", "【", "「"],
  },
}

/**
 * G1 Profile for LEGACY mobile clients that have their own wrapping logic.
 *
 * Old mobile clients re-wrap text received from the cloud, causing double-wrapping.
 * This profile uses a reduced display width (~522px instead of 576px) so that
 * when the mobile client re-wraps, the result still fits within 5 lines.
 *
 * Use this profile when:
 * - Mobile client version < X.X.X (has old wrapping logic)
 * - You see text getting cut off or exceeding 5 lines
 *
 * Once all clients are updated, this can be deprecated.
 */
export const G1_PROFILE_LEGACY: DisplayProfile = {
  id: "even-realities-g1-legacy",
  name: "Even Realities G1 (Legacy Client Compatibility)",

  // Reduced display width to prevent double-wrapping overflow
  // Old mobile client wraps at ~90% of true width
  displayWidthPx: 420,
  maxLines: 5,

  // BLE constraints (same as standard)
  maxPayloadBytes: 390,
  bleChunkSize: 176,

  // Font metrics (same as standard)
  fontMetrics: {
    glyphWidths: new Map(Object.entries(G1_GLYPH_WIDTHS)),
    defaultGlyphWidth: 7,
    renderFormula: (glyphWidth: number) => (glyphWidth + 1) * 2,
    uniformScripts: {
      cjk: 18,
      hiragana: 18,
      katakana: 18,
      korean: 24,
      cyrillic: 18,
    },
    fallback: {
      latinMaxWidth: 16,
      unknownBehavior: "useLatinMax",
    },
  },

  constraints: {
    minCharsBeforeHyphen: 3,
    noStartChars: [".", ",", "!", "?", ":", ";", ")", "]", "}", "。", "，", "！", "？", "：", "；", "）", "】", "」"],
    noEndChars: ["(", "[", "{", "（", "【", "「"],
  },
}

/**
 * Get the hyphen width for G1 in rendered pixels.
 * Hyphen glyph = 4px → rendered = (4+1)*2 = 10px
 */
export const G1_HYPHEN_WIDTH_PX = 10

/**
 * Get the space width for G1 in rendered pixels.
 * Space glyph = 2px → rendered = (2+1)*2 = 6px
 */
export const G1_SPACE_WIDTH_PX = 6
