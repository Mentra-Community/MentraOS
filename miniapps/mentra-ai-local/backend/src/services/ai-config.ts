/**
 * Backend AI configuration — the single place the server reads its AI secrets.
 *
 * These values are SERVER-SIDE ONLY. They are read from the backend's
 * environment (never prefixed MENTRA_PUBLIC_, never inlined into the miniapp
 * bundle). This is the production-correct home for the keys that the miniapp
 * used to ship inside its JS bundle.
 *
 * The assistant now runs every model through OpenRouter (OpenAI-compatible
 * chat completions). One key, one code path; the specific model — Gemini,
 * Claude, or GPT — is chosen per request from the registry in `models.ts`.
 */

import {DEFAULT_MODEL_ID} from "./models"

/** OpenRouter API key — used by the agent tool-loop and the visual classifier. */
export const OPENROUTER_API_KEY =
  process.env.OPENROUTER_API_KEY ?? process.env.OPEN_ROUTER_API_KEY ?? ""

/** OpenRouter chat-completions base URL (override only for testing/proxies). */
export const OPENROUTER_BASE_URL =
  process.env.OPENROUTER_BASE_URL?.replace(/\/+$/, "") ?? "https://openrouter.ai/api/v1"

/** Optional ranking headers OpenRouter shows on its dashboards (both optional). */
export const OPENROUTER_SITE_URL = process.env.OPENROUTER_SITE_URL ?? ""
export const OPENROUTER_APP_TITLE = process.env.OPENROUTER_APP_TITLE ?? "Mentra AI"

/** Jina key — used by the web-search tool. */
export const JINA_API_KEY = process.env.JINA_API_KEY ?? ""

/**
 * Default model id (OpenRouter slug). The client normally sends an explicit
 * model from settings; this is the fallback when it doesn't. Env override lets
 * an operator change the default without a code change.
 */
export const DEFAULT_LLM_MODEL = process.env.LLM_MODEL || DEFAULT_MODEL_ID

/** True if the OpenRouter key is present — agent/classify degrade gracefully otherwise. */
export const hasLLMKey = OPENROUTER_API_KEY.length > 0

/** True if the Jina key is present — web search degrades gracefully otherwise. */
export const hasSearchKey = JINA_API_KEY.length > 0

/** OpenRouter chat-completions endpoint. */
export function openRouterUrl(): string {
  return `${OPENROUTER_BASE_URL}/chat/completions`
}

/** Headers for an OpenRouter request. Key is a Bearer token; ranking headers are optional. */
export function openRouterHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${OPENROUTER_API_KEY}`,
    "Content-Type": "application/json",
  }
  if (OPENROUTER_SITE_URL) headers["HTTP-Referer"] = OPENROUTER_SITE_URL
  if (OPENROUTER_APP_TITLE) headers["X-Title"] = OPENROUTER_APP_TITLE
  return headers
}
