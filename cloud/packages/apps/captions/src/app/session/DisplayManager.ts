import {ViewType} from "@mentra/sdk"

import {CaptionsFormatter, G1_PROFILE_LEGACY, G1_PROFILE, type TranscriptHistoryEntry} from "../utils/CaptionsFormatter"
import {UserSession} from "./UserSession"

export class DisplayManager {
  private formatter: CaptionsFormatter
  private inactivityTimer: NodeJS.Timeout | null = null
  private readonly userSession: UserSession
  private readonly logger: UserSession["logger"]
  private lastSpeakerId: string | undefined = undefined // Track last speaker for change detection

  // Current display settings
  private currentDisplayWidthPx: number = G1_PROFILE_LEGACY.displayWidthPx
  private currentMaxLines: number = G1_PROFILE_LEGACY.maxLines

  constructor(userSession: UserSession) {
    this.userSession = userSession
    this.logger = userSession.logger.child({service: "DisplayManager"})

    // Initialize with defaults (will be updated by SettingsManager)
    // Using character breaking mode for 100% line utilization
    this.formatter = new CaptionsFormatter(G1_PROFILE_LEGACY, {
      maxFinalTranscripts: 30,
      useCharacterBreaking: true,
      displayWidthPx: this.currentDisplayWidthPx,
      maxLines: this.currentMaxLines,
    })
  }

  /**
   * Update display settings
   *
   * @param displayWidth - Display width setting: 0=Narrow (50%), 1=Medium (75%), 2=Wide (100%)
   * @param numberOfLines - Maximum number of lines to display (2-5)
   */
  updateSettings(displayWidth: number, numberOfLines: number): void {
    // Convert width setting to pixels as percentage of max display width
    // 0 = Narrow (50%), 1 = Medium (75%), 2 = Wide (100%)
    const maxWidthPx = G1_PROFILE_LEGACY.displayWidthPx
    let widthPercent: number
    switch (displayWidth) {
      case 0: // Narrow
        widthPercent = 0.7
        break
      case 1: // Medium
        widthPercent = 0.85
        break
      case 2: // Wide
      default:
        widthPercent = 1.0
        break
    }
    this.currentDisplayWidthPx = Math.round(maxWidthPx * widthPercent)
    this.currentMaxLines = Math.min(Math.max(2, numberOfLines), 5) // Clamp between 2-5

    this.logger.info(
      `Settings update: displayWidth=${displayWidth} (${widthPercent * 100}% = ${
        this.currentDisplayWidthPx
      }px), lines=${this.currentMaxLines}`,
    )

    // Get previous transcript history to preserve it
    const previousHistory = this.formatter.getFinalTranscriptHistory()

    // Create new formatter with updated settings
    this.formatter = new CaptionsFormatter(G1_PROFILE_LEGACY, {
      maxFinalTranscripts: 30,
      useCharacterBreaking: true,
      displayWidthPx: this.currentDisplayWidthPx,
      maxLines: this.currentMaxLines,
    })

    // Restore transcript history (with speaker info preserved)
    for (const entry of previousHistory) {
      this.formatter.processTranscription(entry.text, true, entry.speakerId, entry.hadSpeakerChange)
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
    const history = this.formatter.getFinalTranscriptHistory()

    if (history.length === 0) {
      // No transcripts yet, send empty preview
      this.userSession.transcripts.broadcastDisplayPreview("", [""], true)
      return
    }

    // Process empty string to get current display state from history
    const result = this.formatter.processTranscription("", true, undefined, false)

    if (result.displayText.trim()) {
      const cleaned = this.cleanTranscriptText(result.displayText)
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

    // Process using the new formatter
    const result = this.formatter.processTranscription(text, isFinal, speakerId, speakerChanged)

    this.logger.info(`Formatted for display: "${result.displayText.substring(0, 100)}..."`)
    this.showOnGlasses(result.displayText, isFinal)
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
      this.logger.info("Clearing transcript formatter history due to inactivity")

      this.formatter.clear()
      this.lastSpeakerId = undefined // Reset speaker tracking

      // Show empty state to clear the glasses display
      this.userSession.appSession.layouts.showTextWall("", {
        view: ViewType.MAIN,
        durationMs: 1000,
      })
    }, 40000)
  }

  /**
   * Get the transcript history (for preserving across settings changes)
   */
  getFinalTranscriptHistory(): TranscriptHistoryEntry[] {
    return this.formatter.getFinalTranscriptHistory()
  }

  dispose(): void {
    if (this.inactivityTimer) {
      clearTimeout(this.inactivityTimer)
    }
  }
}
