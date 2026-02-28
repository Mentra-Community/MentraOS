/**
 * CLI Authentication Middleware
 *
 * Verifies CLI API keys (JWTs with type='cli') and attaches `req.cli` context.
 * - Validates JWT signature
 * - Checks database for key revocation
 * - Tracks usage asynchronously
 * - Intended for /api/cli/* routes
 */

import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

import { CLITokenPayload } from "@mentra/types";

import { validateToken } from "../../services/console/cli-keys.service";

// Type declarations for req.cli are in src/types/express.d.ts

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
 * CLI authentication middleware
 * - Requires Authorization: Bearer <cli-api-key>
 * - Verifies JWT with type='cli'
 * - Checks database for revocation
 * - Attaches req.cli = { email, keyId, keyName, type }
 */
export const authenticateCLI = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const CLI_JWT_SECRET = getCLIJWTSecret();

    if (!CLI_JWT_SECRET) {
      return res.status(500).json({
        error: "Auth configuration error",
        message: "Missing CLI_AUTH_JWT_SECRET",
      });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Missing or invalid Authorization header",
        message: "Expected 'Authorization: Bearer <cli-api-key>'",
      });
    }

    const token = authHeader.substring(7);

    // Verify JWT signature
    let payload: CLITokenPayload;
    try {
      payload = jwt.verify(token, CLI_JWT_SECRET) as CLITokenPayload;
    } catch {
      return res.status(401).json({
        error: "Invalid or expired CLI API key",
        message: "Token verification failed",
      });
    }

    // Validate payload structure
    if (payload.type !== "cli" || !payload.email || !payload.keyId) {
      return res.status(401).json({
        error: "Invalid token payload",
        message: "Not a valid CLI API key",
      });
    }

    // Check if key is still active in database (revocation check)
    // Skip validation in test mode to avoid database dependency
    // TODO: Replace with proper test database setup
    const isTestMode = process.env.NODE_ENV === "test" || process.env.SKIP_CLI_DB_VALIDATION === "true";

    if (!isTestMode) {
      const isValid = await validateToken(token, payload);
      if (!isValid) {
        return res.status(401).json({
          error: "CLI API key revoked or expired",
          message: "This key is no longer valid",
        });
      }
    }

    // Attach CLI auth context
    req.cli = {
      email: payload.email.toLowerCase(),
      keyId: payload.keyId,
      keyName: payload.name,
      type: "cli",
    };

    return next();
  } catch (err) {
    console.error("CLI auth error:", err);
    return res.status(500).json({
      error: "Authentication failed",
      message: "Internal error during authentication",
    });
  }
};

// Export as array for convenience in route mounting
export const cliAuthMiddleware = [authenticateCLI];
