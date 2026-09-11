/**
 * Typed channel registry — the single source of truth for every message that
 * flows between the Recorder's background JSContext and its UI WebView. Both
 * halves import this file; the bundler inlines it so there's no runtime
 * cross-boundary resolution.
 */

import type {MentraTyped} from "@mentra/miniapp/ui"

import type {RecorderSnapshot, RecorderStatus, RecordingItem, Usage} from "./types"

export interface Channels {
  // ── background → UI ────────────────────────────────────────────────────
  /** Full hydration snapshot, sent on every WebView open. */
  "rec:snapshot": RecorderSnapshot
  /** Live capture status (while recording). */
  "rec:status": RecorderStatus
  /** Stop was accepted and the capture is being finalized. */
  "rec:stopping": Record<string, never>
  /** Recording ended — clears the live status. */
  "rec:stopped": Record<string, never>
  /** Updated recordings list + usage (after save/delete/clear). */
  "rec:list": {recordings: RecordingItem[]; usage: Usage}
  /** Which recording (if any) is currently playing back. */
  "rec:playback": {playingId: string | null}
  /** A recording's stored audio couldn't be read back (e.g. legacy/corrupt blob). */
  "rec:audio-missing": {id: string}
  /** The OS rejected a recording share for a reason other than cancellation. */
  "rec:share-failed": {id: string}
  /** Live transcript (Soniox) during a capture: committed text + in-progress tail. */
  "rec:transcript": {final: string; interim: string; lang?: string}

  // ── UI → background ────────────────────────────────────────────────────
  "rec:start": Record<string, never>
  "rec:stop": Record<string, never>
  "rec:cancel": Record<string, never>
  "rec:pause": Record<string, never>
  "rec:resume": Record<string, never>
  "rec:play": {id: string}
  "rec:stop-play": Record<string, never>
  "rec:export": {id: string}
  "rec:export-transcript": {id: string}
  "rec:delete": {id: string}
  "rec:clear": Record<string, never>
  "rec:request-snapshot": Record<string, never>
}

declare global {
  // eslint-disable-next-line no-var
  var mentra: MentraTyped<Channels>
}
