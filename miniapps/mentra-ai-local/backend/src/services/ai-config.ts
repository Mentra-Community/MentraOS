/**
 * Backend AI configuration — the single place the server reads its AI secrets.
 *
 * These values are SERVER-SIDE ONLY. They are read from the backend's
 * environment (never prefixed MENTRA_PUBLIC_, never inlined into the miniapp
 * bundle). This is the production-correct home for the keys that the miniapp
 * used to ship inside its JS bundle.
 */

/** Gemini API key — used by the agent tool-loop and the visual classifier. */
export const GEMINI_API_KEY =
  process.env.GEMINI_API_KEY ??
  process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
  process.env.GOOGLE_API_KEY ??
  ""

/** Jina key — used by the web-search tool. */
export const JINA_API_KEY = process.env.JINA_API_KEY ?? ""

/** Model id (without provider prefix), e.g. "gemini-3.1-flash-lite-preview". */
export const LLM_MODEL = process.env.LLM_MODEL || "gemini-3.1-flash-lite-preview"

/** Human-readable provider label shown in the system prompt. */
export const LLM_PROVIDER = process.env.LLM_PROVIDER || "Google"

/** True if the Gemini key is present — agent/classify degrade gracefully otherwise. */
export const hasLLMKey = GEMINI_API_KEY.length > 0

/** True if the Jina key is present — web search degrades gracefully otherwise. */
export const hasSearchKey = JINA_API_KEY.length > 0

/** Gemini generateContent endpoint for a given model. Key is sent as a header. */
export function geminiUrl(model: string = LLM_MODEL): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`
}
