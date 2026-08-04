/**
 * ChineseUtils — Chinese segmentation + pinyin conversion.
 *
 * IMPORTANT (local-miniapp port): the cloud app imports `@node-rs/jieba`, which
 * is a NATIVE Node addon. It will NOT load inside the on-device JSContext (JSC /
 * QuickJS) that runs this background bundle — there is no N-API there. To keep
 * the bundle loadable we DO NOT statically import jieba/pinyin-pro. Instead we
 * lazily attempt to load them once; if loading (or use) fails for any reason we
 * degrade gracefully to passthrough — the original text is returned unchanged.
 *
 * On a normal device this means convertToPinyin falls back to returning the
 * Hanzi as-is (no pinyin) when jieba/pinyin-pro aren't available, rather than
 * crashing the whole miniapp. The logic mirrors the cloud app verbatim; only
 * the import seam is wrapped.
 */

// Lazily-resolved optional deps. `null` = not yet attempted, `false` = failed.
type JiebaLike = {cut(text: string): string[]}
type PinyinFn = (
  word: string,
  opts: {
    toneType: string
    type: string
    nonZh: string
    mode: string
  },
) => string[]

let jiebaInstance: JiebaLike | null | false = null
let pinyinFn: PinyinFn | null | false = null

// Indirect require so bundlers don't try to statically resolve the native addon
// into the IIFE. If `require` itself is undefined in this runtime, we degrade.
function optionalRequire(id: string): unknown {
  try {
    const req = (globalThis as {require?: (id: string) => unknown}).require
    if (typeof req !== "function") return undefined
    return req(id)
  } catch {
    return undefined
  }
}

/**
 * Attempt to load @node-rs/jieba once. Returns the instance or null. Any
 * failure (missing module, native addon, runtime error) degrades to null and
 * the caller falls back to passthrough.
 */
function getJieba(): JiebaLike | null {
  if (jiebaInstance !== null) return jiebaInstance || null
  try {
    const mod = optionalRequire("@node-rs/jieba") as
      | {Jieba: {withDict(d: unknown): JiebaLike}}
      | undefined
    const dictMod = optionalRequire("@node-rs/jieba/dict") as {dict: unknown} | undefined
    if (!mod || !dictMod) {
      jiebaInstance = false
      return null
    }
    jiebaInstance = mod.Jieba.withDict(dictMod.dict)
    return jiebaInstance
  } catch {
    jiebaInstance = false
    return null
  }
}

/**
 * Attempt to load pinyin-pro once. Returns the pinyin fn or null.
 */
function getPinyin(): PinyinFn | null {
  if (pinyinFn !== null) return pinyinFn || null
  try {
    const mod = optionalRequire("pinyin-pro") as {pinyin: PinyinFn} | undefined
    if (!mod) {
      pinyinFn = false
      return null
    }
    pinyinFn = mod.pinyin
    return pinyinFn
  } catch {
    pinyinFn = false
    return null
  }
}

/**
 * Checks if text contains Chinese characters
 */
export function isChinese(text: string): boolean {
  return /[一-龥]/.test(text)
}

/**
 * Finds the last valid word boundary before or at the given position in Chinese text
 * Returns the position where the text should be split
 */
export function findChineseWordBoundary(text: string, position: number): number {
  if (!isChinese(text)) return position

  const jieba = getJieba()
  if (!jieba) return position

  try {
    // Get all words up to the position
    const words = jieba.cut(text)
    let currentLength = 0

    for (const word of words) {
      if (currentLength + word.length > position) {
        // If this word would exceed the position, return the previous position
        return currentLength
      }
      currentLength += word.length
    }
  } catch {
    return position
  }

  // If we didn't find a boundary, return the original position
  return position
}

/**
 * Converts Chinese text to Pinyin format
 * Preserves word boundaries and keeps multi-character words together.
 *
 * Degrades to passthrough (returns the original text) if jieba/pinyin-pro can't
 * load in this runtime.
 */
export function convertToPinyin(text: string): string {
  if (!isChinese(text)) return text

  const jieba = getJieba()
  const pinyin = getPinyin()
  if (!jieba || !pinyin) return text

  try {
    // Split text into Chinese and non-Chinese parts
    const parts = text.split(/([一-龥]+)/g)

    // Process each part
    const processedParts = parts.map((part) => {
      if (!isChinese(part)) return part

      // Use jieba instance to segment Chinese parts into words
      const words = jieba.cut(part)

      // Convert each word to Pinyin, keeping multi-character words together
      const pinyinWords = words.map((word) => {
        if (!isChinese(word)) return word
        // Convert the entire word to Pinyin without internal spaces
        return pinyin(word, {
          toneType: "symbol",
          type: "array",
          nonZh: "removed",
          mode: "normal", // Use normal mode to get word-level Pinyin
        }).join("")
      })

      // Join words with spaces
      return pinyinWords.join(" ")
    })

    return processedParts.join("")
  } catch {
    // Any runtime failure: degrade to passthrough.
    return text
  }
}
