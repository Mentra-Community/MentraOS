/**
 * Text Wrapping Utility for G1 Glasses
 *
 * Handles intelligent text wrapping based on pixel widths,
 * respecting hardware limits and byte constraints.
 */

import {
  DISPLAY_WIDTH_PX,
  MAX_SAFE_BYTES,
  MAX_LINES,
  calculateTextWidth,
  calculateByteSize,
  getCharPixelWidth,
  detectScript,
  isCharSupported,
  getSafeCharsPerLine,
  type ScriptType,
} from "./glyphWidths"

/**
 * A wrapped line with metadata
 */
export interface WrappedLine {
  text: string
  pixelWidth: number
  byteSize: number
  charCount: number
}

/**
 * Result of wrapping text
 */
export interface WrapResult {
  lines: WrappedLine[]
  totalPixelWidth: number
  totalByteSize: number
  totalCharCount: number
  truncated: boolean
  truncatedText?: string
  dominantScript: ScriptType
}

/**
 * Options for text wrapping
 */
export interface WrapOptions {
  maxWidth?: number // Max pixel width per line (default: DISPLAY_WIDTH_PX)
  maxLines?: number // Max number of lines (default: MAX_LINES)
  maxBytes?: number // Max total bytes (default: MAX_SAFE_BYTES)
  wordWrap?: boolean // Try to wrap at word boundaries (default: true)
  preserveNewlines?: boolean // Respect \n in input (default: true)
}

const DEFAULT_OPTIONS: Required<WrapOptions> = {
  maxWidth: DISPLAY_WIDTH_PX,
  maxLines: MAX_LINES,
  maxBytes: MAX_SAFE_BYTES,
  wordWrap: true,
  preserveNewlines: true,
}

/**
 * Find the best break point in text that fits within maxWidth pixels
 * Returns the index to break at (exclusive)
 */
function findBreakPoint(text: string, startIndex: number, maxWidth: number, wordWrap: boolean): number {
  let currentWidth = 0
  let lastSpaceIndex = -1
  let lastBreakableIndex = startIndex

  for (let i = startIndex; i < text.length; i++) {
    const char = text[i]
    const charWidth = getCharPixelWidth(char)

    // Check if adding this char would exceed width
    if (currentWidth + charWidth > maxWidth) {
      // If we found a space, break there (word wrap)
      if (wordWrap && lastSpaceIndex > startIndex) {
        return lastSpaceIndex + 1 // Include the space in the previous line
      }
      // Otherwise break at current position
      return i > startIndex ? i : startIndex + 1
    }

    currentWidth += charWidth

    // Track spaces for word wrapping
    if (char === " ") {
      lastSpaceIndex = i
    }

    lastBreakableIndex = i + 1
  }

  // Entire remaining text fits
  return text.length
}

/**
 * Detect the dominant script in text
 */
function detectDominantScript(text: string): ScriptType {
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
    if (char === " " || char === "\n") continue
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

  return dominantScript
}

/**
 * Create a WrappedLine object
 */
function createWrappedLine(text: string): WrappedLine {
  return {
    text,
    pixelWidth: calculateTextWidth(text),
    byteSize: calculateByteSize(text),
    charCount: text.length,
  }
}

/**
 * Wrap text to fit G1 glasses display constraints
 */
export function wrapText(text: string, options: WrapOptions = {}): WrapResult {
  const opts = {...DEFAULT_OPTIONS, ...options}
  const lines: WrappedLine[] = []
  let totalByteSize = 0
  let truncated = false
  let truncatedText: string | undefined

  // Handle empty text
  if (!text || text.length === 0) {
    return {
      lines: [],
      totalPixelWidth: 0,
      totalByteSize: 0,
      totalCharCount: 0,
      truncated: false,
      dominantScript: "latin",
    }
  }

  const dominantScript = detectDominantScript(text)

  // Split by newlines first if preserving them
  const segments = opts.preserveNewlines ? text.split("\n") : [text]

  for (const segment of segments) {
    // Check if we've hit max lines
    if (lines.length >= opts.maxLines) {
      truncated = true
      truncatedText = segment
      break
    }

    // Handle empty segments (blank lines)
    if (segment.length === 0) {
      const emptyLine = createWrappedLine("")
      const newByteSize = totalByteSize + emptyLine.byteSize + 1 // +1 for newline

      if (newByteSize > opts.maxBytes) {
        truncated = true
        break
      }

      lines.push(emptyLine)
      totalByteSize = newByteSize
      continue
    }

    // Wrap this segment
    let startIndex = 0

    while (startIndex < segment.length) {
      // Check if we've hit max lines
      if (lines.length >= opts.maxLines) {
        truncated = true
        truncatedText = segment.substring(startIndex)
        break
      }

      // Find where to break
      const breakIndex = findBreakPoint(segment, startIndex, opts.maxWidth, opts.wordWrap)

      // Extract the line
      let lineText = segment.substring(startIndex, breakIndex)

      // Trim trailing spaces (but not leading, to preserve indentation)
      lineText = lineText.replace(/\s+$/, "")

      const wrappedLine = createWrappedLine(lineText)

      // Check byte limit
      const newByteSize = totalByteSize + wrappedLine.byteSize + (lines.length > 0 ? 1 : 0)
      if (newByteSize > opts.maxBytes) {
        truncated = true
        truncatedText = segment.substring(startIndex)
        break
      }

      lines.push(wrappedLine)
      totalByteSize = newByteSize

      // Skip past any spaces at the break point for next iteration
      startIndex = breakIndex
      while (startIndex < segment.length && segment[startIndex] === " ") {
        startIndex++
      }
    }

    if (truncated) break
  }

  // Calculate totals
  const totalPixelWidth = Math.max(...lines.map((l) => l.pixelWidth), 0)
  const totalCharCount = lines.reduce((sum, l) => sum + l.charCount, 0)

  return {
    lines,
    totalPixelWidth,
    totalByteSize,
    totalCharCount,
    truncated,
    truncatedText,
    dominantScript,
  }
}

/**
 * Simple single-line truncation with ellipsis
 */
export function truncateLine(text: string, maxWidth: number = DISPLAY_WIDTH_PX, ellipsis: string = "..."): string {
  const ellipsisWidth = calculateTextWidth(ellipsis)
  const availableWidth = maxWidth - ellipsisWidth

  if (calculateTextWidth(text) <= maxWidth) {
    return text
  }

  let truncatedText = ""
  let currentWidth = 0

  for (const char of text) {
    const charWidth = getCharPixelWidth(char)
    if (currentWidth + charWidth > availableWidth) {
      break
    }
    truncatedText += char
    currentWidth += charWidth
  }

  return truncatedText + ellipsis
}

/**
 * Check if text will fit on a single line
 */
export function fitsOneLine(text: string, maxWidth: number = DISPLAY_WIDTH_PX): boolean {
  return calculateTextWidth(text) <= maxWidth
}

/**
 * Get estimated line count for text
 */
export function estimateLineCount(text: string, maxWidth: number = DISPLAY_WIDTH_PX): number {
  const result = wrapText(text, {maxWidth, maxLines: 100, maxBytes: 10000})
  return result.lines.length
}

/**
 * Format text with speaker label for diarization
 * e.g., "[1]: Hello world"
 */
export function formatSpeakerLine(speakerNumber: number, text: string): string {
  return `[${speakerNumber}]: ${text}`
}

/**
 * Wrap text with speaker labels, ensuring labels stay with their text
 */
export function wrapWithSpeakerLabel(
  speakerNumber: number,
  text: string,
  options: WrapOptions = {},
): WrapResult {
  const label = `[${speakerNumber}]: `
  const labelWidth = calculateTextWidth(label)
  const opts = {...DEFAULT_OPTIONS, ...options}

  // First line has reduced width due to label
  const firstLineMaxWidth = opts.maxWidth - labelWidth

  // Check if text fits on first line with label
  const textWidth = calculateTextWidth(text)

  if (textWidth <= firstLineMaxWidth) {
    // Everything fits on one line
    const fullLine = label + text
    return {
      lines: [createWrappedLine(fullLine)],
      totalPixelWidth: calculateTextWidth(fullLine),
      totalByteSize: calculateByteSize(fullLine),
      totalCharCount: fullLine.length,
      truncated: false,
      dominantScript: detectDominantScript(text),
    }
  }

  // Need to wrap - first line gets label, subsequent lines are indented or not
  const lines: WrappedLine[] = []
  let totalByteSize = 0

  // Find break point for first line
  const firstBreak = findBreakPoint(text, 0, firstLineMaxWidth, opts.wordWrap)
  const firstLineText = label + text.substring(0, firstBreak).replace(/\s+$/, "")
  const firstLine = createWrappedLine(firstLineText)

  lines.push(firstLine)
  totalByteSize += firstLine.byteSize

  // Wrap remaining text normally
  let startIndex = firstBreak
  while (startIndex < text.length && text[startIndex] === " ") {
    startIndex++
  }

  if (startIndex < text.length) {
    const remainingText = text.substring(startIndex)
    const remainingResult = wrapText(remainingText, {
      ...opts,
      maxLines: opts.maxLines - 1,
      maxBytes: opts.maxBytes - totalByteSize,
    })

    for (const line of remainingResult.lines) {
      lines.push(line)
      totalByteSize += line.byteSize + 1 // +1 for newline
    }

    if (remainingResult.truncated) {
      return {
        lines,
        totalPixelWidth: Math.max(...lines.map((l) => l.pixelWidth)),
        totalByteSize,
        totalCharCount: lines.reduce((sum, l) => sum + l.charCount, 0),
        truncated: true,
        truncatedText: remainingResult.truncatedText,
        dominantScript: detectDominantScript(text),
      }
    }
  }

  return {
    lines,
    totalPixelWidth: Math.max(...lines.map((l) => l.pixelWidth)),
    totalByteSize,
    totalCharCount: lines.reduce((sum, l) => sum + l.charCount, 0),
    truncated: false,
    dominantScript: detectDominantScript(text),
  }
}

/**
 * Filter out unsupported characters from text
 */
export function filterUnsupportedChars(text: string, replacement: string = ""): string {
  let result = ""
  for (const char of text) {
    if (isCharSupported(char)) {
      result += char
    } else {
      result += replacement
    }
  }
  return result
}

/**
 * Prepare text for G1 display - filters, wraps, and validates
 */
export function prepareForDisplay(text: string, options: WrapOptions = {}): WrapResult {
  // Filter unsupported characters
  const filteredText = filterUnsupportedChars(text)

  // Wrap the text
  return wrapText(filteredText, options)
}
