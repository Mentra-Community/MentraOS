import type { NextFunction, Request, Response } from 'express';
import { supabaseAdmin } from '../utils/supabase';
import jwt from 'jsonwebtoken';
import { logger } from '@augmentos/utils';
const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET || "";

// Define request with user info
export interface UserRequest extends Request {
  email: string;
}

/**
 * Middleware to validate Supabase token
 */
export const validateSupabaseToken = async (req: Request, res: Response, next: NextFunction) => {
  // Extract token from Authorization header
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      success: false,
      message: 'Missing or invalid Authorization header'
    });
    return;
  }

  const token = authHeader.substring(7); // Remove 'Bearer ' prefix

  try {
    // Verify token with Supabase
    const { data, error } = await supabaseAdmin.auth.getUser(token);

    if (error || !data.user || !data.user.email) {

      res.status(401).json({
        success: false,
        message: 'Invalid Supabase token'
      });
    }

    // Add user email to request object
    (req as UserRequest).email = data.user?.email?.toLowerCase() || '';

    next();
  } catch (error) {
    console.error('Supabase authentication error:', error);
    res.status(500).json({
      success: false,
      message: 'Authentication failed'
    });
  }
};


export const validateCoreToken = (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn('Auth Middleware: Missing or invalid Authorization header');
    res.status(401).json({ error: 'Authorization header missing or invalid' });
    return;
  }

  const token = authHeader.substring(7); // Remove 'Bearer ' prefix

  if (!token || token === 'null' || token === 'undefined') {
    logger.warn('Auth Middleware: Empty or invalid token value');
    res.status(401).json({ error: 'Invalid token' });
    return;
  }

  try {
    const decoded = jwt.verify(token, AUGMENTOS_AUTH_JWT_SECRET) as jwt.JwtPayload;

    if (!decoded || !decoded.email) {
      logger.warn('Auth Middleware: Missing email in token payload');
      res.status(401).json({ error: 'Invalid token data' });
      return;
    }

    // Attach userId (email) to the request object
    const email = decoded.email.toLowerCase();
    (req as UserRequest).email = email;
    logger.info(`Auth Middleware: User ${email} authenticated.`);
    next();

  } catch (error) {
    const jwtError = error as Error;
    logger.error('Auth Middleware: JWT verification failed:', jwtError);
    res.status(401).json({
      error: 'Invalid or expired token',
      message: jwtError.message
    });
  }
};
