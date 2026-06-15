/**
 * AI configuration — the single swap-point for how AI calls are keyed.
 *
 * LOCAL/DEV (current): keys come from MENTRA_PUBLIC_* env, inlined into the
 * bundle by build.ts. They ship inside the JS bundle and are extractable.
 *
 * PRODUCTION (later): stand up a backend proxy that holds the real keys and
 * forwards to Gemini/Jina. Then change this file to point the model + tool
 * endpoints at the proxy and drop the inlined keys — no other file changes,
 * because every AI call routes through the values exported here.
 */

/** Gemini API key — used by the Mastra agent (via the google/ provider) and the visual classifier. */
export const GOOGLE_GENERATIVE_AI_API_KEY = process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? ""

/** Jina key — used by the web-search tool. */
export const JINA_API_KEY = process.env.JINA_API_KEY ?? ""

/** Model id (without provider prefix), e.g. "gemini-3.1-flash-lite-preview". */
export const LLM_MODEL = process.env.LLM_MODEL || "gemini-3.1-flash-lite-preview"

/** Human-readable provider label shown in the system prompt. */
export const LLM_PROVIDER = process.env.LLM_PROVIDER || "Google"

/** True if the Gemini key is present — agent/vision will degrade gracefully otherwise. */
export const hasLLMKey = GOOGLE_GENERATIVE_AI_API_KEY.length > 0
