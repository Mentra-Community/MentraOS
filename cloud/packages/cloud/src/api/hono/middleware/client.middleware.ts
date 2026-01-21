/**
 * @fileoverview Hono client authentication middleware.
 * Auth middleware for AugmentOS clients (Mobile App, Appstore, developer console)
 *
 * Auth scenarios:
 * 0. User sends valid JWT - populates c.set("email")
 * 1. User sends valid JWT - populates c.set("user")
 * 2. User sends valid JWT + has active session - populates c.set("user") and c.set("userSession")
 * 3. User sends valid JWT + optional session - populates c.set("user") and optional c.set("userSession")
 */

import type { MiddlewareHandler } from "hono";
import jwt from "jsonwebtoken";
import { logger as rootLogger } from "../../../services/logging";
import { User } from "../../../models/user.model";
import UserSession from "../../../services/session/UserSession";
import type { AppEnv } from "../../../types/hono";

const SERVICE_NAME = "client.middleware";
const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET || "";
const logger = rootLogger.child({ service: SERVICE_NAME });

// Ensure the JWT secret is defined
if (!AUGMENTOS_AUTH_JWT_SECRET) {
  logger.error("AUGMENTOS_AUTH_JWT_SECRET is not defined in environment variables");
  throw new Error("AUGMENTOS_AUTH_JWT_SECRET is not defined in environment variables");
}

/**
 * Base JWT auth middleware - only populates email.
 * Sets c.get("email") and c.get("logger") on success.
 */
export const clientAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const authHeader = c.req.header("authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    logger.warn("Auth Middleware: Missing or invalid Authorization header");
    logger.debug({ authHeader }, "Auth Middleware: Authorization header value");
    return c.json({ error: "Authorization header missing or invalid" }, 401);
  }

  const token = authHeader.substring(7);

  if (!token || token === "null" || token === "undefined") {
    logger.warn("Auth Middleware: Empty or invalid token value");
    logger.debug({ token }, "Auth Middleware: Token value");
    return c.json({ error: "Invalid token" }, 401);
  }

  try {
    const decoded = jwt.verify(token, AUGMENTOS_AUTH_JWT_SECRET) as jwt.JwtPayload;

    if (!decoded || !decoded.email) {
      logger.warn("Auth Middleware: Missing email in token payload");
      logger.debug({ token }, "Auth Middleware: Token payload");
      return c.json({ error: "Invalid token data" }, 401);
    }

    const email = decoded.email.toLowerCase();
    c.set("email", email);
    // Include reqId for request correlation across all logs
    c.set("logger", logger.child({ userId: email, reqId: c.get("reqId") }));
    await next();
  } catch (error) {
    const jwtError = error as Error;
    logger.error(jwtError, "Auth Middleware: JWT verification failed:");
    return c.json(
      {
        error: "Invalid or expired token",
        message: jwtError.message,
      },
      401,
    );
  }
};

/**
 * Middleware that fetches and populates the user object.
 * Must be used after clientAuth.
 * Sets c.get("user") on success.
 */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  const email = c.get("email");
  const reqLogger = c.get("logger") || logger;

  if (!email) {
    reqLogger.warn("requireUser: No email in context - clientAuth middleware missing?");
    return c.json({ error: "Authentication required" }, 401);
  }

  try {
    const user = await User.findOrCreateUser(email);

    if (!user) {
      reqLogger.warn(`requireUser: User not found for email: ${email}`);
      return c.json({ error: "User not found" }, 401);
    }

    c.set("user", user);
    reqLogger.debug("User object populated");
    await next();
  } catch (error) {
    reqLogger.error(error, `requireUser: Failed to findOrCreateUser for email: ${email}`);
    return c.json({ error: "Internal server error" }, 500);
  }
};

/**
 * Middleware that fetches and populates the user session.
 * Must be used after clientAuth.
 * Sets c.get("userSession") on success, returns 401 if no session found.
 */
export const requireUserSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const email = c.get("email");
  const reqLogger = c.get("logger") || logger;

  if (!email) {
    reqLogger.warn("requireUserSession: No email in context - clientAuth middleware missing?");
    return c.json({ error: "Authentication required" }, 401);
  }

  try {
    const userSession = UserSession.getById(email);

    if (!userSession) {
      reqLogger.warn(`requireUserSession: No active session found for user: ${email}`);
      return c.json({ error: "No active session found" }, 401);
    }

    c.set("userSession", userSession);
    reqLogger.debug("User session populated");
    await next();
  } catch (error) {
    reqLogger.error(error, `requireUserSession: Failed to fetch session for user: ${email}`);
    return c.json({ error: "Internal server error" }, 500);
  }
};

/**
 * Optional user session middleware - populates session if available but doesn't fail if not.
 * Must be used after clientAuth.
 * Sets c.get("userSession") if session exists, otherwise continues without it.
 */
export const optionalUserSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const email = c.get("email");
  const reqLogger = c.get("logger") || logger;

  if (!email) {
    await next();
    return;
  }

  try {
    const userSession = UserSession.getById(email);

    if (userSession) {
      c.set("userSession", userSession);
      reqLogger.debug(`optionalUserSession: User session populated for ${email}`);
    }
  } catch (error) {
    reqLogger.warn(error, `optionalUserSession: Failed to fetch session for user: ${email}`);
    // Continue without session - it's optional
  }

  await next();
};
