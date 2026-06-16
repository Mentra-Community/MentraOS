import type { DisplayProfile } from "../profiles/types"
import { TextMeasurer } from "../measurer/TextMeasurer"
import { TextWrapper } from "../wrapper/TextWrapper"
import type { WrapOptions, WrapResult } from "../wrapper/types"

/**
 * Truncation result with metadata.
 */
export interface TruncateResult {
  /** The truncated text */
  text: string
  /** Whether text was truncated */
  wasTruncated: boolean
  /** Width in pixels of truncated text */
  widthPx: number
  /** Original text length */
  originalLength: number
  /** Truncated text length */
  truncatedLength: number
}

/**
 * Page result for pagination.
 */
export interface Page {
  /** Lines on this page */
  lines: string[]
  /** Page number (1-indexed) */
  pageNumber: number
  /** Total number of pages */
  totalPages: number
  /** Whether this is the first page */
  isFirst: boolean
  /** Whether this is the last page */
  isLast: boolean
}

/**
 * Chunk result for BLE transmission.
 */
export interface Chunk {
  /** The chunk text */
  text: string
  /** Chunk index (0-indexed) */
  index: number
  /** Total number of chunks */
  totalChunks: number
  /** Byte size of this chunk */
  bytes: number
}

/**
 * Optional helper utilities for common display operations.
 * Built on top of TextMeasurer and TextWrapper for convenience.
 */
export class DisplayHelpers {
  private readonly measurer: TextMeasurer
  private readonly wrapper: TextWrapper
  private readonly profile: DisplayProfile

  constructor(measurer: TextMeasurer, wrapper: TextWrapper) {
    this.measurer = measurer
    this.wrapper = wrapper
    this.profile = measurer.getProfile()
  }

  /**
   * Truncate lines array to max count.
   *
   * @param lines - Array of lines
   * @param maxLines - Maximum lines to keep
   * @param fromEnd - If true, keep last N lines; if false, keep first N (default: false)
   * @returns Truncated lines array
   */
  truncateToLines(lines: string[], maxLines: number, fromEnd: boolean = false): string[] {
    if (lines.length <= maxLines) {
      return lines
    }

    if (fromEnd) {
      // Keep the last N lines (most recent)
      return lines.slice(-maxLines)
    } else {
      // Keep the first N lines
      return lines.slice(0, maxLines)
    }
  }

  /**
   * Truncate text to fit within pixel width, adding ellipsis if needed.
   *
   * @param text - Text to truncate
   * @param maxWidthPx - Maximum width in pixels
   * @param ellipsis - Ellipsis string (default: '...')
   * @returns Truncation result
   */
  truncateWithEllipsis(
    text: string,
    maxWidthPx?: number,
    ellipsis: string = "..."
  ): TruncateResult {
    const width = maxWidthPx ?? this.profile.displayWidthPx
    const textWidth = this.measurer.measureText(text)

    if (textWidth <= width) {
      return {
        text,
        wasTruncated: false,
        widthPx: textWidth,
        originalLength: text.length,
        truncatedLength: text.length,
      }
    }

    const ellipsisWidth = this.measurer.measureText(ellipsis)
    const targetWidth = width - ellipsisWidth

    // Find how many characters fit
    let truncated = ""
    let currentWidth = 0

    for (const char of text) {
      const charWidth = this.measurer.measureChar(char)
      if (currentWidth + charWidth > targetWidth) {
        break
      }
      truncated += char
      currentWidth += charWidth
    }

    // Trim trailing whitespace before ellipsis
    truncated = truncated.trimEnd()
    const finalText = truncated + ellipsis

    return {
      text: finalText,
      wasTruncated: true,
      widthPx: this.measurer.measureText(finalText),
      originalLength: text.length,
      truncatedLength: truncated.length,
    }
  }

  /**
   * Estimate how many lines text will need without fully wrapping.
   * This is a quick estimate based on average character width.
   *
   * @param text - Text to estimate
   * @param maxWidthPx - Optional width override
   * @returns Estimated line count
   */
  estimateLineCount(text: string, maxWidthPx?: number): number {
    if (!text) return 1

    const width = maxWidthPx ?? this.profile.displayWidthPx
    const textWidth = this.measurer.measureText(text)

    // Account for explicit newlines
    const newlineCount = (text.match(/\n/g) || []).length

    // Estimate wrapped lines
    const wrappedLines = Math.ceil(textWidth / width)

    return wrappedLines + newlineCount
  }

  /**
   * Wrap and truncate text to fit screen in one call.
   *
   * @param text - Text to fit
   * @param options - Wrap options
   * @returns Lines that fit on screen
   */
  fitToScreen(text: string, options?: WrapOptions): string[] {
    const result = this.wrapper.wrap(text, options)
    return result.lines.slice(0, this.profile.maxLines)
  }

  /**
   * Wrap text and paginate into screen-sized pages.
   *
   * @param text - Text to paginate
   * @param options - Wrap options (maxLines will be used as page size)
   * @returns Array of pages
   */
  paginate(text: string, options?: WrapOptions): Page[] {
    // Wrap without line limit to get all lines
    const wrapResult = this.wrapper.wrap(text, {
      ...options,
      maxLines: Infinity,
      maxBytes: Infinity,
    })

    const linesPerPage = options?.maxLines ?? this.profile.maxLines
    const allLines = wrapResult.lines
    const pages: Page[] = []

    for (let i = 0; i < allLines.length; i += linesPerPage) {
      const pageLines = allLines.slice(i, i + linesPerPage)
      const pageNumber = Math.floor(i / linesPerPage) + 1
      const totalPages = Math.ceil(allLines.length / linesPerPage)

      pages.push({
        lines: pageLines,
        pageNumber,
        totalPages,
        isFirst: pageNumber === 1,
        isLast: pageNumber === totalPages,
      })
    }

    return pages.length > 0
      ? pages
      : [
          {
            lines: [""],
            pageNumber: 1,
            totalPages: 1,
            isFirst: true,
            isLast: true,
          },
        ]
  }

  /**
   * Calculate UTF-8 byte size of text.
   *
   * @param text - Text to measure
   * @returns Byte size
   */
  calculateByteSize(text: string): number {
    return this.measurer.getByteSize(text)
  }

  /**
   * Check if text exceeds byte limit.
   *
   * @param text - Text to check
   * @param maxBytes - Optional override (defaults to profile)
   * @returns true if exceeds limit
   */
  exceedsByteLimit(text: string, maxBytes?: number): boolean {
    const limit = maxBytes ?? this.profile.maxPayloadBytes
    return this.calculateByteSize(text) > limit
  }

  /**
   * Split text into BLE-safe chunks.
   * Tries to split at word/line boundaries when possible.
   *
   * @param text - Text to chunk
   * @param chunkSize - Optional override (defaults to profile)
   * @returns Array of chunks
   */
  splitIntoChunks(text: string, chunkSize?: number): Chunk[] {
    const size = chunkSize ?? this.profile.bleChunkSize
    const encoder = new TextEncoder()
    const bytes = encoder.encode(text)

    if (bytes.length <= size) {
      return [
        {
          text,
          index: 0,
          totalChunks: 1,
          bytes: bytes.length,
        },
      ]
    }

    const chunks: Chunk[] = []
    let offset = 0

    while (offset < bytes.length) {
      let endOffset = Math.min(offset + size, bytes.length)

      // Back off to avoid splitting a multi-byte character
      if (endOffset < bytes.length) {
        // Find a valid UTF-8 boundary
        while (endOffset > offset && (bytes[endOffset] & 0xc0) === 0x80) {
          endOffset--
        }

        // Try to find a good break point (space or newline)
        let breakPoint = endOffset
        for (let i = endOffset - 1; i > offset + size / 2; i--) {
          if (bytes[i] === 0x20 || bytes[i] === 0x0a) {
            // space or newline
            breakPoint = i + 1
            break
          }
        }
        if (breakPoint > offset) {
          endOffset = breakPoint
        }
      }

      const chunkBytes = bytes.slice(offset, endOffset)
      const chunkText = new TextDecoder().decode(chunkBytes)

      chunks.push({
        text: chunkText,
        index: chunks.length,
        totalChunks: 0, // Will be set after loop
        bytes: chunkBytes.length,
      })

      offset = endOffset
    }

    // Update total chunks count
    for (const chunk of chunks) {
      chunk.totalChunks = chunks.length
    }

    return chunks
  }

  /**
   * Calculate line utilization statistics.
   *
   * @param result - Wrap result to analyze
   * @returns Utilization statistics
   */
  calculateUtilization(result: WrapResult): {
    averageUtilization: number
    minUtilization: number
    maxUtilization: number
    totalWastedPx: number
  } {
    if (result.lines.length === 0 || result.lineMetrics.length === 0) {
      return {
        averageUtilization: 0,
        minUtilization: 0,
        maxUtilization: 0,
        totalWastedPx: 0,
      }
    }

    const maxWidthPx = this.profile.displayWidthPx
    let totalUtilization = 0
    let minUtilization = 100
    let maxUtilization = 0
    let totalWastedPx = 0

    for (const metric of result.lineMetrics) {
      totalUtilization += metric.utilizationPercent
      minUtilization = Math.min(minUtilization, metric.utilizationPercent)
      maxUtilization = Math.max(maxUtilization, metric.utilizationPercent)
      totalWastedPx += maxWidthPx - metric.widthPx
    }

    return {
      averageUtilization: Math.round(totalUtilization / result.lineMetrics.length),
      minUtilization,
      maxUtilization,
      totalWastedPx,
    }
  }

  /**
   * Pad lines array to exact count with empty strings.
   *
   * @param lines - Lines to pad
   * @param targetCount - Target number of lines
   * @param padAtEnd - If true, pad at end; if false, pad at start (default: true)
   * @returns Padded lines array
   */
  padToLineCount(lines: string[], targetCount: number, padAtEnd: boolean = true): string[] {
    if (lines.length >= targetCount) {
      return lines.slice(0, targetCount)
    }

    const padding = Array(targetCount - lines.length).fill("")

    if (padAtEnd) {
      return [...lines, ...padding]
    } else {
      return [...padding, ...lines]
    }
  }

  /**
   * Join lines with newlines for display.
   *
   * @param lines - Lines to join
   * @returns Joined string
   */
  joinLines(lines: string[]): string {
    return lines.join("\n")
  }

  /**
   * Get the measurer instance.
   */
  getMeasurer(): TextMeasurer {
    return this.measurer
  }

  /**
   * Get the wrapper instance.
   */
  getWrapper(): TextWrapper {
    return this.wrapper
  }

  /**
   * Get the display profile.
   */
  getProfile(): DisplayProfile {
    return this.profile
  }
}
