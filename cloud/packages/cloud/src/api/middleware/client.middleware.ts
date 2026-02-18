// middleware/client/client-auth-middleware.ts
// Auth middleware for AugmentOS clients (Mobile App, Appstore, developer console)
// Auth scenarios:
// 0. User sends valid JWT - populates req.email
// 1. User sends valid JWT - populates req.user
// 2. User sends valid JWT + has active session - populates req.user and req.userSession
// 3. User sends valid JWT + optional session - populates req.user and optional req.userSession

import { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { logger as rootLogger } from "../../services/logging";
import { User, UserI } from "../../models/user.model";
import UserSession from "../../services/session/UserSession";

const SERVICE_NAME = "client.middleware";
const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET || "";
const logger = rootLogger.child({ service: SERVICE_NAME });

// Ensure the JWT secret is defined
if (!AUGMENTOS_AUTH_JWT_SECRET) {
  logger.error(
    "AUGMENTOS_AUTH_JWT_SECRET is not defined in environment variables",
  );
  throw new Error(
    "AUGMENTOS_AUTH_JWT_SECRET is not defined in environment variables",
  );
}

// Define request types
export type RequestWithEmail = Request & {
  email: string;
  logger: typeof logger;
};

export type RequestWithUser = RequestWithEmail & {
  user: UserI;
};

export type RequestWithUserSession = RequestWithEmail & {
  userSession: UserSession;
};

// Base JWT auth - only populates email
async function clientAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    logger.warn("Auth Middleware: Missing or invalid Authorization header");
    logger.debug({ authHeader }, "Auth Middleware: Authorization header value");
    return res
      .status(401)
      .json({ error: "Authorization header missing or invalid" });
  }

  const token = authHeader.substring(7);

  if (!token || token === "null" || token === "undefined") {
    logger.warn("Auth Middleware: Empty or invalid token value");
    logger.debug({ token }, "Auth Middleware: Token value");
    return res.status(401).json({ error: "Invalid token" });
  }

  try {
    const decoded = jwt.verify(
      token,
      AUGMENTOS_AUTH_JWT_SECRET,
    ) as jwt.JwtPayload;

    if (!decoded || !decoded.email) {
      logger.warn("Auth Middleware: Missing email in token payload");
      logger.debug({ token }, "Auth Middleware: Token payload");
      return res.status(401).json({ error: "Invalid token data" });
    }

    const email = decoded.email.toLowerCase();
    (req as RequestWithEmail).email = email;
    (req as RequestWithEmail).logger = logger.child({ userId: email });
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
}

// Fetches user object
async function requireUser(req: Request, res: Response, next: NextFunction) {
  const authReq = req as RequestWithEmail;
  const logger = authReq.logger;

  try {
    const user = await User.findOrCreateUser(authReq.email);

    if (!user) {
      logger.warn(`requireUser: User not found for email: ${authReq.email}`);
      return res.status(401).json({ error: "User not found" });
    }

    (req as RequestWithUser).user = user;
    logger.info(`requireUser: User object populated for ${authReq.email}`);
    next();
  } catch (error) {
    logger.error(
      error,
      `requireUser: Failed to findOrCreateUser for email: ${authReq.email}`,
    );
    logger.debug(
      { req },
      `requireUser: Failed to findOrCreateUser for email: ${authReq.email}`,
    );
    return res.status(500).json({ error: "Internal server error" });
  }
}

// Fetches required user session
async function requireUserSession(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const userReq = req as RequestWithUser;
  const logger = userReq.logger;

  try {
    const userSession = UserSession.getById(userReq.email);

    if (!userSession) {
      logger.warn(
        `requireUserSession: No active session found for user: ${userReq.email}`,
      );
      return res.status(401).json({ error: "No active session found" });
    }

    (req as RequestWithUserSession).userSession = userSession;
    logger.info(
      `requireUserSession: User session populated for ${userReq.email}`,
    );
    next();
  } catch (error) {
    logger.error(
      error,
      `requireUserSession: Failed to fetch session for user: ${userReq.email}`,
    );
    return res.status(500).json({ error: "Internal server error" });
  }
}

// Simplified middleware composition - let Express handle the chain
export const clientAuthWithEmail = [clientAuth];
export const clientAuthWithUser = [clientAuth, requireUser];
export const clientAuthWithUserSession = [clientAuth, requireUserSession];
