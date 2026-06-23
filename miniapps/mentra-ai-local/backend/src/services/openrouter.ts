/**
 * OpenRouter chat-completions client — the OpenAI-compatible wire layer.
 *
 * Everything the assistant does (the agent tool-loop and the visual classifier)
 * goes through here. OpenRouter speaks the OpenAI chat-completions format, so
 * these types and the `callOpenRouter` helper are plain OpenAI shapes. Provider
 * differences (Gemini vs Claude vs GPT) are handled by OpenRouter behind the
 * single `model` slug — the caller never branches on provider.
 */

import {openRouterUrl, openRouterHeaders} from "./ai-config"

// ── OpenAI-format wire types (the subset we use) ────────────────────

/** A piece of message content: text or an image (vision). */
export type ContentPart =
  | {type: "text"; text: string}
  | {type: "image_url"; image_url: {url: string}}

/** A function/tool the model may call. JSON-schema parameters. */
export interface ToolDef {
  type: "function"
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

/** A tool call the model emitted. `arguments` is a JSON string. */
export interface ToolCall {
  id: string
  type: "function"
  function: {name: string; arguments: string}
}

/** A chat message. `content` is a string or multimodal parts; tool turns differ. */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool"
  content: string | ContentPart[] | null
  /** Present on assistant turns that requested tool calls. */
  tool_calls?: ToolCall[]
  /** Present on role:"tool" turns — links the result to the originating call. */
  tool_call_id?: string
}

interface ChatCompletionChoice {
  message: {
    role: "assistant"
    content: string | null
    tool_calls?: ToolCall[]
  }
  finish_reason?: string
}

interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[]
  error?: {message?: string}
}

export interface CallOptions {
  model: string
  messages: ChatMessage[]
  tools?: ToolDef[]
  temperature?: number
  maxTokens?: number
}

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "OpenRouterError"
  }
}

/** One chat-completions round-trip. Returns the first choice's assistant message. */
export async function callOpenRouter(
  opts: CallOptions,
): Promise<ChatCompletionChoice["message"]> {
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature ?? 0.7,
  }
  if (opts.tools && opts.tools.length > 0) {
    body.tools = opts.tools
    body.tool_choice = "auto"
  }
  if (opts.maxTokens !== undefined) body.max_tokens = opts.maxTokens

  const response = await fetch(openRouterUrl(), {
    method: "POST",
    headers: openRouterHeaders(),
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const raw = await response.text().catch(() => "")
    throw new OpenRouterError(
      `OpenRouter HTTP ${response.status}: ${raw.slice(0, 200)}`,
      response.status,
    )
  }

  const data = (await response.json()) as ChatCompletionResponse
  if (data.error) {
    throw new OpenRouterError(data.error.message ?? "OpenRouter error", 500)
  }
  const message = data.choices?.[0]?.message
  if (!message) {
    throw new OpenRouterError("OpenRouter returned no choices", 500)
  }
  return message
}
