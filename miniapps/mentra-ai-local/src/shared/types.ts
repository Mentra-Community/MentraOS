/**
 * Shared domain types — imported by BOTH the background and UI bundles.
 *
 * Data only (no functions, no SDK imports) so the bundler can inline this
 * file into each bundle independently with no runtime cross-bundle import.
 */

export type Theme = "light" | "dark"

/** A single chat message rendered in the webview. */
export interface ChatMessage {
  id: string
  /** "user" for the wearer, "mentra-ai" for the assistant. */
  senderId: string
  content: string
  /** ISO 8601. */
  timestamp: string
  /** Optional data: URL of the photo captured for this turn (user messages). */
  image?: string
}

/**
 * Chat events streamed from background → UI. Mirrors the cloud app's SSE
 * `broadcastChatEvent` payloads 1:1 so the ported ChatInterface logic is
 * unchanged — only the transport (SDK channel vs EventSource) differs.
 */
export type ChatEvent =
  | ({type: "message"} & ChatMessage)
  | {type: "processing"}
  | {type: "idle"}
  | {type: "wake_word"}
  | {type: "history"; messages: ChatMessage[]}
  | {type: "status"; status: string}

/** User-configurable settings, persisted in session.storage as JSON. */
export interface Settings {
  theme: Theme
  /** When true, prior turns are fed back to the agent as conversation context. */
  chatHistoryEnabled: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  chatHistoryEnabled: false,
}

// ── Debug overlay ────────────────────────────────────────────────

/** A raw transcription event surfaced in the debug overlay's feed. */
export interface DebugTranscript {
  text: string
  isFinal: boolean
}

/** Result of the debug "Run TTS test" action, reported back to the overlay log. */
export interface DebugSpeakResult {
  /** True if the speak request was accepted (a speaker is present). */
  accepted: boolean
  /** True iff playback completed (false = interrupted, null = not reported). */
  completed: boolean | null
  /** Snapshot of the connected glasses' capabilities at test time. */
  capabilities: {
    modelName?: string
    hasSpeaker: boolean
    hasDisplay: boolean
    hasCamera: boolean
  }
  /** Populated when the request couldn't be made (e.g. no speaker). */
  error?: string
}
