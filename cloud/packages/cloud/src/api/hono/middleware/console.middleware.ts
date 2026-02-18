/**
 * @fileoverview Hono console authentication middleware.
 *
 * Verifies an Authorization bearer token and sets c.set("console", { email }).
 * - No database calls or organization resolution.
 * - Intended for /api/console/* routes.
 *
 * Token verification uses:
 * - process.env.CONSOLE_AUTH_JWT_SECRET, or
 * - process.env.AUGMENTOS_AUTH_JWT_SECRET (fallback)
 */

import type { MiddlewareHandler } from "hono";
import jwt from "jsonwebtoken";
import { logger as rootLogger } from "../../../services/logging";
import type { AppEnv } from "../../../types/hono";

const SERVICE_NAME = "console.middleware";
const logger = rootLogger.child({ service: SERVICE_NAME });

const CONSOLE_JWT_SECRET = process.env.CONSOLE_AUTH_JWT_SECRET || process.env.AUGMENTOS_AUTH_JWT_SECRET || "";

/**
 * Console authentication middleware.
 * - Requires Authorization: Bearer <coreToken>
 * - Verifies JWT using CONSOLE_JWT_SECRET/AUGMENTOS_AUTH_JWT_SECRET
 * - Extracts `email` from payload and sets c.set("console", { email })
 */
export const authenticateConsole: MiddlewareHandler<AppEnv> = async (c, next) => {
  try {
    if (!CONSOLE_JWT_SECRET) {
      logger.error("Missing CONSOLE_AUTH_JWT_SECRET/AUGMENTOS_AUTH_JWT_SECRET");
      return c.json(
        {
          error: "Auth configuration error",
          message: "Missing CONSOLE_AUTH_JWT_SECRET/AUGMENTOS_AUTH_JWT_SECRET",
        },
        500,
      );
    }

    const authHeader = c.req.header("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json(
        {
          error: "Missing or invalid Authorization header",
          message: "Expected 'Authorization: Bearer <token>'",
        },
        401,
      );
    }

    const token = authHeader.substring(7);

    let payload: string | jwt.JwtPayload;
    try {
      payload = jwt.verify(token, CONSOLE_JWT_SECRET);
    } catch (err) {
      logger.debug({ err }, "Console auth: Token verification failed");
      return c.json(
        {
          error: "Invalid or expired token",
          message: "Token verification failed",
        },
        401,
      );
    }

    const email = typeof payload === "object" && typeof payload.email === "string" ? payload.email.toLowerCase() : null;

    if (!email) {
      return c.json(
        {
          error: "Invalid token payload",
          message: "Email not found in token",
        },
        401,
      );
    }

    // Attach auth context for console routes
    c.set("console", { email });
    // Include reqId for request correlation across all logs
    c.set("logger", logger.child({ userId: email, context: "console", reqId: c.get("reqId") }));

    logger.debug(`Console auth: User ${email} authenticated`);
    await next();
  } catch (err) {
    logger.error(err, "Console auth: Internal error during authentication");
    return c.json(
      {
        error: "Authentication failed",
        message: "Internal error during authentication",
      },
      500,
    );
  }
};
