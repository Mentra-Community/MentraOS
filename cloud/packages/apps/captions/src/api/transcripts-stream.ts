import {getAuthUserId} from "./auth-helpers"
import {UserSession} from "../app/session/UserSession"

export const transcriptStreamRoute = {
  "/api/transcripts/stream": {
    async GET(req: Request) {
      const userId = getAuthUserId(req)

      if (!userId) {
        return new Response("Unauthorized", {status: 401})
      }

      const userSession = UserSession.getUserSession(userId)

      if (!userSession) {
        return new Response("No active session", {status: 404})
      }

      // Create SSE response stream
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder()

          // Send initial connection message
          const connectMsg = `data: ${JSON.stringify({type: "connected"})}\n\n`
          controller.enqueue(encoder.encode(connectMsg))

          // Create SSE client
          const client = {
            send: (data: any) => {
              const msg = `data: ${JSON.stringify(data)}\n\n`
              try {
                controller.enqueue(encoder.encode(msg))
              } catch {
                // Client disconnected, will be cleaned up below
                userSession.transcripts.removeSSEClient(client)
              }
            },
          }

          // Register client with TranscriptsManager
          userSession.transcripts.addSSEClient(client)

          // Cleanup on disconnect
          req.signal?.addEventListener("abort", () => {
            userSession.transcripts.removeSSEClient(client)
            try {
              controller.close()
            } catch {
              // Already closed
            }
          })
        },
      })

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no", // Disable nginx buffering
        },
      })
    },
  },
}
