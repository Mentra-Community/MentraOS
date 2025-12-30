import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

/**
 * Console Authentication Middleware
 *
 * Verifies an Authorization bearer token and attaches `req.console = { email }`.
 * - No database calls or organization resolution.
 * - Intended for /api/console/* routes.
 *
 * Token verification uses:
 * - process.env.CONSOLE_AUTH_JWT_SECRET, or
 * - process.env.AUGMENTOS_AUTH_JWT_SECRET (fallback)
 */

// Type declarations for req.console are in src/types/express.d.ts

const CONSOLE_JWT_SECRET = process.env.CONSOLE_AUTH_JWT_SECRET || process.env.AUGMENTOS_AUTH_JWT_SECRET || "";

/**
 * Minimal console auth middleware:
 * - Requires Authorization: Bearer <coreToken>
 * - Verifies JWT using CONSOLE_JWT_SECRET/AUGMENTOS_AUTH_JWT_SECRET
 * - Extracts `email` from payload and sets `req.console = { email }`
 */
export const authenticateConsole = async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!CONSOLE_JWT_SECRET) {
      return res.status(500).json({
        error: "Auth configuration error",
        message: "Missing CONSOLE_AUTH_JWT_SECRET/AUGMENTOS_AUTH_JWT_SECRET",
      });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Missing or invalid Authorization header",
        message: "Expected 'Authorization: Bearer <token>'",
      });
    }

    const token = authHeader.substring(7);

    let payload: string | jwt.JwtPayload;
    try {
      payload = jwt.verify(token, CONSOLE_JWT_SECRET);
    } catch {
      return res.status(401).json({
        error: "Invalid or expired token",
        message: "Token verification failed",
      });
    }

    const email = typeof payload === "object" && typeof payload.email === "string" ? payload.email.toLowerCase() : null;

    if (!email) {
      return res.status(401).json({
        error: "Invalid token payload",
        message: "Email not found in token",
      });
    }

    // Attach auth context for console routes
    req.console = { email };

    return next();
  } catch {
    return res.status(500).json({
      error: "Authentication failed",
      message: "Internal error during authentication",
    });
  }
};

// Export as an array for convenience in per-route middleware usage
export const consoleAuthMiddleware = [authenticateConsole];
