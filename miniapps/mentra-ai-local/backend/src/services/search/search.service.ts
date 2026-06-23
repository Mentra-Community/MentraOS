/**
 * Web-search service — Jina s.jina.ai, server-side.
 *
 * Ported from the miniapp's agent/tools/index.ts webSearch(). The Jina key now
 * lives only on the backend. Both the agent tool-loop (in-process) and the
 * standalone POST /api/search route call this.
 */

import {JINA_API_KEY, hasSearchKey} from "../ai-config"

export interface SearchResult {
  results: string
}

interface JinaSearchResponse {
  data?: Array<{title: string; description: string; url: string}>
}

/** Run a web search and return a compact, model-friendly result string. */
export async function webSearch(query: string): Promise<SearchResult> {
  if (!hasSearchKey) {
    console.warn("⚠️ JINA_API_KEY not configured")
    return {results: "Web search is not available."}
  }
  console.log(`🔍 Searching web for: "${query}"`)
  try {
    const response = await fetch(`https://s.jina.ai/${encodeURIComponent(query)}`, {
      headers: {
        Authorization: `Bearer ${JINA_API_KEY}`,
        Accept: "application/json",
        "X-Respond-With": "no-content",
        "X-Retain-Images": "none",
      },
    })
    if (!response.ok) {
      console.error(`❌ Jina API error: ${response.status}`)
      return {results: "Search failed. Please try again."}
    }
    const json = (await response.json()) as JinaSearchResponse
    const results = json.data || []
    const formatted = results
      .slice(0, 5)
      .map((r, i) => `${i + 1}. ${r.title}\n${r.description}`)
      .join("\n\n")
    console.log(`✅ Search returned ${results.length} results`)
    return {results: formatted || "No results found."}
  } catch (error) {
    console.error("❌ Search error:", error)
    return {results: "Search failed due to an error."}
  }
}
