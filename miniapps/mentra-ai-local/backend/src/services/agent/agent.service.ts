/**
 * Mentra Agent service — Gemini generateContent tool-loop, server-side.
 *
 * Ported from the miniapp's agent/MentraAgent.ts. This is the heart of Option A:
 * the entire multi-step tool-loop (Gemini + Jina) runs here, on the backend,
 * with the Gemini key never leaving the server. The client POSTs
 * {query, photos, context} once and gets back {response, toolCalls}.
 */

import {TOOL_DECLARATIONS, executeTool} from "./tools"
import {buildSystemPrompt, classifyResponseMode, MAX_STEPS, type AgentContext} from "./prompt"
import {type AgentRequest, type AgentResult} from "./types"
import {GEMINI_API_KEY, geminiUrl, hasLLMKey} from "../ai-config"

export class AgentServiceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 500 | 503,
  ) {
    super(message)
    this.name = "AgentServiceError"
  }
}

// ── Gemini wire types (minimal) ─────────────────────────────────────
interface GeminiPart {
  text?: string
  inlineData?: {mimeType: string; data: string}
  functionCall?: {name: string; args?: Record<string, unknown>}
  functionResponse?: {name: string; response: Record<string, unknown>}
}
interface GeminiContent {
  role: "user" | "model"
  parts: GeminiPart[]
}

/** Split a data URL into {mimeType, base64}. */
function parseDataUrl(dataUrl: string): {mimeType: string; data: string} | null {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl)
  if (!match) return null
  return {mimeType: match[1], data: match[2]}
}

/** Generate a response using Gemini, with a bounded tool-call loop. */
export async function generateResponse(request: AgentRequest): Promise<AgentResult> {
  const {query, photos, context} = request

  if (!query || !query.trim()) {
    throw new AgentServiceError("query is required", 400)
  }

  if (!hasLLMKey) {
    throw new AgentServiceError("GEMINI_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY is required", 503)
  }

  const responseMode = classifyResponseMode(query, context.hasDisplay)

  const agentContext: AgentContext = {
    ...context,
    hasMicrophone: true,
    responseMode,
  }

  const systemPrompt = buildSystemPrompt(agentContext)

  // Build the initial user turn: query text + labeled photos.
  const parts: GeminiPart[] = [{text: query}]
  if (photos && photos.length > 0) {
    photos.forEach((photo, i) => {
      parts.push({
        text:
          i === 0
            ? "[CURRENT photo — what the user is looking at right now. Answer about THIS image.]"
            : `[PREVIOUS photo ${i} — older context only. Ignore unless the user explicitly asks about something earlier.]`,
      })
      const parsed = parseDataUrl(photo)
      if (parsed) parts.push({inlineData: parsed})
    })
  }

  const contents: GeminiContent[] = [{role: "user", parts}]

  console.log(
    `🤖 Generating response for: "${query.slice(0, 50)}${query.length > 50 ? "..." : ""}"`,
  )
  console.log(
    `   Mode: ${responseMode}, Photos: ${photos?.length || 0}, hasPhotos: ${context.hasPhotos}, History: ${context.conversationHistory.length}`,
  )

  let toolCallCount = 0

  for (let step = 0; step < MAX_STEPS; step++) {
    const data = await callGemini(systemPrompt, contents)
    const candidate = data?.candidates?.[0]
    const responseParts: GeminiPart[] = candidate?.content?.parts ?? []

    const functionCalls = responseParts.filter((p) => p.functionCall)

    if (functionCalls.length === 0) {
      // No tool calls — this is the final answer.
      const text = responseParts
        .map((p) => p.text ?? "")
        .join("")
        .trim()
      console.log(`✅ Response generated (${text.length} chars, ${toolCallCount} tool calls)`)
      return {response: text, toolCalls: toolCallCount}
    }

    // Append the model's tool-call turn, then execute and append responses.
    contents.push({role: "model", parts: responseParts})

    const toolResultParts: GeminiPart[] = []
    for (const part of functionCalls) {
      const call = part.functionCall!
      toolCallCount++
      const result = await executeTool(call.name, call.args ?? {})
      toolResultParts.push({
        functionResponse: {name: call.name, response: result},
      })
    }
    contents.push({role: "user", parts: toolResultParts})
  }

  // Hit the step cap without a final text answer.
  console.warn("⚠️ Agent hit maxSteps without a final answer")
  return {
    response: "I wasn't able to finish that. Could you try rephrasing?",
    toolCalls: toolCallCount,
  }
}

async function callGemini(systemPrompt: string, contents: GeminiContent[]): Promise<any> {
  const response = await fetch(geminiUrl(), {
    method: "POST",
    headers: {
      "x-goog-api-key": GEMINI_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      system_instruction: {parts: [{text: systemPrompt}]},
      contents,
      tools: [{functionDeclarations: TOOL_DECLARATIONS}],
      generationConfig: {temperature: 0.7},
    }),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new AgentServiceError(`Gemini HTTP ${response.status}: ${body.slice(0, 200)}`, 500)
  }
  return response.json()
}
