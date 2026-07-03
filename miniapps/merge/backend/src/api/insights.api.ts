import {Hono, type Context} from "hono"
import {createMentraAuth, type MentraAuthVariables} from "@mentra/auth"

import {
  InsightServiceError,
  insightsService,
  type InsightRequest,
} from "../services/insights/insights.service"

export const insightsApi = new Hono<{Variables: MentraAuthVariables}>()

const mentraAuth = createMentraAuth({
  packageName: process.env.MERGE_PACKAGE_NAME ?? "com.mentra.merge",
})

insightsApi.use(
  "*",
  mentraAuth.hono({
    onUnauthorized: (error, c) => {
      console.warn("[LocalMerge] miniapp auth rejected", {
        error: error.message,
        packageName: process.env.MERGE_PACKAGE_NAME ?? "com.mentra.merge",
        jwksUrl: process.env.MENTRA_AUTH_JWKS_URL,
        issuers: process.env.MENTRA_AUTH_ISSUERS ?? process.env.MENTRA_AUTH_ISSUER,
      })
      return c.json({error: error.message}, 401)
    },
  }),
)

insightsApi.post("/", async (c) => {
  try {
    const auth = c.get("mentraAuth")
    const body = (await c.req.json()) as InsightRequest
    return c.json(await insightsService.createInsight({...body, userId: auth.mentraUserId}))
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
