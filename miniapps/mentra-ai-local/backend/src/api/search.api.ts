import {Hono} from "hono"
import {type MentraAuthVariables} from "@mentra/auth"

import {mentraAuthMiddleware} from "./auth"
import {webSearch} from "../services/search/search.service"

export const searchApi = new Hono<{Variables: MentraAuthVariables}>()

searchApi.use("*", mentraAuthMiddleware())

searchApi.post("/", async (c) => {
  try {
    const {query} = (await c.req.json()) as {query?: string}
    return c.json(await webSearch(String(query ?? "")))
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error"
    return c.json({results: "Search failed due to an error.", error: message}, 500)
  }
})
