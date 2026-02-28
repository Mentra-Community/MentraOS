import { NextFunction, Request, Response } from "express";
import { supabaseAdmin } from "../utils/supabase";
import jwt from "jsonwebtoken";
import { logger } from "../services/logging/pino-logger";
const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET || "";

// Define request with user info
export interface UserRequest extends Request {
  email: string;
}

// TODO(isaiah): It doen't seem like this is used anywhere, so we can remove it, double check if we can remove this safely.
/**
 * Middleware to validate Supabase token
 */
export const validateSupabaseToken = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  // Extract token from Authorization header
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      message: "Missing or invalid Authorization header",
    });
  }

  const token = authHeader.substring(7); // Remove 'Bearer ' prefix

  try {
    // Verify token with Supabase
    const { data, error } = await supabaseAdmin.auth.getUser(token);

    if (error || !data.user || !data.user.email) {
      return res.status(401).json({
        success: false,
        message: "Invalid Supabase token",
      });
    }

    // Add user email to request object
    (req as UserRequest).email = data.user.email.toLowerCase();

    next();
  } catch (error) {
    console.error("Supabase authentication error:", error);
    return res.status(500).json({
      success: false,
      message: "Authentication failed",
    });
  }
};

// TODO(isaiah): Depricate this, and replace all usages with middleware/client/client-auth-middleware.ts authWithEmail.
export const validateCoreToken = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    logger.warn("Auth Middleware: Missing or invalid Authorization header");
    return res
      .status(401)
      .json({ error: "Authorization header missing or invalid" });
  }

  const token = authHeader.substring(7); // Remove 'Bearer ' prefix

  if (!token || token === "null" || token === "undefined") {
    logger.warn("Auth Middleware: Empty or invalid token value");
    return res.status(401).json({ error: "Invalid token" });
  }

  try {
    const decoded = jwt.verify(
      token,
      AUGMENTOS_AUTH_JWT_SECRET,
    ) as jwt.JwtPayload;

    if (!decoded || !decoded.email) {
      logger.warn("Auth Middleware: Missing email in token payload");
      return res.status(401).json({ error: "Invalid token data" });
    }

    // Attach userId (email) to the request object
    const email = decoded.email.toLowerCase();
    (req as UserRequest).email = email;
    logger.info(`Auth Middleware: User ${email} authenticated.`);
    next();
  } catch (error) {
    const jwtError = error as Error;
    logger.error(jwtError, "Auth Middleware: JWT verification failed:");
    return res.status(401).json({
      error: "Invalid or expired token",
      message: jwtError.message,
    });
  }
};
