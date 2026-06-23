/**
 * AI configuration — the single swap-point for where AI calls go.
 *
 * The miniapp no longer holds any AI keys. Every AI call (agent tool-loop,
 * visual classifier, web search) goes to the backend, which holds the Gemini +
 * Jina secrets server-side and verifies a package-scoped Bearer token.
 *
 * The only thing inlined into the bundle is the backend URL below.
 */

const DEFAULT_BACKEND_URL = "https://general.dev.tpa.ngrok.app"

/** Resolved backend base URL, trailing slashes stripped. */
export function backendUrl(): string {
  const fromEnv = process.env.MENTRA_PUBLIC_MENTRA_AI_BACKEND_URL?.trim()
  return (fromEnv || DEFAULT_BACKEND_URL).replace(/\/+$/, "")
}

/** Backend route URLs. */
export const BACKEND_ROUTES = {
  agent: () => `${backendUrl()}/api/agent`,
  classify: () => `${backendUrl()}/api/classify`,
  search: () => `${backendUrl()}/api/search`,
} as const
