/**
 * Typed channel registry — the single source of truth for every name that
 * flows between this miniapp's background JSContext and its UI WebView. Both
 * halves import this file at build time; the bundler inlines the declarations
 * so there's no runtime cross-boundary I/O.
 *
 * All channels here are broadcast (`mentra.send` / `session.ui.on` /
 * `session.ui.send`); the teleprompter UI never needs request/response RPC.
 */

import type {LineWidth, PlaybackStatus, TeleprompterSettings, TeleprompterSnapshot} from "./types"

export interface Channels {
  // ── background → UI ────────────────────────────────────────────────────

  /** Full hydration snapshot, sent on every session.ui.onOpen. */
  "tp:snapshot": TeleprompterSnapshot
  /** Live playback status (state, position, visible lines, progress). */
  "tp:status": PlaybackStatus
  /** Settings update echo (after a persisted change). */
  "tp:settings-update": TeleprompterSettings

  // ── UI → background ────────────────────────────────────────────────────

  /** Replace the script text. Resets playback to the top. */
  "tp:set-script": {script: string}
  "tp:set-wpm": {wpm: number}
  "tp:set-lines": {lines: number}
  "tp:set-width": {width: LineWidth}
  "tp:set-voice-follow": {enabled: boolean}
  "tp:set-auto-restart": {enabled: boolean}
  "tp:set-show-timecode": {enabled: boolean}

  /** Transport controls. */
  "tp:play": Record<string, never>
  "tp:pause": Record<string, never>
  "tp:restart": Record<string, never>
  /** Seek to a fraction of the script (0–100). */
  "tp:seek": {percent: number}
  /** Manual line nudge (+1 / -1 …) without changing play state. */
  "tp:nudge": {lines: number}

  /** Explicit hydration request after the WebView has registered listeners. */
  "tp:request-snapshot": Record<string, never>
}

declare global {
  // eslint-disable-next-line no-var
  var mentra: import("@mentra/miniapp/ui").MentraTyped<Channels>
}
