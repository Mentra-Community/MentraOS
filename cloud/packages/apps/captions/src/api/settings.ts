import {requireAuth} from "./auth-helpers"
import {UserSession} from "../app/session/UserSession"

export const settingsRoutes = {
  "/api/settings": requireAuth(async (_req, userId) => {
    const userSession = UserSession.getUserSession(userId)

    if (!userSession) {
      return Response.json({error: "No active session"}, {status: 404})
    }

    const settings = await userSession.settings.getAll()
    return Response.json(settings)
  }),

  "/api/settings/language": {
    POST: requireAuth(async (req, userId) => {
      const userSession = UserSession.getUserSession(userId)

      if (!userSession) {
        return Response.json({error: "No active session"}, {status: 404})
      }

      let body
      try {
        body = await req.json()
      } catch {
        return Response.json({error: "Invalid JSON body"}, {status: 400})
      }

      const {language} = body

      if (!language || typeof language !== "string") {
        return Response.json({error: "Invalid language"}, {status: 400})
      }

      await userSession.settings.setLanguage(language)

      return Response.json({success: true})
    }),
  },

  "/api/settings/language-hints": {
    POST: requireAuth(async (req, userId) => {
      const userSession = UserSession.getUserSession(userId)

      if (!userSession) {
        return Response.json({error: "No active session"}, {status: 404})
      }

      let body
      try {
        body = await req.json()
      } catch {
        return Response.json({error: "Invalid JSON body"}, {status: 400})
      }

      const {hints} = body

      if (!Array.isArray(hints)) {
        return Response.json({error: "hints must be an array"}, {status: 400})
      }

      await userSession.settings.setLanguageHints(hints)

      return Response.json({success: true})
    }),
  },

  "/api/settings/display-lines": {
    POST: requireAuth(async (req, userId) => {
      const userSession = UserSession.getUserSession(userId)

      if (!userSession) {
        return Response.json({error: "No active session"}, {status: 404})
      }

      let body
      try {
        body = await req.json()
      } catch {
        return Response.json({error: "Invalid JSON body"}, {status: 400})
      }

      const {lines} = body

      if (typeof lines !== "number" || lines < 2 || lines > 5) {
        return Response.json({error: "lines must be a number between 2 and 5"}, {status: 400})
      }

      await userSession.settings.setDisplayLines(lines)

      return Response.json({success: true})
    }),
  },

  "/api/settings/display-width": {
    POST: requireAuth(async (req, userId) => {
      const userSession = UserSession.getUserSession(userId)

      if (!userSession) {
        return Response.json({error: "No active session"}, {status: 404})
      }

      let body
      try {
        body = await req.json()
      } catch {
        return Response.json({error: "Invalid JSON body"}, {status: 400})
      }

      const {width} = body

      if (typeof width !== "number") {
        return Response.json({error: "width must be a number"}, {status: 400})
      }

      await userSession.settings.setDisplayWidth(width)

      return Response.json({success: true})
    }),
  },
}
