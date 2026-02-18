import {getTextVisualWidth, getCharWidth, isCJKCharacter, VISUAL_WIDTH_SAFETY_MARGIN} from "./visualWidth"

// Hyphen character and its visual width for breaking calculations
const HYPHEN = "-"
const HYPHEN_VISUAL_WIDTH = 1.0 // Hyphen glyph is ~4px, which is 1 visual unit (like narrow chars)

/**
 * Entry in the transcript history that preserves speaker information
 */
export interface TranscriptHistoryEntry {
  text: string
  speakerId?: string
  hadSpeakerChange: boolean
}

export class TranscriptProcessor {
  private maxVisualWidth: number // Maximum visual width per line (not character count)
  private maxLines: number
  private lines: string[]
  private partialText: string
  private lastUserTranscript: string
  private finalTranscriptHistory: TranscriptHistoryEntry[] // Array to store history of final transcripts with speaker info
  private maxFinalTranscripts: number // Max number of final transcripts to keep
  private currentDisplayLines: string[] // Track current display lines to maintain consistency
  private lastSpeakerId: string | undefined = undefined // Track last speaker for combining history
  private partialSpeakerId: string | undefined = undefined // Track speaker ID of current partial
  private partialHadSpeakerChange: boolean = false // Track if current partial represents a speaker change
  private useCharacterBreaking: boolean // If true, break mid-word for 100% line utilization; if false, prefer word boundaries

  /**
   * Create a new TranscriptProcessor
   *
   * @param maxVisualWidth - Maximum visual width per line (1 unit = 1 Latin char, CJK = 2 units)
   * @param maxLines - Maximum number of lines to display
   * @param maxFinalTranscripts - Maximum number of final transcripts to keep in history
   * @param useCharacterBreaking - If true, break mid-word for 100% line utilization; if false, prefer word boundaries (default: true)
   */
  constructor(
    maxVisualWidth: number,
    maxLines: number,
    maxFinalTranscripts: number = 3,
    useCharacterBreaking: boolean = true, // Default to character breaking for max utilization
  ) {
    this.maxVisualWidth = maxVisualWidth
    this.maxLines = maxLines
    this.lastUserTranscript = ""
    this.lines = []
    this.partialText = ""
    this.finalTranscriptHistory = [] // Initialize empty history
    this.maxFinalTranscripts = maxFinalTranscripts // Default to 3 if not specified
    this.currentDisplayLines = [] // Initialize display lines
    this.useCharacterBreaking = useCharacterBreaking
  }

  /**
   * Enable or disable character-level breaking
   * @param enabled - If true, break mid-word for 100% line utilization; if false, prefer word boundaries
   */
  public setCharacterBreaking(enabled: boolean): void {
    this.useCharacterBreaking = enabled
  }

  /**
   * Check if character-level breaking is enabled
   */
  public isCharacterBreakingEnabled(): boolean {
    return this.useCharacterBreaking
  }

  /**
   * Process a transcription string and format it for display
   *
   * @param newText - The new transcription text
   * @param isFinal - Whether this is a final transcription
   * @param speakerId - Optional speaker ID from diarization
   * @param speakerChanged - Whether the speaker changed from the previous transcription
   * @returns Formatted string for display
   */
  public processString(newText: string | null, isFinal: boolean, speakerId?: string, speakerChanged?: boolean): string {
    newText = newText === null ? "" : newText.trim()

    if (!isFinal) {
      // Store this as the current partial text (overwriting old partial)
      this.partialText = newText
      this.lastUserTranscript = newText

      // Track speaker info for this partial
      // If speakerChanged is true, remember it for subsequent interims from the same speaker
      // This fixes the bug where the label disappears on the 2nd, 3rd, etc. interim
      if (speakerChanged && speakerId) {
        this.partialSpeakerId = speakerId
        this.partialHadSpeakerChange = true
      } else if (speakerId && speakerId !== this.partialSpeakerId) {
        // Different speaker than tracked partial - this is a new speaker change
        this.partialSpeakerId = speakerId
        this.partialHadSpeakerChange = true
      }
      // If same speaker as tracked partial, keep partialHadSpeakerChange as-is

      // Build display text from history + partial, using tracked speaker info
      const displayText = this.buildDisplayText(newText, this.partialSpeakerId, this.partialHadSpeakerChange)
      this.currentDisplayLines = this.wrapTextByVisualWidth(displayText)

      // Ensure we have exactly maxLines
      while (this.currentDisplayLines.length < this.maxLines) {
        this.currentDisplayLines.push("")
      }
      while (this.currentDisplayLines.length > this.maxLines) {
        this.currentDisplayLines.shift()
      }

      return this.currentDisplayLines.join("\n")
    } else {
      // We have a final text -> clear out the partial text to avoid duplication
      this.partialText = ""

      // Use tracked partial speaker info if available (for when final comes after interims)
      const finalSpeakerId = speakerId || this.partialSpeakerId
      const finalSpeakerChanged = speakerChanged || this.partialHadSpeakerChange

      // Clear partial speaker tracking since we're finalizing
      this.partialSpeakerId = undefined
      this.partialHadSpeakerChange = false

      // Add to transcript history when it's a final transcript
      this.addToTranscriptHistory(newText, finalSpeakerId, finalSpeakerChanged)

      // Build display text from history only (no partial)
      const displayText = this.buildDisplayText("", undefined, false)
      this.currentDisplayLines = this.wrapTextByVisualWidth(displayText)

      // Ensure we have exactly maxLines
      while (this.currentDisplayLines.length < this.maxLines) {
        this.currentDisplayLines.push("")
      }
      while (this.currentDisplayLines.length > this.maxLines) {
        this.currentDisplayLines.shift()
      }

      return this.currentDisplayLines.join("\n")
    }
  }

  /**
   * Build the display text from history and optional partial text
   * Adds speaker labels [N]: when speaker changes, always on a new line
   */
  private buildDisplayText(partialText: string, partialSpeakerId?: string, partialSpeakerChanged?: boolean): string {
    let result = ""

    // Add history entries with speaker labels
    for (const entry of this.finalTranscriptHistory) {
      if (entry.hadSpeakerChange && entry.speakerId) {
        // Speaker change: add newline before label (if not at start)
        if (result.length > 0) {
          result += "\n"
        }
        result += `[${entry.speakerId}]: ${entry.text}`
      } else {
        // Same speaker: append with space
        if (result.length > 0) {
          result += " "
        }
        result += entry.text
      }
    }

    // Add partial text if present
    if (partialText) {
      if (partialSpeakerChanged && partialSpeakerId) {
        // Speaker change: add newline before label (if not at start)
        if (result.length > 0) {
          result += "\n"
        }
        result += `[${partialSpeakerId}]: ${partialText}`
      } else {
        // Same speaker: append with space
        if (result.length > 0) {
          result += " "
        }
        result += partialText
      }
    }

    return result
  }

  /**
   * Add a transcript to history with speaker information
   */
  private addToTranscriptHistory(transcript: string, speakerId?: string, speakerChanged?: boolean): void {
    if (transcript.trim() === "") return // Don't add empty transcripts

    const entry: TranscriptHistoryEntry = {
      text: transcript,
      speakerId,
      hadSpeakerChange: speakerChanged || false,
    }

    this.finalTranscriptHistory.push(entry)

    // Track the speaker for future reference
    if (speakerId) {
      this.lastSpeakerId = speakerId
    }

    // Ensure we don't exceed maxFinalTranscripts
    while (this.finalTranscriptHistory.length > this.maxFinalTranscripts) {
      this.finalTranscriptHistory.shift() // Remove oldest transcript
    }
  }

  /**
   * Get the transcript history with speaker information preserved
   */
  public getFinalTranscriptHistory(): TranscriptHistoryEntry[] {
    return [...this.finalTranscriptHistory] // Return a copy to prevent external modification
  }

  /**
   * Get combined transcript history as a single string (for backwards compatibility)
   * Note: This doesn't include speaker labels - use buildDisplayText for that
   */
  public getCombinedTranscriptHistory(): string {
    return this.finalTranscriptHistory.map((entry) => entry.text).join(" ")
  }

  // Get current display lines (for refreshing display after settings change)
  public getCurrentDisplayLines(): string[] {
    return [...this.currentDisplayLines]
  }

  // Get current display as formatted string
  public getCurrentDisplay(): string {
    return this.currentDisplayLines.join("\n")
  }

  // Method to set max final transcripts
  public setMaxFinalTranscripts(maxFinalTranscripts: number): void {
    this.maxFinalTranscripts = maxFinalTranscripts
    // Trim history if needed after changing the limit
    while (this.finalTranscriptHistory.length > this.maxFinalTranscripts) {
      this.finalTranscriptHistory.shift()
    }
  }

  // Get max final transcripts
  public getMaxFinalTranscripts(): number {
    return this.maxFinalTranscripts
  }

  /**
   * Wrap text by visual width with character-level hyphenation for 100% line utilization.
   *
   * Key features:
   * - Fills each line to maximum width (576px / maxVisualWidth)
   * - Breaks mid-word with hyphen when needed
   * - Accounts for hyphen width in break calculations
   * - CJK characters can break anywhere without hyphen
   * - Preserves explicit newlines (for speaker labels)
   *
   * @param text - Text to wrap
   * @returns Array of wrapped lines
   */
  private wrapTextByVisualWidth(text: string): string[] {
    if (!text || text.trim() === "") {
      return [""]
    }

    const result: string[] = []
    const maxWidth = this.maxVisualWidth * VISUAL_WIDTH_SAFETY_MARGIN

    // Split by explicit newlines first (from speaker changes)
    const paragraphs = text.split("\n")

    for (const paragraph of paragraphs) {
      const trimmed = paragraph.trim()

      if (trimmed === "") {
        // Skip empty paragraphs
        continue
      }

      // Wrap this paragraph - use character breaking or word breaking based on setting
      if (this.useCharacterBreaking) {
        const wrappedLines = this.wrapParagraphWithHyphenation(trimmed, maxWidth)
        result.push(...wrappedLines)
      } else {
        const wrappedLines = this.wrapParagraphWordBoundary(trimmed, maxWidth)
        result.push(...wrappedLines)
      }
    }

    return result.length > 0 ? result : [""]
  }

  /**
   * Wrap a single paragraph preferring word boundaries.
   * Falls back to hyphenation only when a single word exceeds line width.
   *
   * @param text - Paragraph text (no newlines)
   * @param maxWidth - Maximum visual width per line
   * @returns Array of wrapped lines
   */
  private wrapParagraphWordBoundary(text: string, maxWidth: number): string[] {
    const lines: string[] = []
    const words = text.split(" ")
    let currentLine = ""
    let currentWidth = 0

    for (const word of words) {
      const wordWidth = getTextVisualWidth(word)
      const spaceWidth = currentLine.length > 0 ? getCharWidth(" ") : 0

      // Check if word fits on current line (with space if not first word)
      if (currentWidth + spaceWidth + wordWidth <= maxWidth) {
        if (currentLine.length > 0) {
          currentLine += " "
          currentWidth += spaceWidth
        }
        currentLine += word
        currentWidth += wordWidth
      } else {
        // Word doesn't fit on current line

        // First, push current line if it has content
        if (currentLine.length > 0) {
          lines.push(currentLine)
          currentLine = ""
          currentWidth = 0
        }

        // Check if word itself fits on a fresh line
        if (wordWidth <= maxWidth) {
          currentLine = word
          currentWidth = wordWidth
        } else {
          // Word is too long - must hyphenate this single word
          const hyphenatedLines = this.hyphenateLongWord(word, maxWidth)
          // Add all but the last line
          for (let i = 0; i < hyphenatedLines.length - 1; i++) {
            lines.push(hyphenatedLines[i])
          }
          // Keep the last part as current line
          if (hyphenatedLines.length > 0) {
            currentLine = hyphenatedLines[hyphenatedLines.length - 1]
            currentWidth = getTextVisualWidth(currentLine)
          }
        }
      }
    }

    // Don't forget the last line
    if (currentLine.length > 0) {
      lines.push(currentLine)
    }

    return lines.length > 0 ? lines : [""]
  }

  /**
   * Hyphenate a single word that's too long to fit on one line.
   * Used by word-boundary mode when a word exceeds max width.
   *
   * @param word - The long word to hyphenate
   * @param maxWidth - Maximum visual width per line
   * @returns Array of hyphenated line segments
   */
  private hyphenateLongWord(word: string, maxWidth: number): string[] {
    const lines: string[] = []
    let currentLine = ""
    let currentWidth = 0

    for (const char of word) {
      const charWidth = getCharWidth(char)

      // Check if char fits (accounting for hyphen if we'll need to break)
      if (currentWidth + charWidth + HYPHEN_VISUAL_WIDTH <= maxWidth) {
        currentLine += char
        currentWidth += charWidth
      } else if (currentWidth + charWidth <= maxWidth && isCJKCharacter(char)) {
        // CJK doesn't need hyphen, can fit exactly
        currentLine += char
        currentWidth += charWidth
      } else {
        // Need to break
        if (currentLine.length > 0) {
          // Add hyphen for non-CJK
          const lastChar = currentLine[currentLine.length - 1]
          if (!isCJKCharacter(lastChar)) {
            currentLine += HYPHEN
          }
          lines.push(currentLine)
        }
        currentLine = char
        currentWidth = charWidth
      }
    }

    if (currentLine.length > 0) {
      lines.push(currentLine)
    }

    return lines
  }

  /**
   * Wrap a single paragraph with character-level hyphenation.
   * Achieves ~100% line utilization by breaking mid-word when necessary.
   *
   * @param text - Paragraph text (no newlines)
   * @param maxWidth - Maximum visual width per line
   * @returns Array of wrapped lines
   */
  private wrapParagraphWithHyphenation(text: string, maxWidth: number): string[] {
    const lines: string[] = []
    let currentLine = ""
    let currentWidth = 0

    for (let i = 0; i < text.length; i++) {
      const char = text[i]
      const charWidth = getCharWidth(char)

      // Check if this character fits on current line
      if (currentWidth + charWidth <= maxWidth) {
        currentLine += char
        currentWidth += charWidth
      } else {
        // Character doesn't fit - need to break the line
        const breakResult = this.breakLineWithHyphen(currentLine, currentWidth, maxWidth, char)

        lines.push(breakResult.line)
        currentLine = breakResult.remainder + char
        currentWidth = getTextVisualWidth(currentLine)
      }
    }

    // Don't forget the last line
    if (currentLine.length > 0) {
      lines.push(currentLine.trimEnd())
    }

    return lines
  }

  /**
   * Break a line, adding hyphen if needed and ensuring it fits within maxWidth.
   *
   * Key insight: The hyphen itself takes space, so we may need to remove
   * characters from the line to make room for the hyphen.
   *
   * @param line - Current line content
   * @param lineWidth - Current line width in visual units
   * @param maxWidth - Maximum allowed width
   * @param nextChar - The character that caused overflow (for context)
   * @returns Object with the final line and any remainder to carry over
   */
  private breakLineWithHyphen(
    line: string,
    lineWidth: number,
    maxWidth: number,
    nextChar: string,
  ): {line: string; remainder: string} {
    // If line ends with space, just trim it - no hyphen needed
    if (line.endsWith(" ")) {
      return {line: line.trimEnd(), remainder: ""}
    }

    // If line is empty, nothing to do
    if (line.length === 0) {
      return {line: "", remainder: ""}
    }

    // Check if the last character is CJK - CJK can break without hyphen
    const lastChar = line[line.length - 1]
    if (isCJKCharacter(lastChar)) {
      return {line: line, remainder: ""}
    }

    // Check if next char is a space - if so, we can break cleanly
    if (nextChar === " ") {
      return {line: line, remainder: ""}
    }

    // Check if next char is CJK - can break before CJK without hyphen
    if (isCJKCharacter(nextChar)) {
      return {line: line, remainder: ""}
    }

    // Need to add hyphen - but first ensure there's room for it
    let adjustedLine = line
    let adjustedWidth = lineWidth
    let remainder = ""

    // Remove characters until hyphen fits
    while (adjustedWidth + HYPHEN_VISUAL_WIDTH > maxWidth && adjustedLine.length > 0) {
      const removedChar = adjustedLine[adjustedLine.length - 1]
      adjustedLine = adjustedLine.slice(0, -1)
      adjustedWidth -= getCharWidth(removedChar)
      remainder = removedChar + remainder
    }

    // Don't add hyphen if we removed everything or line ends with space/punctuation
    if (adjustedLine.length === 0) {
      return {line: "", remainder: remainder}
    }

    const lastAdjustedChar = adjustedLine[adjustedLine.length - 1]
    if (lastAdjustedChar === " " || lastAdjustedChar === "-") {
      return {line: adjustedLine.trimEnd(), remainder: remainder}
    }

    // Avoid very short breaks (less than 3 chars before hyphen looks odd)
    // But only if we have enough room to push more to next line
    if (adjustedLine.length < 3 && line.length >= 3) {
      // Try to find a better break point by looking for a space
      const spaceIndex = line.lastIndexOf(" ")
      if (spaceIndex > 0) {
        return {
          line: line.substring(0, spaceIndex),
          remainder: line.substring(spaceIndex + 1),
        }
      }
    }

    // Add hyphen
    return {line: adjustedLine + HYPHEN, remainder: remainder}
  }

  /**
   * Find the best break point within visual width limit
   * @deprecated Use wrapParagraphWithHyphenation instead for 100% utilization
   */
  private findVisualWidthBreakpoint(text: string, maxWidth: number): number {
    let currentWidth = 0
    let lastGoodBreakpoint = 0

    for (let i = 0; i < text.length; i++) {
      const char = text[i]
      const charWidth = getCharWidth(char)

      // Would this character exceed the limit?
      if (currentWidth + charWidth > maxWidth) {
        // Return the last good breakpoint, or current position if none found
        return lastGoodBreakpoint > 0 ? lastGoodBreakpoint : i
      }

      currentWidth += charWidth

      // Track good breakpoints:
      // 1. After a space (for Latin text word boundaries)
      // 2. After a CJK character (CJK can break anywhere)
      // 3. Before a CJK character following non-CJK
      if (char === " ") {
        lastGoodBreakpoint = i + 1 // Break after the space
      } else if (isCJKCharacter(char)) {
        lastGoodBreakpoint = i + 1 // Can break after any CJK character
      } else if (i + 1 < text.length && isCJKCharacter(text[i + 1]) && !isCJKCharacter(char)) {
        // Before a CJK character that follows non-CJK
        lastGoodBreakpoint = i + 1
      }
    }

    // If we get here, entire text fits
    return text.length
  }

  private appendToLines(chunk: string): void {
    if (this.lines.length === 0) {
      this.lines.push(chunk)
    } else {
      const lastLine = this.lines.pop() as string
      const candidate = lastLine === "" ? chunk : lastLine + " " + chunk
      const candidateWidth = getTextVisualWidth(candidate)

      if (candidateWidth <= this.maxVisualWidth * VISUAL_WIDTH_SAFETY_MARGIN) {
        this.lines.push(candidate)
      } else {
        // Put back the last line if it doesn't fit
        this.lines.push(lastLine)
        this.lines.push(chunk)
      }
    }

    // Ensure we don't exceed maxLines
    while (this.lines.length > this.maxLines) {
      this.lines.shift()
    }
  }

  public getTranscript(): string {
    // Create a copy of the lines for manipulation
    const allLines = [...this.lines]

    // Add padding to ensure exactly maxLines are displayed
    const linesToPad = this.maxLines - allLines.length
    for (let i = 0; i < linesToPad; i++) {
      allLines.push("") // Add empty lines at the end
    }

    const finalString = allLines.join("\n")

    // Clear the lines
    this.lines = []
    return finalString
  }

  public getLastUserTranscript(): string {
    return this.lastUserTranscript
  }

  public clear(): void {
    this.lines = []
    this.partialText = ""
    this.finalTranscriptHistory = []
    this.currentDisplayLines = []
    this.lastSpeakerId = undefined
    this.partialSpeakerId = undefined
    this.partialHadSpeakerChange = false
  }

  public getMaxVisualWidth(): number {
    return this.maxVisualWidth
  }

  /**
   * @deprecated Use getMaxVisualWidth() instead. Kept for backwards compatibility.
   */
  public getMaxCharsPerLine(): number {
    return this.maxVisualWidth
  }

  public getMaxLines(): number {
    return this.maxLines
  }
}
