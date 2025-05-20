//backend/src/routes/apps.ts
import express from 'express';

import jwt from 'jsonwebtoken';
import { Request, Response } from 'express';
import { validateCoreToken } from '../middleware/supabaseMiddleware';
import { tokenService } from '../services/core/temp-token.service';
import { validateTpaApiKey } from '../middleware/validateApiKey';
import { logger as rootLogger } from '../services/logging/pino-logger';
const logger = rootLogger.child({ module: 'auth.routes' });
import appService from '../services/core/app.service';

const router = express.Router();

export const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET || "";
export const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET || "";
export const JOE_MAMA_USER_JWT = process.env.JOE_MAMA_USER_JWT || "";

router.post('/exchange-token', async (req: Request, res: Response) => {
  const { supabaseToken } = req.body;
  if (!supabaseToken) {
    return res.status(400).json({ error: 'No token provided' });
  }

  try {
    // Verify the token using your Supabase JWT secret
    const decoded = jwt.verify(supabaseToken, SUPABASE_JWT_SECRET);
    const subject = decoded.sub;
    // `decoded` will contain the user’s claims from Supabase
    // e.g. user ID, role, expiration, etc.

    const newData = {
        sub: subject,
        email: (decoded as jwt.JwtPayload).email,
    }

    // Generate your own custom token (JWT or otherwise)
    const coreToken = jwt.sign(newData, AUGMENTOS_AUTH_JWT_SECRET);

    return res.json({ coreToken });
  } catch (error) {
    console.error('Token verification error:', error);
    return res.status(401).json({ error: 'Invalid token' });
  }
});

// Generate a temporary token for webview authentication
router.post('/generate-webview-token', validateCoreToken, async (req: Request, res: Response) => {
  const userId = (req as any).email; // Use the email property set by validateCoreToken
  const { packageName } = req.body;

  if (!packageName) {
    return res.status(400).json({ success: false, error: 'packageName is required' });
  }

  try {
    const tempToken = await tokenService.generateTemporaryToken(userId, packageName);
    res.json({ success: true, token: tempToken });
  } catch (error) {
    logger.error({ error, userId, packageName }, 'Failed to generate webview token');
    res.status(500).json({ success: false, error: 'Failed to generate token' });
  }
});

// Exchange a temporary token for user details (called by TPA backend)
router.post('/exchange-user-token', validateTpaApiKey, async (req: Request, res: Response) => {
  const { aos_temp_token, packageName } = req.body;

  if (!aos_temp_token) {
    return res.status(400).json({ success: false, error: 'Missing aos_temp_token' });
  }

  try {
    const result = await tokenService.exchangeTemporaryToken(aos_temp_token, packageName);

    if (result) {
      res.json({ success: true, userId: result.userId });
    } else {
      // Determine specific error based on logs or tokenService implementation
      // For simplicity now, returning 401 for any failure
      res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }
  } catch (error) {
    logger.error({ error, packageName }, 'Failed to exchange webview token');
    res.status(500).json({ success: false, error: 'Failed to exchange token' });
  }
});

// Exchange a temporary token for full tokens (for store webview)
router.post('/exchange-store-token', async (req: Request, res: Response) => {
  const { aos_temp_token, packageName } = req.body;

  if (!aos_temp_token) {
    return res.status(400).json({ success: false, error: 'Missing aos_temp_token' });
  }

  // Validate packageName is the store
  if (packageName !== 'org.augmentos.store') {
    return res.status(403).json({ success: false, error: 'Invalid package name for this endpoint' });
  }

  try {
    const result = await tokenService.exchangeTemporaryToken(aos_temp_token, packageName);

    if (result) {
      // For store webview, we need to return the actual tokens
      // Generate a new Supabase token
      const supabaseToken = JOE_MAMA_USER_JWT; // Using existing user token for now
      
      // Generate a core token as well
      const userData = {
        sub: result.userId,
        email: result.userId,
      };
      const coreToken = jwt.sign(userData, AUGMENTOS_AUTH_JWT_SECRET);

      res.json({ 
        success: true, 
        userId: result.userId,
        tokens: {
          supabaseToken,
          coreToken
        }
      });
    } else {
      res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }
  } catch (error) {
    logger.error({ error, packageName }, 'Failed to exchange store token');
    res.status(500).json({ success: false, error: 'Failed to exchange token' });
  }
});

// Create a hash with the app's hashed API key
router.post('/hash-with-api-key', validateCoreToken, async (req: Request, res: Response) => {
  const { stringToHash, packageName } = req.body;

  if (!stringToHash || !packageName) {
    return res.status(400).json({ success: false, error: 'stringToHash and packageName are required' });
  }

  try {
    const hash = await appService.hashWithApiKey(stringToHash, packageName);
    res.json({ success: true, hash });
  } catch (error) {
    logger.error({ error, packageName }, 'Failed to hash string with API key');
    res.status(500).json({ success: false, error: 'Failed to generate hash' });
  }
});

export default router;