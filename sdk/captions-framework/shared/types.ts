/**
 * Shared types and constants across client/ and webview/.
 *
 * Plain TypeScript. No framework magic.
 */

/**
 * Approximate character width of the glasses HUD line.
 * Used to break captions into lines for both the glasses display
 * and the webview preview that mimics the HUD.
 */
export const CHARS_PER_LINE = 30

/**
 * Transcription chunk shape used by this example.
 *
 * The cloud SDK's `TranscriptionData` already carries `utteranceId` and
 * `speakerId`, but `@mentra/miniapp` currently exposes a simplified
 * subset. We declare what we need here and treat both fields as
 * optional so the example works whether the runtime delivers them or
 * not. If a runtime omits them, we fall back to synthetic IDs and
 * speaker prefixes get dropped.
 */
export interface TranscriptionEvent {
  text: string
  isFinal: boolean
  language?: string
  /** Same ID across interim and final chunks of one utterance. */
  utteranceId?: string
  /** From diarization. Empty / undefined means single-speaker or unknown. */
  speakerId?: string
}

/**
 * One utterance, finalized or in-flight.
 */
export interface UtteranceEntry {
  /** Stable ID for this utterance. Synthesized if missing from the runtime. */
  utteranceId: string
  /** Speaker ID from diarization. Empty string if unknown. */
  speakerId: string
  text: string
}

export interface AppState {
  /** Finalized utterances, oldest first. */
  history: UtteranceEntry[]
  /** Current in-flight utterance, if any. */
  interim: UtteranceEntry | null
  /** How many lines of captions to show on the HUD. 2 to 5. */
  displayLines: number
  /**
   * Pre-formatted lines, last `displayLines` entries, ready to render.
   * Same content goes to the glasses HUD and the webview preview.
   */
  preview: string[]
}
