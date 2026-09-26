/** Transcript history and speaker labels. Text fitting belongs to display.render(). */
export interface TranscriptHistoryEntry {
  text: string
  speakerId?: string
  hadSpeakerChange: boolean
}

export interface FormatResult {
  displayText: string
}

export class CaptionsFormatter {
  private finalTranscriptHistory: TranscriptHistoryEntry[] = []
  private partialSpeakerId: string | undefined
  private partialHadSpeakerChange = false
  constructor(private maxFinalTranscripts = 30) {}
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

    return {displayText}
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

    return {displayText}
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
}
