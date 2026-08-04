import {Hono} from "hono"
import {cors} from "hono/cors"

import {insightsApi} from "./insights.api"
import {insightsService} from "../services/insights/insights.service"

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
      service: "local-merge-backend",
      model: insightsService.model,
    }),
  )

  app.route("/api/insights", insightsApi)

  return app
}
