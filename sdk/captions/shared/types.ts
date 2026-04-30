/**
 * Shared types and constants across client/ and webview/.
 */

/** displayWidth setting → width % of glasses HUD. Mirrors the production app. */
export const DISPLAY_WIDTH_PERCENT: Record<number, number> = {
  0: 0.7, // Narrow
  1: 0.85, // Medium
  2: 1.0, // Wide
}

/** G1 HUD pixel width baseline. Production uses this same value. */
export const HUD_WIDTH_PX = 488

/** Approx pixels per character at the HUD font size. Used for char-breaking. */
export const HUD_CHAR_PX = 14

/**
 * Transcription chunk shape used by this app. Optional utteranceId and
 * speakerId carried over from @mentra/miniapp's TranscriptionData;
 * fall back gracefully when missing.
 */
export interface TranscriptionEvent {
  text: string
  isFinal: boolean
  language?: string
  utteranceId?: string
  speakerId?: string
}

/** One transcript entry as the webview renders it. */
export interface Transcript {
  /** Unique ID per entry (utteranceId when available, otherwise synthesized). */
  id: string
  utteranceId: string | null
  /** "Speaker N" label for display. */
  speaker: string
  text: string
  /** Locale-formatted clock time, set when finalized. */
  timestamp: string | null
  isFinal: boolean
}

/** Settings persisted across app lifetime. */
export interface CaptionSettings {
  language: string
  languageHints: string[]
  displayLines: number
  displayWidth: number
}

/** What the glasses HUD is showing right now, mirrored to the webview preview. */
export interface DisplayPreview {
  text: string
  lines: string[]
  isFinal: boolean
  timestamp: number
}

export interface AppState {
  transcripts: Transcript[]
  settings: CaptionSettings
  displayPreview: DisplayPreview | null
}

export const DEFAULT_SETTINGS: CaptionSettings = {
  language: "auto",
  languageHints: [],
  displayLines: 3,
  displayWidth: 1,
}
