import {Hono} from "hono"
import {cors} from "hono/cors"

import {agentApi} from "./agent.api"
import {classifyApi} from "./classify.api"
import {searchApi} from "./search.api"
import {DEFAULT_LLM_MODEL} from "../services/ai-config"

export function createApp(): Hono {
  const app = new Hono()

  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type", "Authorization"],
    }),
  )

  app.get("/healthz", (c) =>
    c.json({
      status: "ok",
      service: "mentra-ai-local-backend",
      model: DEFAULT_LLM_MODEL,
    }),
  )

  app.route("/api/agent", agentApi)
  app.route("/api/classify", classifyApi)
  app.route("/api/search", searchApi)

  return app
}
