import type {ScriptType} from "../profiles/types"

/**
 * Unicode ranges for script detection.
 * Used to classify characters for proper width measurement.
 */
export const SCRIPT_RANGES = {
  // CJK Unified Ideographs
  cjk: [
    [0x4e00, 0x9fff], // Main block (common Chinese, Japanese Kanji)
    [0x3400, 0x4dbf], // Extension A
    [0x20000, 0x2a6df], // Extension B
    [0x2a700, 0x2b73f], // Extension C
    [0x2b740, 0x2b81f], // Extension D
    [0xf900, 0xfaff], // Compatibility Ideographs
  ] as const,

  // Japanese Hiragana
  hiragana: [[0x3040, 0x309f]] as const,

  // Japanese Katakana
  katakana: [
    [0x30a0, 0x30ff], // Main block
    [0x31f0, 0x31ff], // Phonetic Extensions
  ] as const,

  // Korean
  korean: [
    [0xac00, 0xd7af], // Hangul Syllables
    [0x1100, 0x11ff], // Hangul Jamo
    [0x3130, 0x318f], // Compatibility Jamo
    [0xa960, 0xa97f], // Jamo Extended-A
    [0xd7b0, 0xd7ff], // Jamo Extended-B
  ] as const,

  // Cyrillic
  cyrillic: [
    [0x0400, 0x04ff], // Main block
    [0x0500, 0x052f], // Supplement
  ] as const,

  // Numbers (ASCII)
  numbers: [[0x30, 0x39]] as const,

  // Basic punctuation (ASCII)
  punctuation: [
    [0x20, 0x2f], // Space and basic punctuation
    [0x3a, 0x40], // More punctuation
    [0x5b, 0x60], // Brackets etc.
    [0x7b, 0x7e], // Braces etc.
  ] as const,

  // Unsupported scripts (for filtering)
  arabic: [[0x0600, 0x06ff]] as const,
  hebrew: [[0x0590, 0x05ff]] as const,
  thai: [[0x0e00, 0x0e7f]] as const,
  emoji: [
    [0x1f600, 0x1f64f], // Emoticons
    [0x1f300, 0x1f5ff], // Misc Symbols and Pictographs
    [0x1f680, 0x1f6ff], // Transport and Map
    [0x1f1e0, 0x1f1ff], // Flags
    [0x2600, 0x26ff], // Misc Symbols
    [0x2700, 0x27bf], // Dingbats
    [0xfe00, 0xfe0f], // Variation Selectors
    [0x1f900, 0x1f9ff], // Supplemental Symbols
  ] as const,
} as const

/**
 * Check if a code point is within any of the given ranges.
 */
function inRanges(codePoint: number, ranges: readonly (readonly [number, number])[]): boolean {
  for (const [start, end] of ranges) {
    if (codePoint >= start && codePoint <= end) {
      return true
    }
  }
  return false
}

/**
 * Detect the script type of a single character.
 *
 * @param char - Single character to classify
 * @returns The script type of the character
 */
export function detectScript(char: string): ScriptType {
  if (!char || char.length === 0) {
    return "latin"
  }

  // Get the code point (handles surrogate pairs for characters outside BMP)
  const codePoint = char.codePointAt(0)
  if (codePoint === undefined) {
    return "latin"
  }

  // Check each script in order of likelihood/importance

  // CJK (most common for multi-byte)
  if (inRanges(codePoint, SCRIPT_RANGES.cjk)) {
    return "cjk"
  }

  // Japanese kana
  if (inRanges(codePoint, SCRIPT_RANGES.hiragana)) {
    return "hiragana"
  }
  if (inRanges(codePoint, SCRIPT_RANGES.katakana)) {
    return "katakana"
  }

  // Korean
  if (inRanges(codePoint, SCRIPT_RANGES.korean)) {
    return "korean"
  }

  // Cyrillic
  if (inRanges(codePoint, SCRIPT_RANGES.cyrillic)) {
    return "cyrillic"
  }

  // Numbers
  if (inRanges(codePoint, SCRIPT_RANGES.numbers)) {
    return "numbers"
  }

  // Punctuation
  if (inRanges(codePoint, SCRIPT_RANGES.punctuation)) {
    return "punctuation"
  }

  // Unsupported scripts
  if (
    inRanges(codePoint, SCRIPT_RANGES.arabic) ||
    inRanges(codePoint, SCRIPT_RANGES.hebrew) ||
    inRanges(codePoint, SCRIPT_RANGES.thai) ||
    inRanges(codePoint, SCRIPT_RANGES.emoji)
  ) {
    return "unsupported"
  }

  // Default to Latin for ASCII letters and anything else
  return "latin"
}

/**
 * Check if a character is a CJK character (Chinese, Japanese Kanji).
 * CJK characters can break anywhere without needing a hyphen.
 */
export function isCJKCharacter(char: string): boolean {
  const script = detectScript(char)
  return script === "cjk" || script === "hiragana" || script === "katakana"
}

/**
 * Check if a character is Korean Hangul.
 */
export function isKoreanCharacter(char: string): boolean {
  return detectScript(char) === "korean"
}

/**
 * Check if a character is from a uniform-width script.
 * These scripts render all characters at the same width.
 */
export function isUniformWidthScript(char: string): boolean {
  const script = detectScript(char)
  return (
    script === "cjk" || script === "hiragana" || script === "katakana" || script === "korean" || script === "cyrillic"
  )
}

/**
 * Check if a character is from an unsupported script.
 * These characters may not render correctly on the glasses.
 */
export function isUnsupportedScript(char: string): boolean {
  return detectScript(char) === "unsupported"
}

/**
 * Check if breaking between two characters requires a hyphen.
 * Returns false for:
 * - Breaking after CJK characters (can break anywhere)
 * - Breaking before or after spaces
 * - Breaking after punctuation
 */
export function needsHyphenForBreak(charBefore: string, charAfter: string): boolean {
  // No hyphen needed after CJK (can break anywhere)
  if (isCJKCharacter(charBefore)) {
    return false
  }

  // No hyphen needed before CJK
  if (isCJKCharacter(charAfter)) {
    return false
  }

  // No hyphen needed after space
  if (charBefore === " " || charBefore === "\t") {
    return false
  }

  // No hyphen needed before space (the space is a natural break point)
  if (charAfter === " " || charAfter === "\t") {
    return false
  }

  // No hyphen needed after existing punctuation that serves as break
  const breakPunctuation = ["-", "–", "—", "/", "\\", "|"]
  if (breakPunctuation.includes(charBefore)) {
    return false
  }

  // Default: hyphen is needed for mid-word Latin breaks
  return true
}
