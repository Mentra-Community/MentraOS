import {Hono} from "hono"
import {cors} from "hono/cors"

import {chatApi} from "./chat.api"
import {chatService} from "../services/chat/chat.service"

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
      service: "everything-backend",
      model: chatService.model,
    }),
  )

  app.route("/api/chat", chatApi)

  return app
}
