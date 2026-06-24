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
  /**
   * Other miniapps the agent can control (Mentra AI is a system app). Gathered
   * by the background via session.miniapps.list(); enables the app-control tools.
   */
  apps?: AvailableApp[]
}

/** A declared action another miniapp exposes (mirrors the SDK's MiniappActionInfo). */
export interface AvailableAction {
  id: string
  description: string
  parameters?: Record<string, unknown>
}

/** A miniapp the agent can control, with its declared actions. */
export interface AvailableApp {
  packageName: string
  name: string
  running: boolean
  actions: AvailableAction[]
}

/**
 * An app-control action the agent decided on; the background executes it after
 * the response (deferred + fire-and-forget, like the open_url AgentAction).
 */
export type DeviceAction =
  | {type: "start_app"; packageName: string}
  | {type: "stop_app"; packageName: string}
  | {type: "invoke_action"; packageName: string; actionId: string; params?: Record<string, unknown>}

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

/** A structured action extracted from a delegation (a URL the user opens). */
export interface AgentAction {
  type: "open_url"
  kind: "oauth_connect" | "link"
  url: string
}

/** POST /api/agent response body — same shape as the old client GenerateResult. */
export interface AgentResult {
  response: string
  toolCalls: number
  /**
   * Set when the agent delegated to the giga-agent and it ran past the grace
   * window: `response` is then a spoken ack, and the caller polls
   * /api/agent/task/:pendingTaskId for the real answer.
   */
  pendingTaskId?: string
  /** Action buttons (e.g. an OAuth connect link) from a fast delegation. */
  actions?: AgentAction[]
  /**
   * App-control actions (start/stop/invoke another miniapp) the agent decided
   * on. The background executes them after the response.
   */
  deviceActions?: DeviceAction[]
}
