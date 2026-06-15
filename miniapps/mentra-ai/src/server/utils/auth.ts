/**
 * Auth helpers for the Hono API layer.
 *
 * Two middlewares form the gate:
 *
 *   requireAuth     401 if no authenticated user. Re-exposes the
 *                   id from the SDK's authUserId under the
 *                   friendlier name `userId`.
 *   requireSession  404 if the authenticated user has no live
 *                   User in the SessionManager. Sets `user`.
 *
 * Sub-apps in routes.ts mount these. Handlers then declare which
 * variables they need by typing their Context parameter as
 * AuthContext or SessionContext.
 *
 * See issues/auth-by-default for the full rationale.
 */

import type { Context, MiddlewareHandler } from "hono";

import { sessions } from "../manager/SessionManager";
import type { User } from "../session/User";

/**
 * Context shape after requireAuth has run. The userId is the
 * authenticated user's id, never undefined.
 */
export type AuthContext = Context<{ Variables: { userId: string } }>;

/**
 * Context shape after both requireAuth and requireSession have run.
 * The user is a live User runtime object, never null.
 */
export type SessionContext = Context<{
  Variables: { userId: string; user: User };
}>;

/**
 * Require an authenticated user. The SDK's createAuthMiddleware ran
 * first (mounted globally by AppServer) and set authUserId if the
 * request had a valid token. This 401s if it did not.
 */
export const requireAuth: MiddlewareHandler<{
  Variables: { userId: string };
}> = async (c, next) => {
  const userId = c.get("authUserId" as never) as string | undefined;
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  c.set("userId", userId);
  await next();
};

/**
 * Require a live User in the SessionManager. Mount on a sub-app
 * after requireAuth. Returns 404 if the user is not currently
 * tracked (typically because glasses have never connected this
 * boot, or were hard-disconnected).
 */
export const requireSession: MiddlewareHandler<{
  Variables: { userId: string; user: User };
}> = async (c, next) => {
  const userId = c.get("userId");
  const user = sessions.get(userId);
  if (!user) return c.json({ error: "No active session" }, 404);
  c.set("user", user);
  await next();
};
