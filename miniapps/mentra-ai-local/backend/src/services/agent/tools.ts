/**
 * Agent tools — function declarations + an in-process executor.
 *
 * Ported from the miniapp's agent/tools/index.ts. Runs server-side as part of
 * the tool-loop in agent.service.ts. web_search delegates to the Jina
 * search.service; calculator/thinking run locally; ask_agent escalates to the
 * user's giga-agent via the control plane (only offered when configured).
 *
 * The tools are advertised to OpenRouter (OpenAI chat-completions format) via
 * `buildOpenAITools()`, derived from the same declarations.
 */

import {Parser} from "expr-eval"

import {webSearch} from "../search/search.service"
import type {ToolDef} from "../openrouter"
import {delegateMessage, isDelegationEnabled, type AgentAction} from "./delegation"
import type {DeviceAction} from "./types"

/** Function declarations (name/description/JSON-schema parameters). */
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

/**
 * ask_agent — escalate to the user's personal giga-agent (their memory,
 * connected accounts, and multi-step autonomous work). Only advertised to the
 * model when delegation is configured (see buildOpenAITools).
 */
export const ASK_AGENT_DECLARATION = {
  name: "ask_agent",
  description:
    "Delegate a task to the user's personal agent — their long-term memory, connected " +
    "accounts (email, calendar), and the ability to do multi-step, autonomous work. Use this " +
    "for ANYTHING that needs the user's personal data/accounts or that takes multiple steps. " +
    "Do NOT use it for simple public lookups (a single price, today's weather, a score, math) — " +
    "answer those yourself or with web_search. Pass the full task with all needed context.",
  parameters: {
    type: "object",
    properties: {
      task: {type: "string", description: "The task or question for the agent, with all needed context."},
    },
    required: ["task"],
  },
} as const

/** OpenAI chat-completions tool schema, derived from TOOL_DECLARATIONS. */
function toToolDef(d: {name: string; description: string; parameters: unknown}): ToolDef {
  return {
    type: "function",
    function: {name: d.name, description: d.description, parameters: d.parameters as Record<string, unknown>},
  }
}

/**
 * App-control tools — operate OTHER miniapps (Mentra AI is a system app). Only
 * advertised when at least one controllable app is in context. The device op is
 * deferred: each call records a DeviceAction the background executes after the
 * response (the agent already knows the apps + their actions from context).
 */
export const APP_CONTROL_DECLARATIONS = [
  {
    name: "start_app",
    description:
      "Start (open) another miniapp on the glasses by its exact packageName from the available-apps " +
      "list. Starting an already-running app is harmless.",
    parameters: {
      type: "object",
      properties: {packageName: {type: "string", description: "The app's exact packageName."}},
      required: ["packageName"],
    },
  },
  {
    name: "stop_app",
    description: "Stop (close) another running miniapp by its exact packageName from the available-apps list.",
    parameters: {
      type: "object",
      properties: {packageName: {type: "string", description: "The app's exact packageName."}},
      required: ["packageName"],
    },
  },
  {
    name: "invoke_app_action",
    description:
      "Trigger a specific declared action inside another miniapp (e.g. start translation, load a " +
      "teleprompter script). Use the packageName and actionId exactly as listed for that app, and pass " +
      "params matching the action's declared parameters.",
    parameters: {
      type: "object",
      properties: {
        packageName: {type: "string", description: "The target app's exact packageName."},
        actionId: {type: "string", description: "The action's id, as declared by that app."},
        params: {type: "object", description: "Parameters for the action (match its declared schema)."},
      },
      required: ["packageName", "actionId"],
    },
  },
] as const

/** Base tools always advertised to the model. */
export const OPENAI_TOOLS: ToolDef[] = TOOL_DECLARATIONS.map(toToolDef)

/** Tools for a request — adds ask_agent / app-control when each is available. */
export function buildOpenAITools(opts: {askAgent: boolean; appControl: boolean}): ToolDef[] {
  const tools = [...OPENAI_TOOLS]
  if (opts.askAgent) tools.push(toToolDef(ASK_AGENT_DECLARATION))
  if (opts.appControl) tools.push(...APP_CONTROL_DECLARATIONS.map(toToolDef))
  return tools
}

/**
 * Per-request, out-of-band channel for the delegation result. The ask_agent
 * tool's return goes to the MODEL (text), but the caller (agent.service) also
 * needs the structured outcome — the actions to render and any pending taskId
 * for the async follow-up. We stash those here.
 */
export interface DelegationHolder {
  pendingTaskId?: string
  actions?: AgentAction[]
}

/** Context passed alongside a tool call (the authed user + the delegation holder). */
export interface ToolExecContext {
  userId?: string
  delegation?: DelegationHolder
  /** App-control tools push their deferred device actions here. */
  deviceActions?: DeviceAction[]
}

const parser = new Parser()

/** Execute a tool by name; returns a JSON-serializable result for the model. */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx?: ToolExecContext,
): Promise<Record<string, unknown>> {
  switch (name) {
    case "web_search":
      return {...(await webSearch(String(args.query ?? "")))}
    case "calculator":
      return calculator(String(args.expression ?? ""))
    case "thinking":
      console.log(`💭 [Thinking] ${String(args.thought ?? "")}`)
      return {acknowledged: true}
    case "ask_agent":
      return askAgent(String(args.task ?? ""), ctx)
    case "start_app":
      return appControl({type: "start_app", packageName: String(args.packageName ?? "")}, ctx)
    case "stop_app":
      return appControl({type: "stop_app", packageName: String(args.packageName ?? "")}, ctx)
    case "invoke_app_action":
      return appControl(
        {
          type: "invoke_action",
          packageName: String(args.packageName ?? ""),
          actionId: String(args.actionId ?? ""),
          params: args.params && typeof args.params === "object" ? (args.params as Record<string, unknown>) : undefined,
        },
        ctx,
      )
    default:
      return {error: `Unknown tool: ${name}`}
  }
}

/**
 * Record a deferred app-control action for the background to execute, and return
 * an optimistic confirmation to the model. We don't execute here (that happens
 * on-device) — fire-and-forget fits a voice assistant, and the agent already has
 * the app list from context.
 */
function appControl(action: DeviceAction, ctx?: ToolExecContext): Record<string, unknown> {
  if (!action.packageName) return {status: "error", note: "Missing packageName."}
  if (action.type === "invoke_action" && !action.actionId) {
    return {status: "error", note: "Missing actionId."}
  }
  if (!ctx?.deviceActions) {
    return {status: "unavailable", note: "App control isn't available right now."}
  }
  ctx.deviceActions.push(action)
  console.log(`🎛️ [app-control] queued ${action.type} ${action.packageName}${"actionId" in action ? `#${action.actionId}` : ""}`)
  return {status: "queued", note: "Done — confirm the action to the user in one short, natural line."}
}

/**
 * Run a delegation. On a fast result, returns the reply for the model to relay
 * and stashes any actions. On a slow result, stashes the pending taskId and
 * tells the model to acknowledge briefly — the real answer is delivered later
 * by the background polling /api/agent/task/:id.
 */
async function askAgent(task: string, ctx?: ToolExecContext): Promise<Record<string, unknown>> {
  if (!isDelegationEnabled() || !ctx?.userId) {
    return {status: "unavailable", note: "The personal agent isn't available right now."}
  }
  console.log(`🤝 [ask_agent] delegating: "${task.slice(0, 80)}${task.length > 80 ? "..." : ""}"`)

  const result = await delegateMessage(ctx.userId, task)

  if (result.status === "done") {
    if (ctx.delegation) ctx.delegation.actions = result.actions
    return {status: "done", reply: result.reply}
  }
  if (result.status === "working") {
    if (ctx.delegation) ctx.delegation.pendingTaskId = result.taskId
    return {
      status: "working",
      note:
        "The agent is now working on this in the background. Reply with ONE short, natural, " +
        "voice-friendly sentence acknowledging you're on it, tailored to the task " +
        '(e.g. "Checking your inbox — one sec."). Give a rough sense of how long based on the ' +
        "task, never a specific number of seconds. Do NOT make up the answer — you don't have it yet.",
    }
  }
  return {status: "failed", note: "I couldn't reach your agent just now. Please try again."}
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
