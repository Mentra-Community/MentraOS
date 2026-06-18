import {Hono, type Context} from "hono"

import {
  InsightServiceError,
  insightsService,
  type InsightRequest,
} from "../services/insights/insights.service"

export const insightsApi = new Hono()

insightsApi.post("/", async (c) => {
  try {
    const body = (await c.req.json()) as InsightRequest
    return c.json(await insightsService.createInsight(body))
  } catch (error) {
    return insightErrorResponse(c, error)
  }
})

function insightErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof InsightServiceError) {
    return c.json({type: "silent", reasoning: error.message}, error.status)
  }

  const message = error instanceof Error ? error.message : "Unknown error"
  return c.json({type: "silent", reasoning: message}, 500)
}
