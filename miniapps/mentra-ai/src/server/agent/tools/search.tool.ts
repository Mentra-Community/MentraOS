/**
 * Web Search Tool using Jina AI
 *
 * Provides web search capability for the agent.
 * Uses "no-content" mode for fast SERP snippets instead of full page content.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";

const JINA_API_KEY = process.env.JINA_API_KEY;

interface JinaSearchResult {
  title: string;
  description: string;
  url: string;
}

interface JinaSearchResponse {
  data: JinaSearchResult[];
}

export const searchTool = createTool({
  id: "web-search",
  description: "Search the web for current information. Use for real-time data like weather, news, sports scores, business hours, or topics you're unsure about. You may ONLY call this tool ONCE per user query.",
  inputSchema: z.object({
    query: z.string().describe("The search query"),
  }),
  outputSchema: z.object({
    results: z.string().describe("Search results summary"),
  }),
  execute: async (input) => {
    const { query } = input;

    if (!JINA_API_KEY) {
      console.warn("⚠️ JINA_API_KEY not configured");
      return { results: "Web search is not available." };
    }

    console.log(`🔍 Searching web for: "${query}"`);

    try {
      // Use JSON mode with no-content to get just SERP snippets (titles + descriptions)
      // This is dramatically faster than fetching full page content
      const response = await fetch(`https://s.jina.ai/${encodeURIComponent(query)}`, {
        headers: {
          "Authorization": `Bearer ${JINA_API_KEY}`,
          "Accept": "application/json",
          "X-Respond-With": "no-content",
          "X-Retain-Images": "none",
        },
      });

      if (!response.ok) {
        console.error(`❌ Jina API error: ${response.status}`);
        return { results: "Search failed. Please try again." };
      }

      const json = await response.json() as JinaSearchResponse;
      const results = json.data || [];

      // Format top 5 results as concise snippets
      const formatted = results
        .slice(0, 5)
        .map((r, i) => `${i + 1}. ${r.title}\n${r.description}`)
        .join("\n\n");

      console.log(`✅ Search returned ${results.length} results (${formatted.length} chars)`);

      return { results: formatted || "No results found." };

    } catch (error) {
      console.error("❌ Search error:", error);
      return { results: "Search failed due to an error." };
    }
  },
});
