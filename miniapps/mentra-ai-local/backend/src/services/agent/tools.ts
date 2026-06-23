/**
 * Agent tools — Gemini functionDeclarations + an in-process executor.
 *
 * Ported from the miniapp's agent/tools/index.ts. Runs server-side as part of
 * the tool-loop in agent.service.ts. web_search delegates to the Jina
 * search.service; calculator/thinking run locally.
 */

import {Parser} from "expr-eval"

import {webSearch} from "../search/search.service"

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
      return {...(await webSearch(String(args.query ?? "")))}
    case "calculator":
      return calculator(String(args.expression ?? ""))
    case "thinking":
      console.log(`💭 [Thinking] ${String(args.thought ?? "")}`)
      return {acknowledged: true}
    default:
      return {error: `Unknown tool: ${name}`}
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
