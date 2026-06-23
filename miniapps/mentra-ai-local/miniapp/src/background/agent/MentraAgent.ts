/**
 * Mentra Agent (client) — thin backend client.
 *
 * The agent tool-loop (Gemini + Jina) now runs server-side in the backend's
 * agent.service (Option A). This module just packages {query, photos, context}
 * and POSTs it to /api/agent with a package-scoped Bearer token via
 * session.auth.fetch, then returns the backend's {response, toolCalls}.
 *
 * The public surface (generateResponse / GenerateOptions / GenerateResult) is
 * unchanged except that a `session` is now required, so QueryProcessor barely
 * changes.
 */

import type {MiniappSession} from "@mentra/miniapp/background"

import {BACKEND_ROUTES} from "../lib/ai-config"
import type {LocationContext} from "../managers/LocationManager"
import type {ConversationTurn} from "../managers/ChatHistoryManager"

/** Agent generation options. Photos are data-URL strings, current-first. */
export interface GenerateOptions {
  session: MiniappSession
  query: string
  photos?: string[]
  context: {
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
  onToolCall?: (toolName: string) => void
}

export interface GenerateResult {
  response: string
  toolCalls: number
}

interface BackendAgentResponse {
  response?: string
  toolCalls?: number
  error?: string
}

/** Generate a response by calling the backend agent service. */
export async function generateResponse(options: GenerateOptions): Promise<GenerateResult> {
  const {session, query, photos, context} = options

  console.log(
    `🤖 Requesting response for: "${query.slice(0, 50)}${query.length > 50 ? "..." : ""}"`,
  )
  console.log(
    `   Photos: ${photos?.length || 0}, hasPhotos: ${context.hasPhotos}, History: ${context.conversationHistory.length}`,
  )

  const url = BACKEND_ROUTES.agent()
  console.log(`🌐 POST ${url}`)

  let res: Response
  try {
    res = await session.auth.fetch(url, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({query, photos, context}),
    })
  } catch (err) {
    // session.auth.fetch can throw before any response (token mint failed,
    // host offline, DNS/TLS to the backend URL). Surface it explicitly.
    const message = err instanceof Error ? err.message : String(err)
    console.error(`❌ agent fetch threw before response: ${message}`)
    throw new Error(`agent fetch failed: ${message}`)
  }

  if (!res.ok) {
    const raw = await res.text().catch(() => "")
    let parsed: BackendAgentResponse = {}
    try {
      parsed = JSON.parse(raw) as BackendAgentResponse
    } catch {
      /* non-JSON body */
    }
    // Log status only (the body can contain token text the host redacts).
    console.error(`❌ agent backend HTTP ${res.status} (auth=${res.status === 401 ? "rejected" : "ok"})`)
    throw new Error(`agent backend ${res.status}${parsed.error ? `: ${parsed.error}` : ""}`)
  }

  const body = (await res.json()) as BackendAgentResponse
  if (body.error) throw new Error(body.error)

  const toolCalls = body.toolCalls ?? 0
  // The server runs the tool-loop; we can't observe individual tool calls, so
  // surface a single "search" hint to the UI when any tool ran.
  if (toolCalls > 0) options.onToolCall?.("search")

  console.log(`✅ Response received (${(body.response ?? "").length} chars, ${toolCalls} tool calls)`)
  return {response: body.response ?? "", toolCalls}
}
