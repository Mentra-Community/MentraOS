/**
 * Shared domain types — imported by BOTH the background and UI bundles.
 *
 * Data only (no functions, no SDK imports) so the bundler can inline this
 * file into each bundle independently with no runtime cross-bundle import.
 */

export type Theme = "light" | "dark"

/** A tappable action on a message (e.g. an OAuth "Connect" link from the agent). */
export interface AgentAction {
  type: "open_url"
  kind: "oauth_connect" | "link"
  url: string
}

// ── App control (Mentra AI as a system app) ──────────────────────

/** A declared action another miniapp exposes (mirrors the SDK's MiniappActionInfo). */
export interface AvailableAction {
  id: string
  description: string
  /** JSON-Schema input descriptor; undefined for no-param actions. */
  parameters?: Record<string, unknown>
}

/** A miniapp the agent can control, with its declared actions. Sent in context. */
export interface AvailableApp {
  packageName: string
  name: string
  running: boolean
  actions: AvailableAction[]
}

/**
 * An app-control action the BACKEND agent decided on and the BACKGROUND executes
 * after the response (via session.miniapps.* / session.actions.invoke). Deferred
 * + fire-and-forget, like the open_url AgentAction.
 */
export type DeviceAction =
  | {type: "start_app"; packageName: string}
  | {type: "stop_app"; packageName: string}
  | {type: "invoke_action"; packageName: string; actionId: string; params?: Record<string, unknown>}

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
  /** Action buttons (e.g. an OAuth connect link) on an assistant message. */
  actions?: AgentAction[]
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

/**
 * A selectable AI model. Mirrors the backend's model registry
 * (backend/src/services/models.ts). `id` is the OpenRouter slug sent with each
 * agent request. `visionCapable` is false for text-only models (e.g. DeepSeek
 * via OpenRouter) — those can't do Mentra Live photo analysis.
 */
export interface ModelOption {
  id: string
  label: string
  provider: string
  visionCapable: boolean
}

/** The models the user can pick in settings. Keep in sync with the backend. */
export const MODEL_OPTIONS: readonly ModelOption[] = [
  {id: "google/gemini-3.1-flash-lite-preview", label: "Gemini 3.1 Flash Lite", provider: "Google", visionCapable: true},
  {id: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5", provider: "Anthropic", visionCapable: true},
  {id: "openai/gpt-5-mini", label: "GPT-5 Mini", provider: "OpenAI", visionCapable: true},
  {id: "x-ai/grok-4.3", label: "Grok 4.3", provider: "xAI", visionCapable: true},
  {id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash", provider: "DeepSeek", visionCapable: false},
] as const

/** Default model id — the Gemini option (closest to the pre-OpenRouter behavior). */
export const DEFAULT_MODEL_ID = MODEL_OPTIONS[0].id

/** User-configurable settings, persisted in session.storage as JSON. */
export interface Settings {
  theme: Theme
  /** When true, prior turns are fed back to the agent as conversation context. */
  chatHistoryEnabled: boolean
  /** OpenRouter model slug for the agent (one of MODEL_OPTIONS ids). */
  model: string
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "dark",
  chatHistoryEnabled: false,
  model: DEFAULT_MODEL_ID,
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
