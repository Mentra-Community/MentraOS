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
 * translation UI never needs request/response RPC.
 */

import type {
  TranslationSettings,
  TranslationsSnapshot,
  CloudClientStatus,
  DisplayPreview,
  LiveTranslation,
  TranslationEntry,
} from "./types"

export interface Channels {
  // ── background → UI ────────────────────────────────────────────────────

  /** Full hydration snapshot, sent on every session.ui.onOpen. */
  "translation:snapshot": TranslationsSnapshot
  /** One interim/final translation result. */
  "translation:live-translation": LiveTranslation
  /** Full translation list replacement (e.g. after a clear). */
  "translation:translations-update": {translations: TranslationEntry[]}
  /** Glasses display preview update (replaces SSE display_preview). */
  "translation:display-preview": DisplayPreview
  /** Settings update (replaces SSE settings_update). */
  "translation:settings-update": TranslationSettings
  /** Phone-owned cloud-client status update. */
  "translation:cloud-status": CloudClientStatus

  // ── UI → background ────────────────────────────────────────────────────

  "translation:set-target-language": {targetLanguage: string}
  "translation:set-display-lines": {lines: number}
  "translation:set-display-width": {width: number}
  "translation:set-word-breaking": {enabled: boolean}
  "translation:set-show-original-text": {enabled: boolean}
  "translation:set-glasses-display-mode": {mode: import("./types").GlassesDisplayMode}
  "translation:clear": Record<string, never>
  /** Explicit hydration request after the WebView has registered listeners. */
  "translation:request-snapshot": Record<string, never>
}

declare global {
  // eslint-disable-next-line no-var
  var mentra: import("@mentra/miniapp/ui").MentraTyped<Channels>
}
