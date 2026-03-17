import {Hono} from "hono"
import type {Context} from "hono"
import {streamSSE} from "hono/streaming"
import {UserSession} from "../UserSession"

const app = new Hono()

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get("/photo", photoStream)
app.get("/transcription", transcriptionStream)

// ─── Handlers ────────────────────────────────────────────────────────────────

/** GET /photo — SSE for real-time photo updates */
function photoStream(c: Context) {
  const userId = c.req.query("userId")
  if (!userId) return c.json({error: "userId is required"}, 400)

  const userSession = UserSession.get(userId)
  if (!userSession) return c.json({error: `No user for ${userId}`}, 404)

  return streamSSE(c, async (stream) => {
    const client = {
      write: (data: string) => stream.writeSSE({data}),
      userId,
      close: () => stream.close(),
    }

    userSession.photo.addSSEClient(client)

    await stream.writeSSE({
      data: JSON.stringify({type: "connected", userId}),
    })

    // Send existing photos
    for (const photo of userSession.photo.getAllMap().values()) {
      const base64Data = photo.buffer.toString("base64")
      await stream.writeSSE({
        data: JSON.stringify({
          requestId: photo.requestId,
          timestamp: photo.timestamp.getTime(),
          mimeType: photo.mimeType,
          filename: photo.filename,
          size: photo.size,
          userId: photo.userId,
          base64: base64Data,
          dataUrl: `data:${photo.mimeType};base64,${base64Data}`,
        }),
      })
    }

    stream.onAbort(() => {
      userSession.photo.removeSSEClient(client)
    })

    while (true) {
      await stream.sleep(30000)
    }
  })
}

/** GET /transcription — SSE for real-time transcriptions */
function transcriptionStream(c: Context) {
  const userId = c.req.query("userId")
  if (!userId) return c.json({error: "userId is required"}, 400)

  const userSession = UserSession.get(userId)
  if (!userSession) return c.json({error: `No user for ${userId}`}, 404)

  return streamSSE(c, async (stream) => {
    const client = {
      write: (data: string) => stream.writeSSE({data}),
      userId,
      close: () => stream.close(),
    }

    userSession.transcription.addSSEClient(client)

    await stream.writeSSE({
      data: JSON.stringify({type: "connected", userId}),
    })

    stream.onAbort(() => {
      userSession.transcription.removeSSEClient(client)
    })

    while (true) {
      await stream.sleep(30000)
    }
  })
}

export default app
