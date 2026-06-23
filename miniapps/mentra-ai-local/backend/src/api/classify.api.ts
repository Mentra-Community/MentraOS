import {Hono} from "hono"
import {type MentraAuthVariables} from "@mentra/auth"

import {mentraAuthMiddleware} from "./auth"
import {isVisualQuery} from "../services/classify/classify.service"

export const classifyApi = new Hono<{Variables: MentraAuthVariables}>()

classifyApi.use("*", mentraAuthMiddleware())

classifyApi.post("/", async (c) => {
  try {
    const {query} = (await c.req.json()) as {query?: string}
    const visual = await isVisualQuery(String(query ?? ""))
    return c.json({visual})
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    // Default to non-visual on error — matches the client's old fail-safe.
    return c.json({visual: false, error: message}, 200)
  }
})
