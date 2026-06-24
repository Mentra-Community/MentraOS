/**
 * ask_agent — delegate a task to the user's personal giga-agent.
 *
 * This is the fast agent's escalation path. It is built PER QUERY with a
 * `delegate` closure (owned by QueryProcessor) so it carries the user's id,
 * device context, and POV photo without the tool having to know about them.
 *
 * The async lifecycle is hidden behind the tool, so from the model's point of
 * view this is an ordinary tool call:
 *   - resolves "done"    → the agent relays the reply to the user.
 *   - resolves "working" → the agent speaks a brief, task-aware ack; the real
 *                          result is delivered later via deliverFollowUp().
 *
 * See agent/prompt.ts (buildDelegationSection) for the routing rules the model
 * uses to decide when to call this.
 */

import { createTool } from "@mastra/core/tools";
import { z } from "zod";

/** What QueryProcessor's delegate closure resolves to. */
export type DelegateOutcome =
  | { status: "done"; reply: string }
  | { status: "working" };

export type DelegateFn = (task: string) => Promise<DelegateOutcome>;

export function createAskAgentTool(delegate: DelegateFn) {
  return createTool({
    id: "ask-agent",
    description:
      "Delegate a task to the user's personal agent — their long-term memory, " +
      "connected accounts (email, calendar), and the ability to do multi-step, " +
      "autonomous work. Use this for ANYTHING that needs the user's personal data " +
      "or accounts, or that takes multiple steps. Do NOT use it for simple public " +
      "lookups (a single price, today's weather, a score, math) — answer those " +
      "yourself or with web search. Pass the full task with all context the agent needs.",
    inputSchema: z.object({
      task: z.string().describe("The task or question for the agent, with all needed context."),
    }),
    outputSchema: z.object({
      status: z.enum(["done", "working"]),
      reply: z.string().optional().describe("The agent's answer (only when status is 'done')."),
      note: z.string().optional().describe("Instruction for how to respond (only when 'working')."),
    }),
    execute: async (input) => {
      const { task } = input;
      console.log(`🤝 [ask_agent] delegating: "${task.slice(0, 80)}${task.length > 80 ? "..." : ""}"`);

      const outcome = await delegate(task);

      if (outcome.status === "done") {
        return { status: "done" as const, reply: outcome.reply };
      }

      // Pending — the agent is working in the background. Tell the model to
      // acknowledge briefly; the answer arrives later as a follow-up.
      return {
        status: "working" as const,
        note:
          "Your personal agent is now working on this in the background. Reply with ONE short, " +
          "natural, voice-friendly sentence that acknowledges you're on it, tailored to the task " +
          "(e.g. \"Checking your inbox — one sec.\"). Set a rough expectation of how long based on " +
          "the task (a quick lookup vs. a minute or two), but never promise a specific number of " +
          "seconds. Do NOT make up the answer — you don't have it yet.",
      };
    },
  });
}
