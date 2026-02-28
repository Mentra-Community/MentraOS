/**
 * CaptionsFormatter
 *
 * Formats transcription text for display on smart glasses using @mentra/display-utils.
 * Handles speaker labels, history management, and proper text wrapping.
 *
 * This is the app-specific layer that sits on top of the generic display-utils.
 * Speaker label formatting and history management belong here, not in the SDK.
 */

import {
  TextMeasurer,
  TextWrapper,
  DisplayHelpers,
  G1_PROFILE,
  G1_PROFILE_LEGACY,
  type DisplayProfile,
  type WrapOptions,
  type WrapResult,
} from "@mentra/sdk/display-utils"

// Re-export profiles for convenience
export {G1_PROFILE, G1_PROFILE_LEGACY}

/**
 * Entry in the transcript history that preserves speaker information.
 */
export interface TranscriptHistoryEntry {
  text: string
  speakerId?: string
  hadSpeakerChange: boolean
}

/**
 * Options for the CaptionsFormatter.
 */
export interface CaptionsFormatterOptions {
  /** Maximum number of final transcripts to keep in history */
  maxFinalTranscripts?: number
  /** Break mode for text wrapping */
  breakMode?: "character" | "word" | "strict-word"
  /** Whether to use character-level breaking for 100% utilization */
  useCharacterBreaking?: boolean
  /** Override display width in pixels (defaults to profile's displayWidthPx) */
  displayWidthPx?: number
  /** Override max lines (defaults to profile's maxLines) */
  maxLines?: number
}

/**
 * Result from processing a transcription.
 */
export interface FormatResult {
  /** Formatted lines for display */
  lines: string[]
  /** Joined display text */
  displayText: string
  /** Whether content was truncated */
  truncated: boolean
  /** Per-line metrics */
  lineMetrics: WrapResult["lineMetrics"]
}

/**
 * CaptionsFormatter handles transcription text formatting for display on glasses.
 *
 * Responsibilities:
 * - Managing transcript history with speaker information
 * - Adding speaker labels [N]: when speaker changes
 * - Wrapping and formatting text using display-utils
 *
 * Profile Selection:
 * - Use `G1_PROFILE` for NEW mobile clients (no double-wrapping)
 * - Use `G1_PROFILE_LEGACY` for OLD mobile clients that re-wrap text
 *
 * @example
 * ```typescript
 * // For new mobile clients (recommended)
 * const formatter = new CaptionsFormatter(G1_PROFILE)
 *
 * // For old mobile clients that double-wrap
 * const formatter = new CaptionsFormatter(G1_PROFILE_LEGACY)
 * ```
 */
export class CaptionsFormatter {
  private readonly measurer: TextMeasurer
  private readonly wrapper: TextWrapper
  private readonly helpers: DisplayHelpers
  private readonly profile: DisplayProfile

  // History management
  private finalTranscriptHistory: TranscriptHistoryEntry[] = []
  private maxFinalTranscripts: number

  // Partial text tracking
  private partialSpeakerId: string | undefined = undefined
  private partialHadSpeakerChange: boolean = false

  // Display settings (can override profile defaults)
  private readonly displayWidthPx: number
  private readonly maxLines: number

  constructor(profile: DisplayProfile = G1_PROFILE, options: CaptionsFormatterOptions = {}) {
    this.profile = profile
    this.maxFinalTranscripts = options.maxFinalTranscripts ?? 30

    // Allow overriding display dimensions (for user settings like narrow/medium/wide)
    this.displayWidthPx = options.displayWidthPx ?? profile.displayWidthPx
    this.maxLines = options.maxLines ?? profile.maxLines

    // Determine break mode
    const breakMode = options.breakMode ?? (options.useCharacterBreaking !== false ? "character" : "word")

    // Create display utilities
    this.measurer = new TextMeasurer(profile)
    this.wrapper = new TextWrapper(this.measurer, {
      breakMode,
      hyphenChar: "-",
      minCharsBeforeHyphen: 3,
    })
    this.helpers = new DisplayHelpers(this.measurer, this.wrapper)
  }

  /**
   * Process a transcription and format it for display.
   *
   * @param text - The transcription text
   * @param isFinal - Whether this is a final transcription
   * @param speakerId - Optional speaker ID from diarization
   * @param speakerChanged - Whether the speaker changed from previous transcription
   * @returns Formatted lines for display
   */
  processTranscription(
    text: string | null,
    isFinal: boolean,
    speakerId?: string,
    speakerChanged?: boolean,
  ): FormatResult {
    const cleanText = text?.trim() ?? ""

    if (!isFinal) {
      return this.processInterim(cleanText, speakerId, speakerChanged)
    } else {
      return this.processFinal(cleanText, speakerId, speakerChanged)
    }
  }

  /**
   * Process an interim (non-final) transcription.
   */
  private processInterim(text: string, speakerId?: string, speakerChanged?: boolean): FormatResult {
    // Track speaker info for this partial
    if (speakerChanged && speakerId) {
      this.partialSpeakerId = speakerId
      this.partialHadSpeakerChange = true
    } else if (speakerId && speakerId !== this.partialSpeakerId) {
      this.partialSpeakerId = speakerId
      this.partialHadSpeakerChange = true
    }

    // Build display text from history + partial
    const displayText = this.buildDisplayText(text, this.partialSpeakerId, this.partialHadSpeakerChange)

    return this.wrapAndFormat(displayText)
  }

  /**
   * Process a final transcription.
   */
  private processFinal(text: string, speakerId?: string, speakerChanged?: boolean): FormatResult {
    // Use tracked partial speaker info if available
    const finalSpeakerId = speakerId || this.partialSpeakerId
    const finalSpeakerChanged = speakerChanged || this.partialHadSpeakerChange

    // Clear partial speaker tracking
    this.partialSpeakerId = undefined
    this.partialHadSpeakerChange = false

    // Add to transcript history
    if (text) {
      this.addToHistory(text, finalSpeakerId, finalSpeakerChanged)
    }

    // Build display text from history only (no partial)
    const displayText = this.buildDisplayText("", undefined, false)

    return this.wrapAndFormat(displayText)
  }

  /**
   * Build display text from history and optional partial text.
   * Adds speaker labels [N]: when speaker changes, always on a new line.
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
   * Wrap text and format for display.
   */
  private wrapAndFormat(displayText: string): FormatResult {
    // Wrap WITHOUT maxLines constraint so we get ALL lines
    // Then we'll take the LAST N lines (most recent) for display
    const result = this.wrapper.wrap(displayText, {
      maxWidthPx: this.displayWidthPx, // Use instance setting, not profile
      maxLines: Infinity, // Don't truncate during wrapping
      maxBytes: Infinity, // Don't truncate during wrapping
    })

    // Keep most recent lines (from the END) if we have too many
    let lines = result.lines
    if (lines.length > this.maxLines) {
      lines = lines.slice(-this.maxLines)
    }

    // Check if we truncated (had more lines than maxLines)
    const wasTruncated = result.lines.length > this.maxLines

    return {
      lines,
      displayText: lines.join("\n"),
      truncated: wasTruncated,
      lineMetrics: result.lineMetrics.slice(-this.maxLines),
    }
  }

  /**
   * Add a transcript to history with speaker information.
   */
  private addToHistory(transcript: string, speakerId?: string, speakerChanged?: boolean): void {
    if (!transcript.trim()) return

    this.finalTranscriptHistory.push({
      text: transcript,
      speakerId,
      hadSpeakerChange: speakerChanged ?? false,
    })

    // Trim history if needed
    while (this.finalTranscriptHistory.length > this.maxFinalTranscripts) {
      this.finalTranscriptHistory.shift()
    }
  }

  /**
   * Get the transcript history with speaker information preserved.
   */
  getFinalTranscriptHistory(): TranscriptHistoryEntry[] {
    return [...this.finalTranscriptHistory]
  }

  /**
   * Get combined transcript history as a single string.
   * Note: This doesn't include speaker labels - use buildDisplayText for that.
   */
  getCombinedTranscriptHistory(): string {
    return this.finalTranscriptHistory.map((entry) => entry.text).join(" ")
  }

  /**
   * Clear all history and reset state.
   */
  clear(): void {
    this.finalTranscriptHistory = []
    this.partialSpeakerId = undefined
    this.partialHadSpeakerChange = false
  }

  /**
   * Set the maximum number of final transcripts to keep.
   */
  setMaxFinalTranscripts(max: number): void {
    this.maxFinalTranscripts = max
    while (this.finalTranscriptHistory.length > this.maxFinalTranscripts) {
      this.finalTranscriptHistory.shift()
    }
  }

  /**
   * Get the current maximum final transcripts setting.
   */
  getMaxFinalTranscripts(): number {
    return this.maxFinalTranscripts
  }

  /**
   * Get the display profile.
   */
  getProfile(): DisplayProfile {
    return this.profile
  }

  /**
   * Get the text measurer.
   */
  getMeasurer(): TextMeasurer {
    return this.measurer
  }

  /**
   * Get the text wrapper.
   */
  getWrapper(): TextWrapper {
    return this.wrapper
  }

  /**
   * Get the display helpers.
   */
  getHelpers(): DisplayHelpers {
    return this.helpers
  }

  /**
   * Get the maximum lines for the display.
   */
  getMaxLines(): number {
    return this.maxLines
  }

  /**
   * Get the display width in pixels.
   */
  getDisplayWidthPx(): number {
    return this.displayWidthPx
  }
}
