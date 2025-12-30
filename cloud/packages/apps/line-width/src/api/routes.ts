import {getAuthInfo} from "./auth-helpers"
import {settingsRoutes} from "./settings"
import {transcriptsRoutes} from "./transcripts"
import {transcriptStreamRoute} from "./transcripts-stream"
import {UserSession} from "../app/session/UserSession"

/**
 * API Routes for Line Width Debug Tool
 *
 * Includes transcription streaming for live captions testing
 */

export const routes = {
  // Settings routes
  ...settingsRoutes,

  // Transcription routes (for live captions mode)
  ...transcriptsRoutes,
  ...transcriptStreamRoute,

  // Auth info endpoint
  "/api/me": {
    async GET(req: Request) {
      const authInfo = getAuthInfo(req)
      return Response.json(authInfo)
    },
  },

  // Note: /api/send-text is handled by Express (has access to lineWidthApp)

  // Health check
  "/api/health": {
    async GET(_req: Request) {
      return Response.json({
        status: "ok",
        app: "line-width-debug",
        timestamp: new Date().toISOString(),
      })
    },
  },

  // Debug endpoint to show all active UserSessions
  "/api/debug/sessions": {
    async GET(req: Request) {
      const authInfo = getAuthInfo(req)
      const allSessions = Array.from(UserSession.userSessions.keys())
      const hasSessionForUser = authInfo.userId ? UserSession.userSessions.has(authInfo.userId) : false

      return Response.json({
        auth: authInfo,
        activeSessions: allSessions,
        sessionCount: allSessions.length,
        hasSessionForCurrentUser: hasSessionForUser,
        message:
          allSessions.length === 0
            ? "No glasses connected. Connect glasses to this app to enable Live mode."
            : `${allSessions.length} active session(s)`,
      })
    },
  },

  // Get glyph width data (for client reference)
  "/api/glyph-widths": {
    async GET(_req: Request) {
      const glyphWidths: Record<string, number> = {
        // Narrow glyphs (1-2px)
        "l": 1,
        "i": 1,
        "|": 1,
        "!": 1,
        ".": 1,
        ":": 1,
        "I": 2,
        "j": 2,
        "'": 1,
        ",": 1,
        ";": 2,

        // Average glyphs (4-5px)
        "a": 5,
        "b": 4,
        "c": 4,
        "d": 4,
        "e": 4,
        "f": 3,
        "g": 4,
        "h": 4,
        "k": 4,
        "n": 4,
        "o": 4,
        "p": 4,
        "q": 4,
        "r": 3,
        "s": 4,
        "t": 3,
        "u": 4,
        "v": 4,
        "x": 4,
        "y": 4,
        "z": 4,
        " ": 3,

        // Wide glyphs (6-7px)
        "m": 7,
        "w": 7,
        "M": 7,
        "W": 7,
        "@": 7,
        "&": 7,
      }

      return Response.json({
        glyphWidths,
        formula: "(glyph_width + 1) * 2",
        defaultWidth: 5,
        hardwareMaxWidth: 576,
        maxSafeBytes: 390,
        bleChunkSize: 176,
      })
    },
  },
}
