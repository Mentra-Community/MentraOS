/**
 * Shared domain types referenced by BOTH the background JSContext and the UI
 * WebView. Both bundlers inline this file at build time, so there's no runtime
 * resolution across the boundary.
 *
 * Rule: anything that crosses the `mentra.send` / `session.ui.send` channel
 * boundary needs its payload shape declared here so each side sees the same
 * TypeScript type.
 *
 * These shapes mirror the cloud app's SSE message payloads (TranscriptsManager
 * broadcast / display preview / settings update) so the ported UI components
 * can stay byte-identical.
 */

/** What the glasses display shows for each result. */
export type GlassesDisplayMode = "translation" | "both"

/** Translation settings — persisted in storage, mirrored to the UI. */
export interface TranslationSettings {
  targetLanguage: string
  displayLines: number
  displayWidth: number
  wordBreaking: boolean
  /** Phone UI: show the source-language (original) text in each card. */
  showOriginalText: boolean
  /** Glasses: render translation only, or original + translation combined. */
  glassesDisplayMode: GlassesDisplayMode
}

/** A single translation entry shown in the UI's translation list. */
export interface TranslationEntry {
  id: string
  utteranceId: string | null
  speaker: string
  text: string
  originalText?: string
  sourceLanguage?: string
  targetLanguage: string
  timestamp: number | null // Unix epoch ms — formatted client-side in user's timezone
  isFinal: boolean
}

/** The glasses display preview (what's currently rendered on the lenses). */
export interface DisplayPreview {
  text: string
  lines: string[]
  isFinal: boolean
  timestamp: number
}

export type CloudClientConnectionStatus = "connected" | "connecting" | "reconnecting" | "disconnected"
export type CloudClientAudioTransport = "udp" | "ws" | "offline" | "none"

/** Phone-owned cloud-client status surfaced through session.cloud. */
export interface CloudClientStatus {
  status: CloudClientConnectionStatus
  audioTransport: CloudClientAudioTransport
}

/** A single live-translation broadcast: one interim/final result. */
export interface LiveTranslation {
  type: "interim" | "final"
  id: string
  utteranceId: string | null
  speaker: string
  text: string
  originalText?: string
  sourceLanguage?: string
  targetLanguage: string
  timestamp: number | null
}

/** Full state snapshot pushed to the UI on every WebView open. */
export interface TranslationsSnapshot {
  settings: TranslationSettings
  translations: TranslationEntry[]
  displayPreview: DisplayPreview | null
  cloudStatus: CloudClientStatus
}
