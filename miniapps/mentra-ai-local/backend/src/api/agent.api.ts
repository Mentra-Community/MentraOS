import {Hono, type Context} from "hono"
import {type MentraAuthVariables} from "@mentra/auth"

import {mentraAuthMiddleware} from "./auth"
import {AgentServiceError, generateResponse} from "../services/agent/agent.service"
import {type AgentRequest} from "../services/agent/types"

export const agentApi = new Hono<{Variables: MentraAuthVariables}>()

agentApi.use("*", mentraAuthMiddleware())

agentApi.post("/", async (c) => {
  try {
    const body = (await c.req.json()) as AgentRequest
    return c.json(await generateResponse(body))
  } catch (error) {
    return agentErrorResponse(c, error)
  }
})

function agentErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof AgentServiceError) {
    return c.json({response: "", toolCalls: 0, error: error.message}, error.status)
  }
  const message = error instanceof Error ? error.message : "Unknown error"
  return c.json({response: "", toolCalls: 0, error: message}, 500)
}
