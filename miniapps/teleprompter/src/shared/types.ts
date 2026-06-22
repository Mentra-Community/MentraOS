/**
 * Shared domain types referenced by BOTH the background JSContext and the UI
 * WebView. Both bundlers inline this file at build time, so there's no runtime
 * resolution across the boundary.
 *
 * Rule: anything that crosses the `mentra.send` / `session.ui.send` channel
 * boundary needs its payload shape declared here so each side sees the same
 * TypeScript type.
 */

/** Line width on the glasses: 0 = Narrow, 1 = Medium, 2 = Wide. */
export type LineWidth = 0 | 1 | 2

/** Teleprompter settings — persisted in storage, mirrored to the UI. */
export interface TeleprompterSettings {
  /** The script the user reads from. */
  script: string
  /** Timed-scroll speed in words per minute (used when voice-follow is off). */
  wpm: number
  /** How many lines of the script to show on the glasses at once (2–5). */
  numberOfLines: number
  /** Glasses line width (Narrow / Medium / Wide). */
  lineWidth: LineWidth
  /** When true, scrolling follows the speaker's voice instead of a timer. */
  voiceFollow: boolean
  /** When true, restart from the top automatically after reaching the end. */
  autoRestart: boolean
  /** When true, append a time/progress footer line to the glasses display. */
  showTimecode: boolean
}

/** Playback lifecycle state. */
export type PlaybackState = "idle" | "playing" | "paused" | "finished"

/**
 * Live playback status broadcast to the UI. Everything the WebView needs to
 * mirror what's on the glasses without owning any of the engine logic.
 */
export interface PlaybackStatus {
  state: PlaybackState
  /** True when voice-follow is the active scroll driver (voiceFollow && mic ok). */
  voiceMode: boolean
  /** Index of the next word expected to be read (0-based into the word list). */
  wordIndex: number
  /** Total readable words in the script. */
  totalWords: number
  /** Index of the top visible line on the glasses. */
  topLine: number
  /** Total wrapped display lines for the current script + layout. */
  totalLines: number
  /** The exact lines currently rendered on the glasses (already padded). */
  visibleLines: string[]
  /** Read progress, 0–100. */
  progress: number
  /** Estimated total read time at the current WPM, in seconds. */
  estimatedTotalSec: number
  /** Estimated time remaining from the current position, in seconds. */
  remainingSec: number
  /** True when the glasses can render (a display-capable device is connected). */
  hasDisplay: boolean
}

/** Full state snapshot pushed to the UI on every WebView open. */
export interface TeleprompterSnapshot {
  settings: TeleprompterSettings
  status: PlaybackStatus
}
