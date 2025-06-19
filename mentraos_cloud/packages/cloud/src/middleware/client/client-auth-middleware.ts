// This file contains any auth middleware used by any AugmentOS client, such as the Mobile App, Appstore, developer console.
// Auth scenarios.

// 0. User is logged in, and sends a valid JWT (coreToken) token in the Authorization header, does not need to user db object populated. (will populate request with req.email of type string)
// 1. User is logged in, and sends a valid JWT (coreToken) token in the Authorization header. (will populate request with req.user of type UserI)
// 2. User is logged in, and sends a valid JWT (coreToken) token in the Authorization header, and has an active UserSession on the server. (will populate request with req.user and req.userSession)
// 3. User is logged in, and sends a valid JWT (coreToken) token in the Authorization header, and having a UserSession is optional. (will populate request with req.user and optional req.userSession?)

import { NextFunction, Request, Response } from "express";
import jwt from 'jsonwebtoken';
import { logger as rootLogger } from '../../services/logging';
// import { ExtendedUserSession } from "../../services/processing/transcription.service";
import { User, UserI } from "../../models/user.model";
import { sessionService } from "../../services/session/session.service";
import UserSession from "../../services/session/UserSession";
// Import your user service/model functions
// import { getUserByEmail } from '../../services/user.service';
// import { getUserSession, getOptionalUserSession } from '../../services/session.service';

const SERVICE_NAME = 'client-auth-middleware';
const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET || "";
const logger = rootLogger.child({ service: SERVICE_NAME });

// Ensure the JWT secret is defined
if (!AUGMENTOS_AUTH_JWT_SECRET) {
  logger.error('AUGMENTOS_AUTH_JWT_SECRET is not defined in environment variables');
  throw new Error('AUGMENTOS_AUTH_JWT_SECRET is not defined in environment variables');
}

// Define request interfaces that extend each other
export interface AuthRequest extends Request {
  email: string; // User's email, used as userId
  logger: typeof logger; // Logger instance for this request
}

export interface UserRequest extends AuthRequest {
  user: UserI; // User object, populated after authentication
}

export interface UserSessionRequest extends UserRequest {
  userSession: UserSession; // Required user session, populated if available, returns 401 if not found.
}

export interface OptionalUserSessionRequest extends UserRequest {
  userSession?: UserSession; // Optional user session, may or may not be present
}

// Internal helper to promisify middleware execution
function runMiddleware(middleware: Function, req: Request, res: Response): Promise<void> {
  return new Promise((resolve, reject) => {
    middleware(req, res, (error?: any) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

// Base JWT auth - only populates email (internal function)
async function clientAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn('Auth Middleware: Missing or invalid Authorization header');
    logger.debug({ authHeader }, 'Auth Middleware: Authorization header value');
    return res.status(401).json({ error: 'Authorization header missing or invalid' });
  }

  const token = authHeader.substring(7); // Remove 'Bearer ' prefix

  if (!token || token === 'null' || token === 'undefined') {
    logger.warn('Auth Middleware: Empty or invalid token value');
    logger.debug({ token }, 'Auth Middleware: Token value');
    return res.status(401).json({ error: 'Invalid token' });
  }

  try {
    const decoded = jwt.verify(token, AUGMENTOS_AUTH_JWT_SECRET) as jwt.JwtPayload;

    if (!decoded || !decoded.email) {
      logger.warn('Auth Middleware: Missing email in token payload');
      logger.debug({ token }, 'Auth Middleware: Token payload');
      return res.status(401).json({ error: 'Invalid token data' });
    }

    // Attach userId (email) to the request object
    const email = decoded.email.toLowerCase();
    (req as AuthRequest).email = email;
    (req as AuthRequest).logger = logger.child({ userId: email });
    logger.info(`Auth Middleware: User ${email} authenticated.`);
    next();

  } catch (error) {
    const jwtError = error as Error;
    logger.error(jwtError, 'Auth Middleware: JWT verification failed:');
    return res.status(401).json({
      error: 'Invalid or expired token',
      message: jwtError.message
    });
  }
}

// Fetches user object (internal function)
async function requireUser(req: Request, res: Response, next: NextFunction) {
  const authReq = req as AuthRequest;
  const logger = authReq.logger;

  try {
    // Fetch user from database using email or create if not found (new user).
    const user = await User.findOrCreateUser(authReq.email);

    if (!user) {
      logger.warn(`requireUser: User not found for email: ${authReq.email}`);
      return res.status(401).json({ error: 'User not found' });
    }

    // Attach user to request
    (req as UserRequest).user = user;
    logger.info(`requireUser: User object populated for ${authReq.email}`);
    next();

  } catch (error) {
    logger.error(error, `requireUser: Failed to findOrCreateUser for email: ${authReq.email}`);
    logger.debug({ req }, `requireUser: Failed to findOrCreateUser for email: ${authReq.email}`)
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// Fetches required user session (internal function)
async function requireUserSession(req: Request, res: Response, next: NextFunction) {
  const userReq = req as UserRequest;
  const logger = userReq.logger;

  try {
    // Fetch user session from database/cache
    const userSession = sessionService.getSessionByUserId(userReq.email);

    if (!userSession) {
      logger.warn(`requireUserSession: No active session found for user: ${userReq.email}`);
      return res.status(401).json({ error: 'No active session found' });
    }

    // Attach session to request
    (req as UserSessionRequest).userSession = userSession;
    logger.info(`requireUserSession: User session populated for ${userReq.email}`);
    next();

  } catch (error) {
    logger.error(error, `requireUserSession: Failed to fetch session for user: ${userReq.email}`);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// Fetches optional user session (internal function)
async function optionalUserSession(req: Request, res: Response, next: NextFunction) {
  const userReq = req as UserRequest;
  const logger = userReq.logger;

  try {
    // Try to fetch user session, but don't fail if not found
    const userSession = sessionService.getSessionByUserId(userReq.email);

    if (userSession) {
      (req as OptionalUserSessionRequest).userSession = userSession;
      logger.info(`optionalUserSession: User session populated for ${userReq.email}`);
    } else {
      logger.info(`optionalUserSession: No session found for ${userReq.email}, continuing without session`);
    }

    next();
  } catch (error) {
    logger.error(error, `optionalUserSession: Failed to fetch session for user: ${userReq.email}`);
    // Don't fail the request, just continue without session
    next();
  }
}

// PUBLIC API - Each middleware calls its dependencies internally
export async function authWithEmail(req: Request, res: Response, next: NextFunction) {
  try {
    await runMiddleware(clientAuth, req, res);
    next();
  } catch (error) {
    // Error already handled by clientAuth middleware
  }
}

export async function authWithUser(req: Request, res: Response, next: NextFunction) {
  try {
    // Run clientAuth first
    await runMiddleware(clientAuth, req, res);
    // Then run requireUser
    await runMiddleware(requireUser, req, res);
    next();
  } catch (error) {
    // Error already handled by the middleware that failed
  }
}

export async function authWithRequiredSession(req: Request, res: Response, next: NextFunction) {
  try {
    // Run clientAuth first
    await runMiddleware(clientAuth, req, res);
    // Then run requireUser
    await runMiddleware(requireUser, req, res);
    // Finally run requireUserSession
    await runMiddleware(requireUserSession, req, res);
    next();
  } catch (error) {
    // Error already handled by the middleware that failed
  }
}

export async function authWithOptionalSession(req: Request, res: Response, next: NextFunction) {
  try {
    // Run clientAuth first
    await runMiddleware(clientAuth, req, res);
    // Then run requireUser
    await runMiddleware(requireUser, req, res);
    // Finally run optionalUserSession
    await runMiddleware(optionalUserSession, req, res);
    next();
  } catch (error) {
    // Error already handled by the middleware that failed
  }
}

// Usage examples:
/*
import express from 'express';
import { authWithEmail, authWithUser, authWithRequiredSession, authWithOptionalSession } from './auth.middleware';

const app = express();

// Scenario 0: Only email needed
app.get('/ping', authWithEmail, (req: AuthRequest, res) => {
  res.json({ message: `Hello ${req.email}` });
});

// Scenario 1: User object needed
app.get('/profile', authWithUser, (req: UserRequest, res) => {
  res.json({ user: req.user });
});

// Scenario 2: User and required session
app.get('/dashboard', authWithRequiredSession, (req: UserSessionRequest, res) => {
  res.json({ 
    user: req.user, 
    session: req.userSession 
  });
});

// Scenario 3: User with optional session
app.get('/settings', authWithOptionalSession, (req: OptionalUserSessionRequest, res) => {
  res.json({ 
    user: req.user, 
    session: req.userSession || null 
  });
});
*/