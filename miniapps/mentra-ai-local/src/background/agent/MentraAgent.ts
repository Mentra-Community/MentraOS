/**
 * Mentra Agent — direct Gemini REST implementation with a tool-call loop.
 *
 * PORT NOTE: the cloud app used Mastra (@mastra/core). Mastra imports Node
 * builtins (stream/web) that the browser-target JSContext bundle can't take,
 * so the local port talks to the Gemini generateContent REST API directly —
 * the same transport the visual-classifier already uses. The public surface
 * (generateResponse / GenerateOptions / GenerateResult) is unchanged, so
 * QueryProcessor doesn't care which engine is underneath.
 */

import {TOOL_DECLARATIONS, executeTool} from "./tools"
import {buildSystemPrompt, classifyResponseMode, type AgentContext} from "./prompt"
import {AGENT_SETTINGS} from "../constants/config"
import {GOOGLE_GENERATIVE_AI_API_KEY, LLM_MODEL} from "../lib/ai-config"
import type {LocationContext} from "../managers/LocationManager"
import type {ConversationTurn} from "../managers/ChatHistoryManager"

const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${LLM_MODEL}:generateContent?key=${GOOGLE_GENERATIVE_AI_API_KEY}`

/** Agent generation options. Photos are data-URL strings, current-first. */
export interface GenerateOptions {
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
export async function generateResponse(options: GenerateOptions): Promise<GenerateResult> {
  const {query, photos, context} = options

  const responseMode = classifyResponseMode(query, context.hasDisplay)

  const agentContext: AgentContext = {
    hasDisplay: context.hasDisplay,
    hasSpeakers: context.hasSpeakers,
    hasCamera: context.hasCamera,
    hasPhotos: context.hasPhotos,
    hasMicrophone: true,
    glassesType: context.glassesType,
    responseMode,
    location: context.location,
    localTime: context.localTime,
    timezone: context.timezone,
    notifications: context.notifications,
    conversationHistory: context.conversationHistory,
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

  if (!GOOGLE_GENERATIVE_AI_API_KEY) {
    return {
      response: "My AI service isn't configured right now. Please add a Gemini API key.",
      toolCalls: 0,
    }
  }

  let toolCallCount = 0

  try {
    for (let step = 0; step < AGENT_SETTINGS.maxSteps; step++) {
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
        options.onToolCall?.(call.name === "web_search" ? "search" : call.name)
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
  } catch (error) {
    console.error("❌ Agent generation error:", error)
    throw error
  }
}

async function callGemini(
  systemPrompt: string,
  contents: GeminiContent[],
): Promise<any> {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      system_instruction: {parts: [{text: systemPrompt}]},
      contents,
      tools: [{functionDeclarations: TOOL_DECLARATIONS}],
      generationConfig: {temperature: 0.7},
    }),
  })

  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw new Error(`Gemini HTTP ${response.status}: ${body.slice(0, 200)}`)
  }
  return response.json()
}

export {classifyResponseMode} from "./prompt"
export {ResponseMode} from "../constants/config"
