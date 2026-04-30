import { DisplayProfile } from "./types";

/**
 * Mentra Nex glyph widths
 */
const NEX_GLYPH_WIDTHS: Record<string, number> = {
  // Punctuation & Symbols
  " ": 4,
  "!": 3,
  '"': 5,
  "#": 12,
  "$": 10,
  "%": 13,
  "&": 12,
  "'": 3,
  "(": 7,
  ")": 7,
  "*": 8,
  "+": 11,
  ",": 5,
  "-": 8,
  ".": 5,
  "/": 8,

  // Numbers
  "0": 12,
  "1": 5,
  "2": 11,
  "3": 11,
  "4": 11,
  "5": 11,
  "6": 11,
  "7": 11,
  "8": 11,
  "9": 11,

  // More punctuation
  ":": 5,
  ";": 5,
  "<": 11,
  "=": 11,
  ">": 11,
  "?": 9,
  "@": 14,

  // Uppercase
  "A": 12,
  "B": 12,
  "C": 13,
  "D": 13,
  "E": 11,
  "F": 11,
  "G": 14,
  "H": 13,
  "I": 4,
  "J": 10,
  "K": 10,
  "L": 11,
  "M": 15,
  "N": 13,
  "O": 15,
  "P": 11,
  "Q": 15,
  "R": 11,
  "S": 11,
  "T": 11,
  "U": 13,
  "V": 12,
  "W": 16,
  "X": 11,
  "Y": 11,
  "Z": 11,

  // Brackets & special
  "[": 6,
  "\\": 8,
  "]": 6,
  "^": 11,
  "_": 9,
  "`": 11,

  // Lowercase
  "a": 9,
  "b": 10,
  "c": 9,
  "d": 10,
  "e": 10,
  "f": 6,
  "g": 10,
  "h": 10,
  "i": 3,
  "j": 3,
  "k": 8,
  "l": 3,
  "m": 15,
  "n": 10,
  "o": 10,
  "p": 10,
  "q": 10,
  "r": 6,
  "s": 8,
  "t": 6,
  "u": 10,
  "v": 9,
  "w": 12,
  "x": 8,
  "y": 9,
  "z": 8,

  // More special
  "{": 7,
  "|": 5,
  "}": 7,
  "~": 11,
};

/**
 * Mentra Nex Smart Glasses Display Profile
 *
 * Also known as "Mentra Display" - a new Mentra glasses model with display capabilities.
 */
export const NEX_PROFILE: DisplayProfile = {
  id: "mentra-nex",
  name: "Mentra Nex",

  // Display dimensions
  displayWidthPx: 440,
  maxLines: 5,

  maxPayloadBytes: 226,
  bleChunkSize: 176,

  // Font metrics
  fontMetrics: {
    glyphWidths: new Map(Object.entries(NEX_GLYPH_WIDTHS)),
    defaultGlyphWidth: 16,
    renderFormula: (glyphWidth: number) => glyphWidth,

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
};

export const NEX_HYPHEN_WIDTH_PX = 8;

export const NEX_SPACE_WIDTH_PX = 4;
