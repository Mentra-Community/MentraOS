/**
 * @fileoverview Hono CLI authentication middleware.
 *
 * Verifies CLI API keys (JWTs with type='cli') and sets c.set("cli", { ... }) context.
 * - Validates JWT signature
 * - Checks database for key revocation
 * - Tracks usage asynchronously
 * - Intended for /api/cli/* routes
 */

import type { MiddlewareHandler } from "hono";
import jwt from "jsonwebtoken";
import { CLITokenPayload } from "@mentra/types";
import { validateToken } from "../../../services/console/cli-keys.service";
import { logger as rootLogger } from "../../../services/logging";
import type { AppEnv } from "../../../types/hono";

const SERVICE_NAME = "cli.middleware";
const logger = rootLogger.child({ service: SERVICE_NAME });

/**
 * Get CLI JWT secret dynamically to support testing with env vars
 */
const getCLIJWTSecret = (): string => {
  return (
    process.env.CLI_AUTH_JWT_SECRET ||
    process.env.CONSOLE_AUTH_JWT_SECRET ||
    process.env.AUGMENTOS_AUTH_JWT_SECRET ||
    ""
  );
};

/**
 * CLI authentication middleware.
 * - Requires Authorization: Bearer <cli-api-key>
 * - Verifies JWT with type='cli'
 * - Checks database for revocation
 * - Sets c.set("cli", { id, email, orgId, keyName })
 */
export const authenticateCLI: MiddlewareHandler<AppEnv> = async (c, next) => {
  try {
    const CLI_JWT_SECRET = getCLIJWTSecret();

    if (!CLI_JWT_SECRET) {
      logger.error("Missing CLI_AUTH_JWT_SECRET");
      return c.json(
        {
          error: "Auth configuration error",
          message: "Missing CLI_AUTH_JWT_SECRET",
        },
        500,
      );
    }

    const authHeader = c.req.header("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json(
        {
          error: "Missing or invalid Authorization header",
          message: "Expected 'Authorization: Bearer <cli-api-key>'",
        },
        401,
      );
    }

    const token = authHeader.substring(7);

    // Verify JWT signature
    let payload: CLITokenPayload;
    try {
      payload = jwt.verify(token, CLI_JWT_SECRET) as CLITokenPayload;
    } catch (err) {
      logger.debug({ err }, "CLI auth: Token verification failed");
      return c.json(
        {
          error: "Invalid or expired CLI API key",
          message: "Token verification failed",
        },
        401,
      );
    }

    // Validate payload structure
    if (payload.type !== "cli" || !payload.email || !payload.keyId) {
      return c.json(
        {
          error: "Invalid token payload",
          message: "Not a valid CLI API key",
        },
        401,
      );
    }

    // Check if key is still active in database (revocation check)
    // Skip validation in test mode to avoid database dependency
    const isTestMode = process.env.NODE_ENV === "test" || process.env.SKIP_CLI_DB_VALIDATION === "true";

    if (!isTestMode) {
      const isValid = await validateToken(token, payload);
      if (!isValid) {
        return c.json(
          {
            error: "CLI API key revoked or expired",
            message: "This key is no longer valid",
          },
          401,
        );
      }
    }

    // Attach CLI auth context
    const email = payload.email.toLowerCase();
    c.set("cli", {
      id: payload.keyId,
      email,
      orgId: "", // CLITokenPayload doesn't have orgId - will be resolved from user if needed
    });
    c.set("logger", logger.child({ userId: email, keyId: payload.keyId, context: "cli" }));

    logger.debug(`CLI auth: User ${email} authenticated with key ${payload.keyId}`);
    await next();
  } catch (err) {
    logger.error(err, "CLI auth: Internal error during authentication");
    return c.json(
      {
        error: "Authentication failed",
        message: "Internal error during authentication",
      },
      500,
    );
  }
};

/**
 * Transform middleware: copies cli context to console context.
 * Useful for reusing console route handlers with CLI auth.
 */
export const transformCLIToConsole: MiddlewareHandler<AppEnv> = async (c, next) => {
  const cli = c.get("cli");
  if (cli) {
    c.set("console", { email: cli.email });
  }
  await next();
};
