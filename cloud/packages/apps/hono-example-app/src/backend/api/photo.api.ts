import {Hono} from "hono"
import type {Context} from "hono"
import {UserSession} from "../UserSession"

const app = new Hono()

// ─── Routes ──────────────────────────────────────────────────────────────────

app.get("/latest", getLatestPhoto)
app.get("/:requestId", getPhotoData)
app.get("/:requestId/base64", getPhotoBase64)

// ─── Handlers ────────────────────────────────────────────────────────────────

/** GET /latest — metadata for the most recent photo */
function getLatestPhoto(c: Context) {
  const userId = c.req.query("userId")

  if (!userId) return c.json({error: "userId is required"}, 400)

  const userSession = UserSession.get(userId)
  if (!userSession) return c.json({error: "No photos available for this user"}, 404)

  const photos = userSession.photo.getAll()
  if (photos.length === 0) {
    return c.json({error: "No photos available for this user"}, 404)
  }

  const latest = photos[0]
  return c.json({
    requestId: latest.requestId,
    timestamp: latest.timestamp.getTime(),
    userId: latest.userId,
    hasPhoto: true,
  })
}

/** GET /:requestId — raw photo image data */
function getPhotoData(c: Context) {
  const requestId = c.req.param("requestId")
  const userId = c.req.query("userId")

  if (!userId) return c.json({error: "userId is required"}, 400)

  const userSession = UserSession.get(userId)
  const photo = user?.photo.getPhoto(requestId)
  if (!photo) return c.json({error: "Photo not found"}, 404)
  if (photo.userId !== userId) {
    return c.json({error: "Access denied: photo belongs to different user"}, 403)
  }

  return new Response(new Uint8Array(photo.buffer), {
    headers: {
      "Content-Type": photo.mimeType,
      "Cache-Control": "no-cache",
    },
  })
}

/** GET /:requestId/base64 — photo as base64 JSON */
function getPhotoBase64(c: Context) {
  const requestId = c.req.param("requestId")
  const userId = c.req.query("userId")

  if (!userId) return c.json({error: "userId is required"}, 400)

  const userSession = UserSession.get(userId)
  const photo = user?.photo.getPhoto(requestId)
  if (!photo) return c.json({error: "Photo not found"}, 404)
  if (photo.userId !== userId) {
    return c.json({error: "Access denied: photo belongs to different user"}, 403)
  }

  const base64Data = photo.buffer.toString("base64")
  return c.json({
    requestId: photo.requestId,
    timestamp: photo.timestamp.getTime(),
    mimeType: photo.mimeType,
    filename: photo.filename,
    size: photo.size,
    userId: photo.userId,
    base64: base64Data,
    dataUrl: `data:${photo.mimeType};base64,${base64Data}`,
  })
}

export default app
