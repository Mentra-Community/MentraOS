import {ViewType} from "@mentra/sdk"
import {TranscriptProcessor} from "../utils"
import {UserSession} from "./UserSession"

export class DisplayManager {
  private processor: TranscriptProcessor
  private inactivityTimer: NodeJS.Timeout | null = null
  private readonly userSession: UserSession
  private readonly logger: UserSession["logger"]
  private lastSpeakerId: string | undefined = undefined // Track last speaker for change detection

  constructor(userSession: UserSession) {
    this.userSession = userSession
    this.logger = userSession.logger.child({service: "DisplayManager"})

    // Initialize with defaults (will be updated by SettingsManager)
    // Use full 576px width: 48 visual units (576px / 12px per avg char)
    // 5 lines max (hardware limit)
    // useCharacterBreaking: true for 100% line utilization
    this.processor = new TranscriptProcessor(48, 5, 30, true)
  }

  /**
   * Enable or disable character-level breaking (hyphenation)
   * @param enabled - If true, break mid-word for 100% line utilization; if false, prefer word boundaries
   */
  setCharacterBreaking(enabled: boolean): void {
    this.processor.setCharacterBreaking(enabled)
    this.logger.info(`Character breaking ${enabled ? "enabled" : "disabled"}`)
    // Refresh display with new setting
    this.refreshDisplay()
  }

  /**
   * Check if character-level breaking is enabled
   */
  isCharacterBreakingEnabled(): boolean {
    return this.processor.isCharacterBreakingEnabled()
  }

  /**
   * Update display settings
   * @param visualWidth - Maximum visual width per line (1 unit = 1 Latin char, CJK = 2 units)
   * @param numberOfLines - Maximum number of lines to display
   */
  updateSettings(visualWidth: number, numberOfLines: number): void {
    this.logger.info(`Updating processor settings: visualWidth=${visualWidth}, lines=${numberOfLines}`)

    // Get previous transcript history to preserve it
    const previousHistory = this.processor.getFinalTranscriptHistory()

    // Create new processor with updated settings
    this.processor = new TranscriptProcessor(visualWidth, numberOfLines, 30)

    // Restore transcript history (with speaker info preserved)
    for (const entry of previousHistory) {
      this.processor.processString(entry.text, true, entry.speakerId, entry.hadSpeakerChange)
    }

    this.logger.info(`Preserved ${previousHistory.length} transcripts after settings change`)

    // Immediately refresh the display with new settings
    this.refreshDisplay()
  }

  /**
   * Refresh the display with current transcript history using current settings
   * Called after settings change to show instant preview
   */
  private refreshDisplay(): void {
    const history = this.processor.getFinalTranscriptHistory()

    if (history.length === 0) {
      // No transcripts yet, send empty preview
      this.userSession.transcripts.broadcastDisplayPreview("", [""], true)
      return
    }

    // Get the current formatted display from processor
    const currentDisplay = this.processor.getCurrentDisplay()

    if (currentDisplay.trim()) {
      const cleaned = this.cleanTranscriptText(currentDisplay)
      const lines = cleaned.split("\n")

      this.logger.info(`Refreshing display with new settings: ${lines.length} lines`)

      // Send to glasses
      this.userSession.appSession.layouts.showTextWall(cleaned, {
        view: ViewType.MAIN,
        durationMs: 20000,
      })

      // Broadcast to webview preview
      this.userSession.transcripts.broadcastDisplayPreview(cleaned, lines, true)
    }
  }

  /**
   * Process transcription text and display on glasses
   * @param text - The transcription text
   * @param isFinal - Whether this is a final transcription
   * @param speakerId - Optional speaker ID from diarization
   */
  processAndDisplay(text: string, isFinal: boolean, speakerId?: string): void {
    // Detect speaker change
    const speakerChanged = speakerId !== undefined && speakerId !== this.lastSpeakerId

    if (speakerChanged) {
      this.logger.info(`Speaker changed: ${this.lastSpeakerId || "none"} -> ${speakerId}`)
      this.lastSpeakerId = speakerId
    }

    this.logger.info(
      `Processing transcript: "${text.substring(0, 50)}..." (final: ${isFinal}, speaker: ${
        speakerId || "unknown"
      }, changed: ${speakerChanged})`,
    )

    // Pass speaker info to processor
    const formatted = this.processor.processString(text, isFinal, speakerId, speakerChanged)
    this.logger.info(`Formatted for display: "${formatted.substring(0, 100)}..."`)
    this.showOnGlasses(formatted, isFinal)
    this.resetInactivityTimer()
  }

  private showOnGlasses(text: string, isFinal: boolean): void {
    const cleaned = this.cleanTranscriptText(text)
    const lines = cleaned.split("\n")

    this.logger.info(
      `Showing on glasses: "${cleaned.substring(0, 100)}..." (final: ${isFinal}, duration: ${
        isFinal ? "20s" : "indefinite"
      })`,
    )

    // Send to glasses
    this.userSession.appSession.layouts.showTextWall(cleaned, {
      view: ViewType.MAIN,
      durationMs: isFinal ? 20000 : undefined,
    })

    // Broadcast to webview preview
    this.userSession.transcripts.broadcastDisplayPreview(cleaned, lines, isFinal)
  }

  private cleanTranscriptText(text: string): string {
    // Remove leading punctuation marks (both Western and Chinese)
    // Western: . , ; : ! ?
    // Chinese: 。 ， ； ： ！ ？
    // But preserve speaker labels like [1]: at the start of lines
    return text
      .split("\n")
      .map((line) => {
        // Check if line starts with speaker label [N]:
        const speakerLabelMatch = line.match(/^\[\d+\]:\s*/)
        if (speakerLabelMatch) {
          // Preserve the label, clean the rest
          const label = speakerLabelMatch[0]
          const rest = line.substring(label.length)
          return label + rest.replace(/^[.,;:!?。，；：！？]+/, "").trim()
        }
        // No speaker label, clean normally
        return line.replace(/^[.,;:!?。，；：！？]+/, "").trim()
      })
      .join("\n")
  }

  private resetInactivityTimer(): void {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer)
    }

    // Clear transcript processor history after 40 seconds of inactivity
    this.inactivityTimer = setTimeout(() => {
      this.logger.info("Clearing transcript processor history due to inactivity")

      this.processor.clear()
      this.lastSpeakerId = undefined // Reset speaker tracking

      // Show empty state to clear the glasses display
      this.userSession.appSession.layouts.showTextWall("", {
        view: ViewType.MAIN,
        durationMs: 1000,
      })
    }, 40000)
  }

  dispose(): void {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer)
    }
  }
}
