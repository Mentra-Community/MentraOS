import type {DisplayProfile} from "../profiles/types"
import {TextMeasurer} from "../measurer/TextMeasurer"
import {TextWrapper} from "../wrapper/TextWrapper"
import type {WrapOptions, WrapResult} from "../wrapper/types"

/**
 * Scroll position information.
 */
export interface ScrollPosition {
  /** Current scroll offset (0 = top) */
  offset: number
  /** Total number of lines in content */
  totalLines: number
  /** Number of visible lines (viewport size) */
  visibleLines: number
  /** Maximum scroll offset */
  maxOffset: number
  /** Whether we're at the top */
  atTop: boolean
  /** Whether we're at the bottom */
  atBottom: boolean
  /** Scroll percentage (0-100) */
  scrollPercent: number
}

/**
 * Visible content from the scroll view.
 */
export interface ScrollViewport {
  /** Lines currently visible */
  lines: string[]
  /** Scroll position info */
  position: ScrollPosition
  /** Whether content was truncated during wrapping */
  contentTruncated: boolean
}

/**
 * ScrollView provides a scrollable viewport into long wrapped text.
 *
 * Unlike pagination (discrete pages), scrolling allows continuous
 * movement through content line by line.
 *
 * @example
 * ```typescript
 * const scrollView = new ScrollView(measurer, wrapper)
 * scrollView.setContent("Very long text that wraps to many lines...")
 *
 * // Get initial view (top)
 * let view = scrollView.getViewport()
 * console.log(view.lines) // First 5 lines
 *
 * // Scroll down
 * scrollView.scrollDown(2) // Move down 2 lines
 * view = scrollView.getViewport()
 *
 * // Scroll to bottom
 * scrollView.scrollToBottom()
 *
 * // Scroll to specific position
 * scrollView.scrollTo(10) // Line 10 at top of viewport
 * ```
 */
export class ScrollView {
  private readonly measurer: TextMeasurer
  private readonly wrapper: TextWrapper
  private readonly profile: DisplayProfile
  private readonly viewportSize: number

  private allLines: string[] = []
  private wrapResult: WrapResult | null = null
  private scrollOffset: number = 0

  constructor(
    measurer: TextMeasurer,
    wrapper: TextWrapper,
    viewportSize?: number
  ) {
    this.measurer = measurer
    this.wrapper = wrapper
    this.profile = measurer.getProfile()
    this.viewportSize = viewportSize ?? this.profile.maxLines
  }

  /**
   * Set the content to display in the scroll view.
   * Wraps the text and resets scroll position to top.
   *
   * @param text - Text content to display
   * @param options - Optional wrap options
   */
  setContent(text: string, options?: Omit<WrapOptions, "maxLines">): void {
    // Wrap without line limit to get all lines
    this.wrapResult = this.wrapper.wrap(text, {
      ...options,
      maxLines: Infinity,
      maxBytes: Infinity,
    })
    this.allLines = this.wrapResult.lines
    this.scrollOffset = 0
  }

  /**
   * Append content to the existing scroll view.
   * Useful for streaming/live content like captions.
   *
   * @param text - Text to append
   * @param options - Optional wrap options
   * @param autoScroll - If true, scroll to show new content (default: true)
   */
  appendContent(
    text: string,
    options?: Omit<WrapOptions, "maxLines">,
    autoScroll: boolean = true
  ): void {
    const wasAtBottom = this.isAtBottom()

    // Wrap the new text
    const newResult = this.wrapper.wrap(text, {
      ...options,
      maxLines: Infinity,
      maxBytes: Infinity,
    })

    // Append new lines
    this.allLines = [...this.allLines, ...newResult.lines]

    // Auto-scroll to bottom if we were already there
    if (autoScroll && wasAtBottom) {
      this.scrollToBottom()
    }
  }

  /**
   * Get the current viewport (visible lines).
   */
  getViewport(): ScrollViewport {
    const visibleLines = this.allLines.slice(
      this.scrollOffset,
      this.scrollOffset + this.viewportSize
    )

    // Pad to viewport size if needed
    while (visibleLines.length < this.viewportSize) {
      visibleLines.push("")
    }

    return {
      lines: visibleLines,
      position: this.getPosition(),
      contentTruncated: this.wrapResult?.truncated ?? false,
    }
  }

  /**
   * Get current scroll position information.
   */
  getPosition(): ScrollPosition {
    const totalLines = this.allLines.length
    const maxOffset = Math.max(0, totalLines - this.viewportSize)

    return {
      offset: this.scrollOffset,
      totalLines,
      visibleLines: this.viewportSize,
      maxOffset,
      atTop: this.scrollOffset === 0,
      atBottom: this.scrollOffset >= maxOffset,
      scrollPercent: maxOffset > 0 ? Math.round((this.scrollOffset / maxOffset) * 100) : 100,
    }
  }

  /**
   * Scroll to a specific line offset.
   *
   * @param offset - Line offset (0 = top)
   */
  scrollTo(offset: number): void {
    const maxOffset = Math.max(0, this.allLines.length - this.viewportSize)
    this.scrollOffset = Math.max(0, Math.min(offset, maxOffset))
  }

  /**
   * Scroll down by a number of lines.
   *
   * @param lines - Number of lines to scroll (default: 1)
   */
  scrollDown(lines: number = 1): void {
    this.scrollTo(this.scrollOffset + lines)
  }

  /**
   * Scroll up by a number of lines.
   *
   * @param lines - Number of lines to scroll (default: 1)
   */
  scrollUp(lines: number = 1): void {
    this.scrollTo(this.scrollOffset - lines)
  }

  /**
   * Scroll down by one viewport (page down).
   */
  pageDown(): void {
    this.scrollDown(this.viewportSize)
  }

  /**
   * Scroll up by one viewport (page up).
   */
  pageUp(): void {
    this.scrollUp(this.viewportSize)
  }

  /**
   * Scroll to the top.
   */
  scrollToTop(): void {
    this.scrollOffset = 0
  }

  /**
   * Scroll to the bottom.
   */
  scrollToBottom(): void {
    const maxOffset = Math.max(0, this.allLines.length - this.viewportSize)
    this.scrollOffset = maxOffset
  }

  /**
   * Scroll to show a specific line in the viewport.
   *
   * @param lineIndex - The line index to show
   * @param position - Where in viewport: 'top', 'center', 'bottom' (default: 'top')
   */
  scrollToLine(lineIndex: number, position: "top" | "center" | "bottom" = "top"): void {
    let targetOffset: number

    switch (position) {
      case "top":
        targetOffset = lineIndex
        break
      case "center":
        targetOffset = lineIndex - Math.floor(this.viewportSize / 2)
        break
      case "bottom":
        targetOffset = lineIndex - this.viewportSize + 1
        break
    }

    this.scrollTo(targetOffset)
  }

  /**
   * Scroll by a percentage of total content.
   *
   * @param percent - Percentage (0-100)
   */
  scrollToPercent(percent: number): void {
    const maxOffset = Math.max(0, this.allLines.length - this.viewportSize)
    const targetOffset = Math.round((percent / 100) * maxOffset)
    this.scrollTo(targetOffset)
  }

  /**
   * Check if currently at the top.
   */
  isAtTop(): boolean {
    return this.scrollOffset === 0
  }

  /**
   * Check if currently at the bottom.
   */
  isAtBottom(): boolean {
    const maxOffset = Math.max(0, this.allLines.length - this.viewportSize)
    return this.scrollOffset >= maxOffset
  }

  /**
   * Check if content is scrollable (more lines than viewport).
   */
  isScrollable(): boolean {
    return this.allLines.length > this.viewportSize
  }

  /**
   * Get all lines (not just visible).
   */
  getAllLines(): string[] {
    return [...this.allLines]
  }

  /**
   * Get total line count.
   */
  getTotalLines(): number {
    return this.allLines.length
  }

  /**
   * Get the viewport size.
   */
  getViewportSize(): number {
    return this.viewportSize
  }

  /**
   * Clear all content and reset scroll position.
   */
  clear(): void {
    this.allLines = []
    this.wrapResult = null
    this.scrollOffset = 0
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
