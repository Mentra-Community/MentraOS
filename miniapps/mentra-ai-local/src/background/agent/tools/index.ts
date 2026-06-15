/**
 * Agent tools — plain functions + Gemini functionDeclarations.
 *
 * PORT NOTE: the cloud app defined these with Mastra's createTool(). Mastra
 * imports Node builtins (stream/web) that the browser-target JSContext bundle
 * can't take, so the local port calls Gemini's REST API directly and runs a
 * small tool-call loop (see MentraAgent.ts). Each tool here is a (1) Gemini
 * function declaration and (2) an executor keyed by tool name.
 */

import {Parser} from "expr-eval"

const JINA_API_KEY = process.env.JINA_API_KEY

/** Gemini function declarations advertised to the model. */
export const TOOL_DECLARATIONS = [
  {
    name: "web_search",
    description:
      "Search the web for current information. Use for real-time data like weather, news, sports scores, business hours, or topics you're unsure about. You may ONLY call this tool ONCE per user query.",
    parameters: {
      type: "object",
      properties: {
        query: {type: "string", description: "The search query"},
      },
      required: ["query"],
    },
  },
  {
    name: "calculator",
    description:
      "Perform mathematical calculations. Use for arithmetic, conversions, percentages, tip calculations, etc.",
    parameters: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: "Mathematical expression to evaluate (e.g., '15 * 0.2', 'sqrt(16)')",
        },
      },
      required: ["expression"],
    },
  },
  {
    name: "thinking",
    description:
      "Think through a problem step by step. Use this to reason about complex questions before answering.",
    parameters: {
      type: "object",
      properties: {
        thought: {type: "string", description: "Your reasoning process or step-by-step thinking"},
      },
      required: ["thought"],
    },
  },
] as const

const parser = new Parser()

/** Execute a tool by name; returns a JSON-serializable result for the model. */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  switch (name) {
    case "web_search":
      return webSearch(String(args.query ?? ""))
    case "calculator":
      return calculator(String(args.expression ?? ""))
    case "thinking":
      console.log(`💭 [Thinking] ${String(args.thought ?? "")}`)
      return {acknowledged: true}
    default:
      return {error: `Unknown tool: ${name}`}
  }
}

interface JinaSearchResponse {
  data?: Array<{title: string; description: string; url: string}>
}

async function webSearch(query: string): Promise<{results: string}> {
  if (!JINA_API_KEY) {
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

function calculator(expression: string): {result: number | null; error?: string} {
  console.log(`🧮 Calculating: "${expression}"`)
  try {
    const result = parser.evaluate(expression)
    if (typeof result !== "number" || !Number.isFinite(result)) {
      return {result: null, error: "Invalid calculation result"}
    }
    console.log(`✅ Result: ${result}`)
    return {result}
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    return {result: null, error: message}
  }
}
