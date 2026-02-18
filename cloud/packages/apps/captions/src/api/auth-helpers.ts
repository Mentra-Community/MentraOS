/**
 * Auth Helper Utilities for Bun API Routes
 *
 * These helpers extract authentication information that was forwarded
 * from the Express auth middleware via headers.
 *
 * Usage in Bun routes:
 * ```typescript
 * import { getAuthUserId, requireAuth } from "./auth-helpers"
 *
 * "/api/me": {
 *   async GET(req: Request) {
 *     const userId = getAuthUserId(req)
 *     if (!userId) {
 *       return Response.json({ error: "Not authenticated" }, { status: 401 })
 *     }
 *     return Response.json({ userId, authenticated: true })
 *   }
 * }
 *
 * // Or use the requireAuth wrapper:
 * "/api/profile": requireAuth(async (req: Request, userId: string) => {
 *   return Response.json({ userId, message: "This route is protected" })
 * })
 * ```
 */

/**
 * Extract authenticated user ID from request headers
 *
 * The Express auth middleware sets `req.authUserId` which gets forwarded
 * to Bun routes as the `x-auth-user-id` header.
 *
 * @param req - The Bun Request object
 * @returns The authenticated user ID, or null if not authenticated
 */
export function getAuthUserId(req: Request): string | null {
  return req.headers.get("x-auth-user-id")
}

/**
 * Check if the request has an active MentraOS session
 *
 * @param req - The Bun Request object
 * @returns true if there's an active session, false otherwise
 */
export function hasActiveSession(req: Request): boolean {
  return req.headers.get("x-has-active-session") === "true"
}

/**
 * Response builder for authentication errors
 *
 * @param message - Optional custom error message
 * @returns A 401 Unauthorized response
 */
export function unauthorizedResponse(message = "Not authenticated"): Response {
  return Response.json(
    {
      error: "Unauthorized",
      message,
    },
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
      },
    },
  )
}

/**
 * Higher-order function that wraps a route handler to require authentication
 *
 * If the user is not authenticated, returns a 401 response.
 * Otherwise, calls the handler with the request and userId.
 *
 * @param handler - The route handler function that receives (req, userId)
 * @returns A route handler that checks auth first
 *
 * @example
 * ```typescript
 * "/api/protected": requireAuth(async (req, userId) => {
 *   return Response.json({ userId, data: "secret stuff" })
 * })
 * ```
 */
export function requireAuth(
  handler: (req: Request, userId: string) => Promise<Response> | Response,
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const userId = getAuthUserId(req)

    if (!userId) {
      return unauthorizedResponse()
    }

    return await handler(req, userId)
  }
}

/**
 * Higher-order function for routes that optionally use auth
 *
 * Calls the handler with the request and userId (which may be null).
 *
 * @param handler - The route handler function that receives (req, userId | null)
 * @returns A route handler
 *
 * @example
 * ```typescript
 * "/api/public": optionalAuth(async (req, userId) => {
 *   if (userId) {
 *     return Response.json({ message: "Hello, authenticated user!", userId })
 *   }
 *   return Response.json({ message: "Hello, anonymous user!" })
 * })
 * ```
 */
export function optionalAuth(
  handler: (req: Request, userId: string | null) => Promise<Response> | Response,
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const userId = getAuthUserId(req)
    return await handler(req, userId)
  }
}

/**
 * Extract user info from request (auth + session status)
 *
 * @param req - The Bun Request object
 * @returns Object with userId and hasSession
 */
export function getAuthInfo(req: Request): {
  userId: string | null
  hasSession: boolean
  isAuthenticated: boolean
} {
  const userId = getAuthUserId(req)
  const hasSession = hasActiveSession(req)

  return {
    userId,
    hasSession,
    isAuthenticated: !!userId,
  }
}
