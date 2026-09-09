/**
 * Typed channel registry — the single source of truth for every name that
 * flows between this miniapp's background JSContext and its UI WebView. Both
 * halves import this file at build time; the bundler inlines the declarations
 * so there's no runtime cross-boundary I/O.
 *
 * This replaces the cloud app's SSE + REST transport seam:
 *   - SSE broadcast(type, payload)  ->  session.ui.send(channel, payload)
 *   - REST GET/POST settings        ->  mentra.send(set-* / clear)
 *
 * All channels here are broadcast (`mentra.send` / `session.ui.on`); the
 * captions UI never needs request/response RPC.
 */

import type {
  CaptionSettings,
  CaptionsDisplayCapabilities,
  CaptionsSnapshot,
  CloudClientStatus,
  DisplayPreview,
  LiveTranscript,
  Transcript,
} from "./types"

export interface Channels {
  // ── background → UI ────────────────────────────────────────────────────

  /** Full hydration snapshot, sent on every session.ui.onOpen. */
  "captions:snapshot": CaptionsSnapshot
  /** One interim/final transcript result (replaces the SSE transcript frame). */
  "captions:live-transcript": LiveTranscript
  /** Full transcript list replacement (e.g. after a clear). */
  "captions:transcripts-update": {transcripts: Transcript[]}
  /** Glasses display preview update (replaces SSE display_preview). */
  "captions:display-preview": DisplayPreview
  /** Settings update (replaces SSE settings_update). */
  "captions:settings-update": CaptionSettings
  /** Positioning support can change when the connected glasses change. */
  "captions:display-capabilities": CaptionsDisplayCapabilities
  /** Phone-owned cloud-client status update. */
  "captions:cloud-status": CloudClientStatus

  // ── UI → background ────────────────────────────────────────────────────

  "captions:set-language": {language: string}
  "captions:set-language-hints": {hints: string[]}
  "captions:set-use-offline-stt": {enabled: boolean}
  "captions:set-display-lines": {lines: number}
  "captions:set-display-width": {width: number}
  "captions:set-caption-position": {position: "top" | "bottom"}
  "captions:set-word-breaking": {enabled: boolean}
  "captions:set-caption-timeout": {seconds: number}
  "captions:clear": Record<string, never>
  /** Explicit hydration request after the WebView has registered listeners. */
  "captions:request-snapshot": Record<string, never>
}

declare global {
  // eslint-disable-next-line no-var
  var mentra: import("@mentra/miniapp/ui").MentraTyped<Channels>
}
