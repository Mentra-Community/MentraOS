/**
 * Random Text Generator for G1 Glasses Wrapping Stress Tests
 *
 * Generates random valid text combinations to test wrapping logic
 * with various edge cases and character combinations.
 */

import {
  LATIN_GLYPH_WIDTHS,
  DISPLAY_WIDTH_PX,
  MAX_LINES,
  calculateTextWidth,
  calculateByteSize,
  type ScriptType,
} from "./glyphWidths"

/**
 * Word lists for generating realistic text
 */
const COMMON_WORDS = {
  short: ["a", "I", "to", "of", "in", "it", "is", "be", "as", "at", "so", "we", "he", "by", "or", "on", "do", "if", "me", "my", "up", "an", "go", "no", "us", "am"],
  medium: ["the", "and", "for", "are", "but", "not", "you", "all", "can", "had", "her", "was", "one", "our", "out", "day", "get", "has", "him", "his", "how", "its", "may", "new", "now", "old", "see", "two", "way", "who", "boy", "did", "own", "say", "she", "too", "use"],
  long: ["about", "after", "again", "being", "below", "between", "could", "during", "every", "first", "found", "great", "house", "large", "little", "might", "never", "other", "over", "place", "right", "small", "sound", "still", "such", "take", "their", "these", "thing", "think", "three", "under", "water", "where", "which", "while", "world", "would", "write", "years"],
  veryLong: ["actually", "beautiful", "certainly", "different", "everything", "following", "government", "important", "information", "interesting", "international", "knowledge", "something", "sometimes", "themselves", "understand", "university", "wonderful"],
}

const NARROW_WORDS = ["illicit", "little", "till", "fill", "will", "ill", "lit", "fit", "it", "I"]
const WIDE_WORDS = ["mammogram", "swimming", "awesome", "welcome", "somewhere", "owym", "www"]

const PUNCTUATION = [".", ",", "!", "?", ";", ":", "'", '"', "-", "(", ")", "[", "]"]
const NUMBERS = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]

const CHINESE_CHARS = ["你", "好", "世", "界", "这", "是", "一", "个", "测", "试", "中", "文", "字", "符", "显", "示", "效", "果", "的", "我", "们", "他", "她", "它"]
const JAPANESE_HIRAGANA = ["あ", "い", "う", "え", "お", "か", "き", "く", "け", "こ", "さ", "し", "す", "せ", "そ", "た", "ち", "つ", "て", "と", "な", "に", "ぬ", "ね", "の"]
const KOREAN_HANGUL = ["가", "나", "다", "라", "마", "바", "사", "아", "자", "차", "카", "타", "파", "하", "한", "국", "어", "안", "녕", "하", "세", "요"]
const CYRILLIC_CHARS = ["а", "б", "в", "г", "д", "е", "ж", "з", "и", "к", "л", "м", "н", "о", "п", "р", "с", "т", "у", "ф", "х", "ц", "ч", "ш"]

/**
 * Generator options
 */
export interface GeneratorOptions {
  script?: ScriptType | "mixed_latin" | "all_supported"
  minWords?: number
  maxWords?: number
  includePunctuation?: boolean
  includeNumbers?: boolean
  targetLines?: number
  targetWidth?: number // Target pixel width per line
  edgeCases?: boolean // Include edge case scenarios
}

const DEFAULT_OPTIONS: Required<GeneratorOptions> = {
  script: "latin",
  minWords: 3,
  maxWords: 15,
  includePunctuation: true,
  includeNumbers: false,
  targetLines: 1,
  targetWidth: DISPLAY_WIDTH_PX,
  edgeCases: false,
}

/**
 * Random utility functions
 */
function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function randomChoice<T>(array: T[]): T {
  return array[Math.floor(Math.random() * array.length)]
}

function randomChoices<T>(array: T[], count: number): T[] {
  const result: T[] = []
  for (let i = 0; i < count; i++) {
    result.push(randomChoice(array))
  }
  return result
}

function shuffle<T>(array: T[]): T[] {
  const result = [...array]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

/**
 * Generate a random Latin word
 */
function generateLatinWord(preferWidth?: "narrow" | "average" | "wide"): string {
  if (preferWidth === "narrow") {
    return randomChoice(NARROW_WORDS)
  }
  if (preferWidth === "wide") {
    return randomChoice(WIDE_WORDS)
  }

  const category = randomChoice(["short", "medium", "long", "veryLong"] as const)
  return randomChoice(COMMON_WORDS[category])
}

/**
 * Generate random Latin sentence
 */
function generateLatinSentence(wordCount: number, includePunctuation: boolean, includeNumbers: boolean): string {
  const words: string[] = []

  for (let i = 0; i < wordCount; i++) {
    let word = generateLatinWord()

    // Capitalize first word
    if (i === 0) {
      word = word.charAt(0).toUpperCase() + word.slice(1)
    }

    // Occasionally add numbers
    if (includeNumbers && Math.random() < 0.1) {
      const num = randomChoices(NUMBERS, randomInt(1, 4)).join("")
      word = Math.random() < 0.5 ? word + num : num + word
    }

    words.push(word)

    // Add mid-sentence punctuation occasionally
    if (includePunctuation && i < wordCount - 1 && Math.random() < 0.15) {
      words[words.length - 1] += randomChoice([",", ";", " -"])
    }
  }

  // Add ending punctuation
  if (includePunctuation) {
    const lastWord = words[words.length - 1]
    words[words.length - 1] = lastWord + randomChoice([".", ".", ".", "!", "?"])
  }

  return words.join(" ")
}

/**
 * Generate random CJK text
 */
function generateCJKText(charCount: number, type: "chinese" | "japanese" | "korean"): string {
  const charSet = type === "chinese" ? CHINESE_CHARS : type === "japanese" ? JAPANESE_HIRAGANA : KOREAN_HANGUL

  return randomChoices(charSet, charCount).join("")
}

/**
 * Generate random Cyrillic text
 */
function generateCyrillicText(charCount: number): string {
  const words: string[] = []
  let remaining = charCount

  while (remaining > 0) {
    const wordLen = Math.min(randomInt(2, 8), remaining)
    const word = randomChoices(CYRILLIC_CHARS, wordLen).join("")
    words.push(word)
    remaining -= wordLen + 1 // +1 for space
  }

  return words.join(" ")
}

/**
 * Generate text to fill a specific pixel width
 */
export function generateToWidth(targetWidth: number, script: ScriptType = "latin"): string {
  let text = ""
  let currentWidth = 0

  if (script === "latin") {
    while (currentWidth < targetWidth - 50) {
      // Leave some buffer
      const word = generateLatinWord()
      const wordWidth = calculateTextWidth(word + " ")

      if (currentWidth + wordWidth > targetWidth) break

      text += (text ? " " : "") + word
      currentWidth = calculateTextWidth(text)
    }
  } else if (script === "chinese" || script === "japanese_hiragana" || script === "japanese_kanji") {
    const charSet = script === "chinese" || script === "japanese_kanji" ? CHINESE_CHARS : JAPANESE_HIRAGANA
    const pixelsPerChar = 18

    const charCount = Math.floor(targetWidth / pixelsPerChar)
    text = randomChoices(charSet, charCount).join("")
  } else if (script === "korean") {
    const pixelsPerChar = 24
    const charCount = Math.floor(targetWidth / pixelsPerChar)
    text = randomChoices(KOREAN_HANGUL, charCount).join("")
  } else if (script === "cyrillic") {
    const pixelsPerChar = 18
    const charCount = Math.floor(targetWidth / pixelsPerChar)
    text = generateCyrillicText(charCount)
  }

  return text
}

/**
 * Generate random text based on options
 */
export function generateRandomText(options: GeneratorOptions = {}): string {
  const opts = {...DEFAULT_OPTIONS, ...options}

  const wordCount = randomInt(opts.minWords, opts.maxWords)

  switch (opts.script) {
    case "latin":
      return generateLatinSentence(wordCount, opts.includePunctuation, opts.includeNumbers)

    case "chinese":
    case "japanese_kanji":
      return generateCJKText(wordCount * 2, "chinese")

    case "japanese_hiragana":
    case "japanese_katakana":
      return generateCJKText(wordCount * 2, "japanese")

    case "korean":
      return generateCJKText(wordCount * 2, "korean")

    case "cyrillic":
      return generateCyrillicText(wordCount * 4)

    case "mixed_latin":
      // Mix different width Latin words
      const narrowCount = Math.floor(wordCount / 3)
      const wideCount = Math.floor(wordCount / 3)
      const avgCount = wordCount - narrowCount - wideCount

      const words = [
        ...Array(narrowCount)
          .fill(0)
          .map(() => generateLatinWord("narrow")),
        ...Array(wideCount)
          .fill(0)
          .map(() => generateLatinWord("wide")),
        ...Array(avgCount)
          .fill(0)
          .map(() => generateLatinWord("average")),
      ]

      return shuffle(words).join(" ")

    case "all_supported":
      // Mix all supported scripts (but not in same line - that's unsupported)
      const scriptChoice = randomChoice(["latin", "chinese", "korean", "cyrillic"] as const)
      return generateRandomText({...opts, script: scriptChoice})

    default:
      return generateLatinSentence(wordCount, opts.includePunctuation, opts.includeNumbers)
  }
}

/**
 * Generate multiple lines of text
 */
export function generateMultiLineText(lineCount: number, options: GeneratorOptions = {}): string[] {
  const lines: string[] = []

  for (let i = 0; i < lineCount; i++) {
    lines.push(generateRandomText(options))
  }

  return lines
}

/**
 * Edge case generators
 */
export const EdgeCases = {
  /**
   * All narrow characters (maximum chars per line)
   */
  allNarrow: (count: number = 144) => "l".repeat(count),

  /**
   * All wide characters (minimum chars per line)
   */
  allWide: (count: number = 36) => "m".repeat(count),

  /**
   * Exactly at pixel boundary
   */
  exactWidth: () => generateToWidth(DISPLAY_WIDTH_PX, "latin"),

  /**
   * One pixel over boundary
   */
  onePixelOver: () => {
    const text = generateToWidth(DISPLAY_WIDTH_PX - 4, "latin")
    return text + "ll" // Add 8px to go over
  },

  /**
   * Long word that needs breaking
   */
  longUnbreakableWord: () => "supercalifragilisticexpialidocious",

  /**
   * Many short words
   */
  manyShortWords: () => "a I a I a I a I a I a I a I a I a I a I a I a I",

  /**
   * Alternating narrow and wide
   */
  alternatingWidths: (count: number = 20) => {
    let result = ""
    for (let i = 0; i < count; i++) {
      result += i % 2 === 0 ? "i" : "m"
    }
    return result
  },

  /**
   * Numbers only
   */
  numbersOnly: (count: number = 49) => {
    let result = ""
    for (let i = 0; i < count; i++) {
      result += String(i % 10)
    }
    return result
  },

  /**
   * Heavy punctuation
   */
  heavyPunctuation: () => 'Hello! How are you? I\'m fine... Really!!! Yes??? "Sure," she said.',

  /**
   * CJK at max safe length
   */
  cjkMaxSafe: () => generateCJKText(26, "chinese"),

  /**
   * Korean at max safe length
   */
  koreanMaxSafe: () => generateCJKText(22, "korean"),

  /**
   * Near byte limit (5 lines CJK)
   */
  nearByteLimit: () => {
    const lines: string[] = []
    for (let i = 0; i < 5; i++) {
      lines.push(generateCJKText(26, "chinese"))
    }
    return lines.join("\n")
  },

  /**
   * Empty and whitespace
   */
  emptyString: () => "",
  singleSpace: () => " ",
  multipleSpaces: () => "word     word     word",

  /**
   * Newlines
   */
  singleNewline: () => "Line 1\nLine 2",
  multipleNewlines: () => "Line 1\n\n\nLine 4",
  trailingNewline: () => "Text with trailing newline\n",
}

/**
 * Generate a random edge case
 */
export function generateRandomEdgeCase(): {name: string; text: string} {
  const cases = [
    {name: "All Narrow (144 chars)", fn: () => EdgeCases.allNarrow()},
    {name: "All Wide (36 chars)", fn: () => EdgeCases.allWide()},
    {name: "Exact Width", fn: () => EdgeCases.exactWidth()},
    {name: "One Pixel Over", fn: () => EdgeCases.onePixelOver()},
    {name: "Long Unbreakable Word", fn: () => EdgeCases.longUnbreakableWord()},
    {name: "Many Short Words", fn: () => EdgeCases.manyShortWords()},
    {name: "Alternating Widths", fn: () => EdgeCases.alternatingWidths()},
    {name: "Numbers Only", fn: () => EdgeCases.numbersOnly()},
    {name: "Heavy Punctuation", fn: () => EdgeCases.heavyPunctuation()},
    {name: "CJK Max Safe", fn: () => EdgeCases.cjkMaxSafe()},
    {name: "Korean Max Safe", fn: () => EdgeCases.koreanMaxSafe()},
    {name: "Multiple Spaces", fn: () => EdgeCases.multipleSpaces()},
  ]

  const choice = randomChoice(cases)
  return {name: choice.name, text: choice.fn()}
}

/**
 * Diarization-style text generation
 */
export interface DiarizedUtterance {
  speaker: number
  text: string
  isFinal: boolean
}

/**
 * Generate a conversation with multiple speakers
 */
export function generateConversation(utteranceCount: number, speakerCount: number = 2): DiarizedUtterance[] {
  const utterances: DiarizedUtterance[] = []

  for (let i = 0; i < utteranceCount; i++) {
    const speaker = randomInt(1, speakerCount)
    const wordCount = randomInt(3, 12)
    const text = generateLatinSentence(wordCount, true, false)

    utterances.push({
      speaker,
      text,
      isFinal: true,
    })
  }

  return utterances
}

/**
 * Generate transcript display text with speaker labels
 */
export function generateTranscriptText(utterances: DiarizedUtterance[]): string {
  return utterances.map((u) => `[${u.speaker}]: ${u.text}`).join("\n")
}
