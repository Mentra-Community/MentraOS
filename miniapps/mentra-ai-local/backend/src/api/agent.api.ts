import {Hono, type Context} from "hono"
import {type MentraAuthVariables} from "@mentra/auth"

import {mentraAuthMiddleware} from "./auth"
import {AgentServiceError, generateResponse} from "../services/agent/agent.service"
import {getDelegationTask, wakeDelegation} from "../services/agent/delegation"
import {type AgentRequest} from "../services/agent/types"

export const agentApi = new Hono<{Variables: MentraAuthVariables}>()

agentApi.use("*", mentraAuthMiddleware())

agentApi.post("/", async (c) => {
  try {
    const auth = c.get("mentraAuth")
    const body = (await c.req.json()) as AgentRequest
    return c.json(await generateResponse(body, auth.mentraUserId))
  } catch (error) {
    return agentErrorResponse(c, error)
  }
})

/**
 * GET /api/agent/task/:taskId — poll a pending giga-agent delegation.
 *
 * The background calls this (with its auth token) after the agent returned a
 * `pendingTaskId`. We re-derive the user from auth and proxy the control plane,
 * so the control-plane key never leaves the server. Returns {status, reply?, actions?}.
 */
agentApi.get("/task/:taskId", async (c) => {
  const auth = c.get("mentraAuth")
  const taskId = c.req.param("taskId")
  const result = await getDelegationTask(auth.mentraUserId, taskId)
  if (!result) return c.json({status: "working" as const})
  return c.json(result)
})

/**
 * POST /api/agent/wake — predictive wake. The background calls this at wake-word
 * time so the user's giga-agent container is warm by the time the fast agent
 * decides whether to delegate. No-op when delegation isn't configured.
 */
agentApi.post("/wake", (c) => {
  const auth = c.get("mentraAuth")
  void wakeDelegation(auth.mentraUserId)
  return c.json({ok: true})
})

function agentErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof AgentServiceError) {
    return c.json({response: "", toolCalls: 0, error: error.message}, error.status)
  }
  const message = error instanceof Error ? error.message : "Unknown error"
  return c.json({response: "", toolCalls: 0, error: message}, 500)
}
