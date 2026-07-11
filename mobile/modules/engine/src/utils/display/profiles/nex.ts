import { DisplayProfile } from "./types";

/**
 * Mentra Nex glyph widths
 */
const NEX_GLYPH_WIDTHS: Record<string, number> = {
  // Punctuation & Symbols
  " ": 5,
  "!": 5,
  '"': 8,
  "#": 14,
  "$": 12,
  "%": 18,
  "&": 14,
  "'": 5,
  "(": 7,
  ")": 7,
  "*": 8,
  "+": 12,
  ",": 5,
  "-": 8,
  ".": 5,
  "/": 7,

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
  "@": 18,

  // Uppercase
  "A": 12,
  "B": 13,
  "C": 12,
  "D": 13,
  "E": 11,
  "F": 11,
  "G": 14,
  "H": 14,
  "I": 8,
  "J": 10,
  "K": 12,
  "L": 10,
  "M": 16,
  "N": 14,
  "O": 14,
  "P": 12,
  "Q": 14,
  "R": 13,
  "S": 11,
  "T": 11,
  "U": 13,
  "V": 12,
  "W": 18,
  "X": 12,
  "Y": 11,
  "Z": 11,

  // Brackets & special
  "[": 6,
  "\\": 7,
  "]": 6,
  "^": 12,
  "_": 11,
  "`": 12,

  // Lowercase
  "a": 11,
  "b": 11,
  "c": 10,
  "d": 11,
  "e": 11,
  "f": 6,
  "g": 11,
  "h": 11,
  "i": 5,
  "j": 5,
  "k": 10,
  "l": 5,
  "m": 17,
  "n": 11,
  "o": 11,
  "p": 11,
  "q": 11,
  "r": 7,
  "s": 10,
  "t": 7,
  "u": 11,
  "v": 10,
  "w": 15,
  "x": 10,
  "y": 10,
  "z": 9,

  // More special
  "{": 7,
  "|": 6,
  "}": 7,
  "~": 12,
};

/**
 * Mentra Nex Smart Glasses Display Profile
 *
 * Also known as "Mentra Display" - a new Mentra glasses model with display capabilities.
 */
export const NEX_PROFILE: DisplayProfile = {
  id: "mentra-nex",
  name: "Mentra Nex",

  // Display dimensions — 500x220 usable region centered in the 640x480 A6N
  // panel (firmware mos_display_config.c: margins 70/130). Canvas coordinates
  // are relative to this virtual screen; the physical panel is bigger, 500x220
  // is the public drawable canvas.
  displayWidthPx: 480,
  displayHeightPx: 220,
  maxLines: 8,

  maxPayloadBytes: 450, // Matches firmware MAX_TEXT_LEN / DisplayText.text cap; delivered via fragmented BLE transport
  bleChunkSize: 176,

  // Font metrics
  fontMetrics: {
    glyphWidths: new Map(Object.entries(NEX_GLYPH_WIDTHS)),
    defaultGlyphWidth: 16,
    renderFormula: (glyphWidth: number) => glyphWidth,

    uniformScripts: {
      cjk: 20,
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
};

export const NEX_HYPHEN_WIDTH_PX = 8;

export const NEX_SPACE_WIDTH_PX = 4;
