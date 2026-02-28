import {requireAuth} from "./auth-helpers"
import {UserSession} from "../app/session/UserSession"

export const transcriptsRoutes = {
  "/api/transcripts": requireAuth(async (_req, userId) => {
    const userSession = UserSession.getUserSession(userId)

    if (!userSession) {
      return Response.json({error: "No active session"}, {status: 404})
    }

    const transcripts = userSession.transcripts.getAll()

    return Response.json({transcripts})
  }),
}
