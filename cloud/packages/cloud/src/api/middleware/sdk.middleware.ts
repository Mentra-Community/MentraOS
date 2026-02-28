import { Request, Response, NextFunction } from "express";

import { validateApiKey } from "../../services/sdk/sdk.auth.service";

// Type declarations for req.sdk are in src/types/express.d.ts

/**
 * SDK Authentication Middleware
 *
 * Authenticates requests using Authorization header:
 * Authorization: Bearer <packageName>:<MENTRAOS_APP_API_KEY>
 *
 * Usage:
 * - Apply to /api/sdk/* routes that require authentication (right now only applied to sdkAuthMiddleware)
 * - Populates req.sdkAuth with packageName and apiKey
 */
export const authenticateSDK = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        error: "Missing Authorization header",
        message: "Authorization header is required for SDK requests",
      });
    }

    // Check if header starts with "Bearer "
    if (!authHeader.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Invalid Authorization format",
        message: "Authorization header must be in format: Bearer <packageName>:<apiKey>",
      });
    }

    // Extract the token part after "Bearer "
    const token = authHeader.substring(7);

    // Split by colon to get packageName and apiKey
    const parts = token.split(":");

    if (parts.length !== 2) {
      return res.status(401).json({
        error: "Invalid token format",
        message: "Token must be in format: <packageName>:<apiKey>",
      });
    }

    const [packageName, apiKey] = parts;

    // Validate packageName and apiKey are not empty
    if (!packageName || !apiKey) {
      return res.status(401).json({
        error: "Invalid credentials",
        message: "Both packageName and apiKey must be provided",
      });
    }

    // Validate API key against database using SDK auth service (cached)
    const isValid = await validateApiKey(packageName, apiKey);
    if (!isValid) {
      return res.status(401).json({
        error: "Invalid API key",
        message: "Provided API key is not valid for this packageName",
      });
    }

    // Store authentication data in request for use by route handlers
    req.sdk = {
      packageName,
      apiKey,
    };

    // Continue to next middleware/route handler
    next();
  } catch (error) {
    console.error("SDK authentication error:", error);
    return res.status(500).json({
      error: "Authentication failed",
      message: "Internal server error during authentication",
    });
  }
};

// Combine common middleware for SDK routes
export const sdkAuthMiddleware = [authenticateSDK];
