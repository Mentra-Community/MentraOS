/**
 * Shared agent types — the contract between the miniapp client and the backend
 * agent service. The miniapp builds AgentRequest from its managers (location,
 * notifications, chat history, capabilities) and POSTs it to /api/agent; the
 * backend returns AgentResult ({response, toolCalls}) — the same shape the
 * miniapp's old in-process generateResponse() returned, so QueryProcessor is
 * unchanged.
 */

/** Response mode determines the length and depth of responses. */
export enum ResponseMode {
  QUICK = "quick",
  STANDARD = "standard",
  DETAILED = "detailed",
}

/** Weather snapshot attached to a location. */
export interface WeatherContext {
  temperature: number
  temperatureCelsius: number
  condition: string
}

/** Resolved location context (geocoded + optional weather). */
export interface LocationContext {
  streetAddress?: string
  neighborhood?: string
  city: string
  state: string
  country: string
  weather?: WeatherContext
}

/** One prior turn of conversation. */
export interface ConversationTurn {
  query: string
  response: string
  hadPhoto: boolean
}

/** Device + environment context for a single query. */
export interface AgentRequestContext {
  hasDisplay: boolean
  hasSpeakers: boolean
  hasCamera: boolean
  hasPhotos: boolean
  glassesType: "display" | "camera"
  location: LocationContext | null
  localTime: string
  timezone?: string
  notifications: string
  conversationHistory: ConversationTurn[]
}

/** POST /api/agent request body. Photos are data-URL strings, current-first. */
export interface AgentRequest {
  query: string
  photos?: string[]
  context: AgentRequestContext
  /**
   * OpenRouter model slug the user selected (e.g. "anthropic/claude-haiku-4.5").
   * Validated server-side against the model registry; falls back to the default
   * when omitted or unknown. See backend `services/models.ts`.
   */
  model?: string
}

/** POST /api/agent response body — same shape as the old client GenerateResult. */
export interface AgentResult {
  response: string
  toolCalls: number
}
