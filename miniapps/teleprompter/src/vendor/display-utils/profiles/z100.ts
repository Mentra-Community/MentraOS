import { DisplayProfile } from "./types";

/**
 * Vuzix Z100 glyph widths - extracted from NotoSans-Regular.ttf at 21px
 *
 * These are pixel widths at the default font size used by the Z100 display.
 * The Z100 uses Noto Sans as its system font.
 *
 * Extracted using: node scripts/extract-font-metrics.js NotoSans-Regular.ttf 21
 */
const Z100_GLYPH_WIDTHS: Record<string, number> = {
  // Space and punctuation
  " ": 5,
  "!": 6,
  '"': 9,
  "#": 14,
  $: 12,
  "%": 17,
  "&": 15,
  "'": 5,
  "(": 6,
  ")": 6,
  "*": 12,
  "+": 12,
  ",": 6,
  "-": 7, // Hyphen width - important for line breaking
  ".": 6,
  "/": 8,

  // Numbers
  "0": 12,
  "1": 12,
  "2": 12,
  "3": 12,
  "4": 12,
  "5": 12,
  "6": 12,
  "7": 12,
  "8": 12,
  "9": 12,

  // More punctuation
  ":": 6,
  ";": 6,
  "<": 12,
  "=": 12,
  ">": 12,
  "?": 9,
  "@": 19,

  // Uppercase
  A: 13,
  B: 14,
  C: 13,
  D: 15,
  E: 12,
  F: 11,
  G: 15,
  H: 16,
  I: 7,
  J: 6,
  K: 13,
  L: 11,
  M: 19,
  N: 16,
  O: 16,
  P: 13,
  Q: 16,
  R: 13,
  S: 12,
  T: 12,
  U: 15,
  V: 13,
  W: 20,
  X: 12,
  Y: 12,
  Z: 12,

  // Brackets & special
  "[": 7,
  "\\": 8,
  "]": 7,
  "^": 12,
  _: 9,
  "`": 6,

  // Lowercase
  a: 12,
  b: 13,
  c: 10,
  d: 13,
  e: 12,
  f: 7,
  g: 13,
  h: 13,
  i: 5,
  j: 5,
  k: 11,
  l: 5,
  m: 20,
  n: 13,
  o: 13,
  p: 13,
  q: 13,
  r: 9,
  s: 10,
  t: 8,
  u: 13,
  v: 11,
  w: 17,
  x: 11,
  y: 11,
  z: 10,

  // More special
  "{": 8,
  "|": 12,
  "}": 8,
  "~": 12,
};

/**
 * Vuzix Z100 Smart Glasses Display Profile
 *
 * The Z100 has a green monochrome display with 640x480 resolution.
 * It uses the Vuzix Ultralite SDK and Noto Sans font family.
 *
 * Display specs:
 * - Resolution: 640x480
 * - Usable text width: ~390px (empirically tested - SDK applies margins)
 * - Color: Green monochrome
 * - Max text lines: 7
 * - Font: Noto Sans Regular at 21px
 * - No bitmap support via text commands
 * - Adjustable brightness
 *
 * NOTE: The Vuzix Ultralite SDK handles text rendering internally and applies
 * its own margins/padding. The usable text width is significantly less than
 * the physical 640px resolution. Empirical testing shows ~42 characters of
 * mixed text (387px measured) fits on one line before the SDK wraps.
 */
export const Z100_PROFILE: DisplayProfile = {
  id: "vuzix-z100",
  name: "Vuzix Z100",

  // Display dimensions
  // Empirically tested: ~42 chars of mixed text (387px) fits before SDK wraps
  // Using 390px to account for measurement variance
  displayWidthPx: 390,
  maxLines: 7,

  // BLE constraints
  // Z100 uses Vuzix Ultralite SDK which handles chunking internally
  // These are conservative values for direct BLE if needed
  maxPayloadBytes: 512,
  bleChunkSize: 180,

  // Font metrics - Noto Sans Regular at 21px
  fontMetrics: {
    glyphWidths: new Map(Object.entries(Z100_GLYPH_WIDTHS)),
    defaultGlyphWidth: 12, // Average width from extracted metrics
    // Z100 uses direct pixel widths, no render formula needed
    renderFormula: (glyphWidth: number) => glyphWidth,

    // Uniform-width scripts for CJK and other non-Latin
    // Noto Sans CJK characters are typically wider
    uniformScripts: {
      cjk: 21, // Full-width CJK characters
      hiragana: 21,
      katakana: 21,
      korean: 21,
      cyrillic: 14, // Cyrillic is similar to Latin in Noto Sans
    },

    fallback: {
      latinMaxWidth: 20, // 'W' and 'm' are the widest at 20px
      unknownBehavior: "useLatinMax",
    },
  },

  constraints: {
    minCharsBeforeHyphen: 3,
    noStartChars: [
      ".",
      ",",
      "!",
      "?",
      ":",
      ";",
      ")",
      "]",
      "}",
      "。",
      "，",
      "！",
      "？",
      "：",
      "；",
      "）",
      "】",
      "」",
    ],
    noEndChars: ["(", "[", "{", "（", "【", "「"],
  },
};

/**
 * Get the hyphen width for Z100 in pixels.
 * Used for line breaking calculations.
 */
export const Z100_HYPHEN_WIDTH_PX = 7;

/**
 * Get the space width for Z100 in pixels.
 * Used for column alignment calculations.
 */
export const Z100_SPACE_WIDTH_PX = 5;
