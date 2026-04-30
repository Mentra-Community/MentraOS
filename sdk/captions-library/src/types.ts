/**
 * Approximate character width of the glasses HUD line.
 */
export const CHARS_PER_LINE = 30

/**
 * Transcription chunk shape used by this example.
 *
 * The cloud SDK's `TranscriptionData` already carries `utteranceId` and
 * `speakerId`, but `@mentra/miniapp` currently exposes a simplified
 * subset. We declare what we need here and treat both fields as
 * optional so the example works whether the runtime delivers them or
 * not.
 */
export interface TranscriptionEvent {
  text: string
  isFinal: boolean
  language?: string
  utteranceId?: string
  speakerId?: string
}

export interface UtteranceEntry {
  utteranceId: string
  speakerId: string
  text: string
}
