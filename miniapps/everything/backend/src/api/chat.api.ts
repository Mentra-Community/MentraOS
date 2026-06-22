import {Hono, type Context} from "hono"
import {createMentraAuth, type MentraAuthVariables} from "@mentra/auth"

import {ChatServiceError, chatService, type ChatRequest} from "../services/chat/chat.service"

export const chatApi = new Hono<{Variables: MentraAuthVariables}>()

const mentraAuth = createMentraAuth({
  packageName: process.env.EVERYTHING_PACKAGE_NAME ?? "com.mentra.everything",
})

chatApi.use("*", mentraAuth.hono())

chatApi.post("/", async (c) => {
  try {
    const auth = c.get("mentraAuth")
    const body = (await c.req.json()) as ChatRequest
    return c.json(await chatService.respond({...body, userId: auth.mentraUserId}))
  } catch (error) {
    return chatErrorResponse(c, error)
  }
})

function chatErrorResponse(c: Context, error: unknown): Response {
  if (error instanceof ChatServiceError) {
    console.error(`[Everything] chat error (${error.status}): ${error.message}`)
    return c.json({text: error.message, imageBase64: null, error: error.message}, error.status)
  }

  const message = error instanceof Error ? error.message : "Unknown error"
  console.error("[Everything] unexpected chat error:", error)
  return c.json({text: message, imageBase64: null, error: message}, 500)
}
