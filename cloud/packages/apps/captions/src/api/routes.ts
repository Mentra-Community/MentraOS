import {requireAuth, optionalAuth, getAuthInfo} from "./auth-helpers"
import {transcriptsRoutes} from "./transcripts"
import {settingsRoutes} from "./settings"
import {transcriptStreamRoute} from "./transcripts-stream"

/**
 * API Routes for Captions App
 *
 * Two patterns for authentication:
 *
 * 1. Manual auth check (more control):
 *    ```typescript
 *    "/api/example": {
 *      async GET(req: Request) {
 *        const userId = getAuthUserId(req)
 *        if (!userId) {
 *          return Response.json({ error: "Not authenticated" }, { status: 401 })
 *        }
 *        return Response.json({ userId })
 *      }
 *    }
 *    ```
 *
 * 2. requireAuth wrapper (cleaner):
 *    ```typescript
 *    "/api/protected": requireAuth(async (req, userId) => {
 *      return Response.json({ userId, data: "secret" })
 *    })
 *    ```
 *
 * Note: For Express routes, use (req as any).authUserId in src/index.ts
 */

export const routes = {
  // Merge all route modules
  ...transcriptsRoutes,
  ...settingsRoutes,
  ...transcriptStreamRoute,

  // Auth info endpoint - uses manual check pattern
  "/api/me": {
    async GET(req: Request) {
      const authInfo = getAuthInfo(req)
      return Response.json(authInfo)
    },
  },

  // Example of requireAuth wrapper - userId is guaranteed to exist
  "/api/protected-example": requireAuth(async (req, userId) => {
    return Response.json({
      message: "This route requires authentication",
      userId,
      timestamp: new Date().toISOString(),
    })
  }),

  // Example of optionalAuth - different behavior for auth/non-auth
  "/api/optional-auth-example": optionalAuth(async (req, userId) => {
    if (userId) {
      return Response.json({
        message: `Hello, authenticated user!`,
        userId,
      })
    }
    return Response.json({
      message: "Hello, anonymous user!",
    })
  }),
  "/api/hello": {
    async GET(_req: Request) {
      return Response.json({
        message: "Hello from Captions API!",
        method: "GET",
      })
    },
    async PUT(_req: Request) {
      return Response.json({
        message: "Hello from Captions API!",
        method: "PUT",
      })
    },
  },

  "/api/hello/:name": async (req: Request) => {
    // Note: Bun's native Request doesn't have params
    // Extract from URL path instead
    const url = new URL(req.url)
    const pathParts = url.pathname.split("/")
    const name = pathParts[pathParts.length - 1]
    return Response.json({
      message: `Hello, ${name}!`,
    })
  },

  "/api/captions/status": {
    async GET(_req: Request) {
      return Response.json({
        active: true,
        captionsEnabled: true,
      })
    },
  },
}
