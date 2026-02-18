import {Jieba} from "@node-rs/jieba"
import {dict} from "@node-rs/jieba/dict"
import {pinyin} from "pinyin-pro"

// Initialize jieba with the default dictionary
const jieba = Jieba.withDict(dict)

/**
 * Checks if text contains Chinese characters
 */
export function isChinese(text: string): boolean {
  return /[\u4e00-\u9fa5]/.test(text)
}

/**
 * Finds the last valid word boundary before or at the given position in Chinese text
 * Returns the position where the text should be split
 */
export function findChineseWordBoundary(text: string, position: number): number {
  if (!isChinese(text)) return position

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

  // If we didn't find a boundary, return the original position
  return position
}

/**
 * Converts Chinese text to Pinyin format
 * Preserves word boundaries and keeps multi-character words together
 */
export function convertToPinyin(text: string): string {
  if (!isChinese(text)) return text

  // Split text into Chinese and non-Chinese parts
  const parts = text.split(/([\u4e00-\u9fa5]+)/g)

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
}
