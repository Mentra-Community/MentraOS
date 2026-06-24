/**
 * Agent webhook — receives delegation results from the giga-agent control plane.
 *
 * The control plane POSTs the finished task here (the `webhook_url` we passed on
 * the original /message call), echoing our shared `x-api-key` so we can verify
 * the call is genuine. This is server-to-server, so it is mounted on the PUBLIC
 * sub-app (no SDK user token) and gated by the key check below instead.
 *
 * Routing is trivial: hand the result to DelegationManager, which fires the
 * follow-up handler registered when the delegation went async. Settling is
 * idempotent, so a webhook racing the poll backstop is harmless.
 */

import type { Context } from "hono";

import { AGENT_DELEGATION } from "../constants/config";
import { delegations } from "../manager/DelegationManager";
import type { AgentAction, AgentTaskResult } from "../manager/AgentBridge";

export async function agentWebhook(c: Context): Promise<Response> {
  // Verify the shared key the control plane echoes back (postWebhook in
  // server.js sends `x-api-key: CONTROL_PLANE_KEY`, == our MENTRA_AGENT_API_KEY).
  const key = c.req.header("x-api-key");
  if (!AGENT_DELEGATION.apiKey || key !== AGENT_DELEGATION.apiKey) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const taskId = typeof body.taskId === "string" ? body.taskId : null;
  if (!taskId) return c.json({ error: "taskId required" }, 400);

  const status = body.status === "done" || body.status === "failed" ? body.status : "working";

  // The control plane only fires the webhook once a task is settled; ignore
  // anything still "working" defensively.
  if (status === "working") return c.json({ ok: true, ignored: "still working" });

  const result: AgentTaskResult = {
    taskId,
    userId: typeof body.userId === "string" ? body.userId : "",
    status,
    reply: typeof body.reply === "string" ? body.reply : undefined,
    actions: Array.isArray(body.actions) ? (body.actions as AgentAction[]) : undefined,
    error: typeof body.error === "string" ? body.error : undefined,
    ms: typeof body.ms === "number" ? body.ms : undefined,
  };

  // Ack immediately; the follow-up delivery runs async inside DelegationManager.
  void delegations.complete(taskId, result);
  return c.json({ ok: true });
}
