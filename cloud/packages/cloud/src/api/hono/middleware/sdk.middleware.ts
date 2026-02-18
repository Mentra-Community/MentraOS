/**
 * @fileoverview Hono SDK authentication middleware.
 *
 * Authenticates requests using Authorization header:
 * Authorization: Bearer <packageName>:<MENTRAOS_APP_API_KEY>
 *
 * Usage:
 * - Apply to /api/sdk/* routes that require authentication
 * - Sets c.set("sdk", { packageName, apiKey }) on success
 */

import type { MiddlewareHandler } from "hono";
import { validateApiKey } from "../../../services/sdk/sdk.auth.service";
import { logger as rootLogger } from "../../../services/logging";
import type { AppEnv } from "../../../types/hono";

const SERVICE_NAME = "sdk.middleware";
const logger = rootLogger.child({ service: SERVICE_NAME });

/**
 * SDK authentication middleware.
 * - Requires Authorization: Bearer <packageName>:<apiKey>
 * - Validates API key against database
 * - Sets c.set("sdk", { packageName, apiKey }) on success
 */
export const authenticateSDK: MiddlewareHandler<AppEnv> = async (c, next) => {
  try {
    const authHeader = c.req.header("authorization");

    if (!authHeader) {
      return c.json(
        {
          error: "Missing Authorization header",
          message: "Authorization header is required for SDK requests",
        },
        401,
      );
    }

    // Check if header starts with "Bearer "
    if (!authHeader.startsWith("Bearer ")) {
      return c.json(
        {
          error: "Invalid Authorization format",
          message: "Authorization header must be in format: Bearer <packageName>:<apiKey>",
        },
        401,
      );
    }

    // Extract the token part after "Bearer "
    const token = authHeader.substring(7);

    // Split by colon to get packageName and apiKey
    const parts = token.split(":");

    if (parts.length !== 2) {
      return c.json(
        {
          error: "Invalid token format",
          message: "Token must be in format: <packageName>:<apiKey>",
        },
        401,
      );
    }

    const [packageName, apiKey] = parts;

    // Validate packageName and apiKey are not empty
    if (!packageName || !apiKey) {
      return c.json(
        {
          error: "Invalid credentials",
          message: "Both packageName and apiKey must be provided",
        },
        401,
      );
    }

    // Validate API key against database using SDK auth service (cached)
    const isValid = await validateApiKey(packageName, apiKey);
    if (!isValid) {
      return c.json(
        {
          error: "Invalid API key",
          message: "Provided API key is not valid for this packageName",
        },
        401,
      );
    }

    // Store authentication data in context for use by route handlers
    c.set("sdk", {
      packageName,
      apiKey,
    });
    // Include reqId for request correlation across all logs
    c.set("logger", logger.child({ packageName, context: "sdk", reqId: c.get("reqId") }));

    logger.debug(`SDK auth: Package ${packageName} authenticated`);
    await next();
  } catch (err) {
    logger.error(err, "SDK auth: Internal error during authentication");
    return c.json(
      {
        error: "Authentication failed",
        message: "Internal server error during authentication",
      },
      500,
    );
  }
};
