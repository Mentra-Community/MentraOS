/**
 * Mentra Agent service — OpenRouter chat-completions tool-loop, server-side.
 *
 * The entire multi-step tool-loop runs here, on the backend, with the
 * OpenRouter key never leaving the server. The client POSTs
 * {query, photos, context, model} once and gets back {response, toolCalls}.
 *
 * Every model — Gemini, Claude, or GPT — runs through the same OpenAI-format
 * path via OpenRouter; the chosen model is just a slug. The client's `model` is
 * validated against the registry (models.ts), falling back to the default.
 */

import {buildOpenAITools, executeTool, type DelegationHolder, type ToolExecContext} from "./tools"
import {isDelegationEnabled} from "./delegation"
import {buildSystemPrompt, classifyResponseMode, MAX_STEPS, type AgentContext} from "./prompt"
import {type AgentRequest, type AgentResult} from "./types"
import {hasLLMKey, DEFAULT_LLM_MODEL} from "../ai-config"
import {resolveModel} from "../models"
import {
  callOpenRouter,
  OpenRouterError,
  type ChatMessage,
  type ContentPart,
} from "../openrouter"

export class AgentServiceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 500 | 503,
  ) {
    super(message)
    this.name = "AgentServiceError"
  }
}

/**
 * Generate a response using OpenRouter, with a bounded tool-call loop.
 * `userId` (the caller's mentraUserId) enables the ask_agent delegation tool.
 */
export async function generateResponse(request: AgentRequest, userId?: string): Promise<AgentResult> {
  const {query, photos, context} = request

  if (!query || !query.trim()) {
    throw new AgentServiceError("query is required", 400)
  }

  if (!hasLLMKey) {
    throw new AgentServiceError("OPENROUTER_API_KEY is required", 503)
  }

  const model = resolveModel(request.model ?? DEFAULT_LLM_MODEL)
  const responseMode = classifyResponseMode(query, context.hasDisplay)

  // Only vision-capable models receive the photo. For text-only models (e.g.
  // DeepSeek via OpenRouter), we drop the photo AND tell the prompt the camera
  // is unavailable, so the model declines visual questions gracefully rather
  // than erroring on an unsupported image part or hallucinating about a photo
  // it never received. The glasses may still HAVE a camera — this reflects the
  // model's inability to use it, not the hardware.
  const usePhotos = model.visionCapable
  const hasUsablePhotos = usePhotos && context.hasPhotos

  // Delegation is offered only when configured AND we know who the user is.
  const delegationEnabled = isDelegationEnabled() && Boolean(userId)

  const agentContext: AgentContext = {
    ...context,
    hasCamera: usePhotos && context.hasCamera,
    hasPhotos: hasUsablePhotos,
    hasMicrophone: true,
    responseMode,
    modelLabel: model.label,
    modelProvider: model.provider,
    agentEnabled: delegationEnabled,
  }

  const systemPrompt = buildSystemPrompt(agentContext)
  const tools = buildOpenAITools(delegationEnabled)

  // Out-of-band channel for the delegation outcome (the tool's return goes to
  // the model; we also need the actions + any pending taskId here).
  const delegation: DelegationHolder = {}
  const toolCtx: ToolExecContext = {userId, delegation}

  // Build the initial user turn: query text + labeled photos as image_url parts.
  const userContent: ContentPart[] = [{type: "text", text: query}]
  if (usePhotos && photos && photos.length > 0) {
    photos.forEach((photo, i) => {
      userContent.push({
        type: "text",
        text:
          i === 0
            ? "[CURRENT photo — what the user is looking at right now. Answer about THIS image.]"
            : `[PREVIOUS photo ${i} — older context only. Ignore unless the user explicitly asks about something earlier.]`,
      })
      // OpenRouter accepts base64 data URLs directly as the image_url.
      userContent.push({type: "image_url", image_url: {url: photo}})
    })
  }

  const messages: ChatMessage[] = [
    {role: "system", content: systemPrompt},
    {role: "user", content: userContent},
  ]

  console.log(
    `🤖 Generating response for: "${query.slice(0, 50)}${query.length > 50 ? "..." : ""}"`,
  )
  console.log(
    `   Model: ${model.id}, Mode: ${responseMode}, Photos: ${photos?.length || 0}, hasPhotos: ${context.hasPhotos}, History: ${context.conversationHistory.length}`,
  )

  let toolCallCount = 0

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const assistant = await callOpenRouter({
        model: model.id,
        messages,
        tools,
      })

      const toolCalls = assistant.tool_calls ?? []

      if (toolCalls.length === 0) {
        // No tool calls — this is the final answer (or a delegation ack).
        const text = (assistant.content ?? "").trim()
        console.log(`✅ Response generated (${text.length} chars, ${toolCallCount} tool calls)`)
        return finalize(text, toolCallCount, delegation)
      }

      // Append the model's tool-call turn, then execute and append each result.
      messages.push({
        role: "assistant",
        content: assistant.content ?? null,
        tool_calls: toolCalls,
      })

      for (const call of toolCalls) {
        toolCallCount++
        const args = parseToolArgs(call.function.arguments)
        const result = await executeTool(call.function.name, args, toolCtx)
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result),
        })
      }
    }
  } catch (error) {
    if (error instanceof OpenRouterError) {
      throw new AgentServiceError(error.message, error.status === 401 ? 503 : 500)
    }
    throw error
  }

  // Hit the step cap without a final text answer.
  console.warn("⚠️ Agent hit maxSteps without a final answer")
  return finalize("I wasn't able to finish that. Could you try rephrasing?", toolCallCount, delegation)
}

/** Assemble the AgentResult, attaching any delegation outcome (actions / pending). */
function finalize(response: string, toolCalls: number, delegation: DelegationHolder): AgentResult {
  return {
    response,
    toolCalls,
    ...(delegation.pendingTaskId ? {pendingTaskId: delegation.pendingTaskId} : {}),
    ...(delegation.actions?.length ? {actions: delegation.actions} : {}),
  }
}

/** Parse a tool call's `arguments` JSON string; tolerate malformed/empty payloads. */
function parseToolArgs(raw: string): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
