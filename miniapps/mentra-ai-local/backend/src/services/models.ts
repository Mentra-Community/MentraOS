/**
 * AI model registry — the catalog of models the assistant can run, served via
 * OpenRouter (https://openrouter.ai).
 *
 * Each model declares whether it is vision-capable. Mentra Live photo analysis
 * only works on vision models; for text-only models the agent never sends the
 * photo and the system prompt tells the model it has no camera (so it declines
 * visual questions gracefully instead of erroring or hallucinating).
 *
 * NOTE on DeepSeek: DeepSeek's own models have native vision, but OpenRouter
 * does NOT expose image input for any DeepSeek slug (verified against the
 * /models API — every DeepSeek entry reports input_modalities: ["text"]). Since
 * this miniapp routes through OpenRouter, DeepSeek is text-only here.
 *
 * This is the single source of truth for valid model ids. The backend validates
 * the client's requested model against this list (falling back to the default),
 * and the miniapp settings UI renders a picker from the same data via the
 * `/api/agent` contract. Slugs use OpenRouter's `provider/model` namespacing.
 */

export interface ModelOption {
  /** OpenRouter slug, e.g. "google/gemini-3.1-flash-lite-preview". Sent as `model`. */
  id: string
  /** Human-readable name shown in the settings picker and the system prompt. */
  label: string
  /** Provider label shown in the system prompt ("Google" / "Anthropic" / etc.). */
  provider: string
  /** True if image input works through OpenRouter for this slug (controls photos). */
  visionCapable: boolean
}

/**
 * The selectable models. Gemini is first (the default) since it matches what
 * the assistant used before the OpenRouter migration. DeepSeek is the cheapest
 * but text-only via OpenRouter (see note above).
 */
export const MODEL_OPTIONS: readonly ModelOption[] = [
  {id: "google/gemini-3.1-flash-lite-preview", label: "Gemini 3.1 Flash Lite", provider: "Google", visionCapable: true},
  {id: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5", provider: "Anthropic", visionCapable: true},
  {id: "openai/gpt-5-mini", label: "GPT-5 Mini", provider: "OpenAI", visionCapable: true},
  {id: "x-ai/grok-4.3", label: "Grok 4.3", provider: "xAI", visionCapable: true},
  {id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash", provider: "DeepSeek", visionCapable: false},
] as const

/** Default model id when the client sends none or an unknown one. */
export const DEFAULT_MODEL_ID = MODEL_OPTIONS[0].id

/** Resolve a (possibly client-supplied) model id to a known option, or the default. */
export function resolveModel(id?: string | null): ModelOption {
  const found = id ? MODEL_OPTIONS.find((m) => m.id === id) : undefined
  return found ?? MODEL_OPTIONS.find((m) => m.id === DEFAULT_MODEL_ID)!
}
