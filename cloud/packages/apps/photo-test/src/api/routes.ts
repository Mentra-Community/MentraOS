import {UserSession} from "../app/session/UserSession"

/**
 * API Routes for Photo Test App
 */
export const routes = {
  "/api/status": {
    async GET(req: Request) {
      const userId = req.headers.get("x-auth-user-id")

      if (!userId) {
        return Response.json({authenticated: false})
      }

      const session = UserSession.getUserSession(userId)

      return Response.json({
        authenticated: true,
        userId,
        hasSession: !!session,
        photoCount: session?.getPhotoCount() || 0,
      })
    },
  },

  "/api/latest-photo": {
    async GET(req: Request) {
      const userId = req.headers.get("x-auth-user-id")

      if (!userId) {
        return Response.json({error: "Not authenticated"}, {status: 401})
      }

      const session = UserSession.getUserSession(userId)

      if (!session) {
        return Response.json({error: "No active session"}, {status: 404})
      }

      const photo = session.getLatestPhoto()

      if (!photo) {
        return Response.json({error: "No photo available yet"}, {status: 404})
      }

      // Return photo as base64 data URL
      const base64 = Buffer.from(photo.buffer).toString("base64")
      const dataUrl = `data:${photo.mimeType};base64,${base64}`

      return Response.json({
        photoCount: session.getPhotoCount(),
        filename: photo.filename,
        size: photo.size,
        mimeType: photo.mimeType,
        timestamp: photo.timestamp,
        dataUrl,
      })
    },
  },

  "/api/photo-count": {
    async GET(req: Request) {
      const userId = req.headers.get("x-auth-user-id")

      if (!userId) {
        return Response.json({error: "Not authenticated"}, {status: 401})
      }

      const session = UserSession.getUserSession(userId)

      if (!session) {
        return Response.json({error: "No active session"}, {status: 404})
      }

      return Response.json({
        photoCount: session.getPhotoCount(),
      })
    },
  },
}
