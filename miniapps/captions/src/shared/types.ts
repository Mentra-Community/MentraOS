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

/** Caption settings — persisted in storage, mirrored to the UI. */
export interface CaptionSettings {
  language: string
  languageHints: string[]
  displayLines: number
  displayWidth: number
  wordBreaking: boolean
}

/** A single transcript entry shown in the UI's transcript list. */
export interface Transcript {
  id: string
  utteranceId: string | null
  speaker: string
  text: string
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

/** A single live-transcript broadcast: one interim/final result. */
export interface LiveTranscript {
  type: "interim" | "final"
  id: string
  utteranceId: string | null
  speaker: string
  text: string
  timestamp: number | null
}

/** Full state snapshot pushed to the UI on every WebView open. */
export interface CaptionsSnapshot {
  settings: CaptionSettings
  transcripts: Transcript[]
  displayPreview: DisplayPreview | null
  cloudStatus: CloudClientStatus
}
