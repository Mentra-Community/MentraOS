/**
 * Middleware for authenticating glasses API requests
 */

import { Request, Response, NextFunction } from 'express';
import { logger } from '@augmentos/utils';
import sessionService from '../services/core/session.service';
import jwt from 'jsonwebtoken';
import photoRequestService, { PendingPhotoRequest } from '../services/core/photo-request.service';


const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET || "";

/**
 * Validates the glasses authentication token and request
 */
export const validateGlassesAuth = (req: Request, res: Response, next: NextFunction) => {
  try {
    // Get token from header
    let token = '';
    
    // First try to get from header
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    } 
    
    // If not in header, try to get from request body
    if (!token && req.body && req.body.coreToken) {
      token = req.body.coreToken;
    }
    
    // If still no token, reject
    if (!token) {
      return res.status(401).json({ error: 'No authorization token provided' });
    }

    // Get the JWT secret
    const jwtSecret = AUGMENTOS_AUTH_JWT_SECRET;
    if (!jwtSecret) {
      logger.error('JWT secret not configured');
      return res.status(500).json({ error: 'Server authentication configuration error' });
    }

    // Verify the token
    try {
      const decoded = jwt.verify(token, jwtSecret);
      // If we get here, the token is valid
      logger.debug('Valid core token provided');
      (req as any).coreToken = token;
      (req as any).decodedToken = decoded;
    } catch (jwtError) {
      logger.error('Invalid JWT token:', jwtError);
      return res.status(401).json({ error: 'Invalid authorization token' });
    }
    
    // For photo uploads, also verify the requestId corresponds to a pending request
    if (req.path.includes('/photos/upload') && req.body && req.body.requestId) {
      const requestId = req.body.requestId;
      
      // Check if this requestId exists in pending requests
      if (!photoRequestService.hasPendingPhotoRequest(requestId)) {
        logger.warn(`Attempted upload with unknown requestId: ${requestId}`);
        return res.status(400).json({ error: 'Invalid or expired requestId' });
      }
      
      logger.debug(`Valid requestId provided: ${requestId}`);
    }
    
    // Token is valid and request is valid, proceed
    next();
  } catch (error) {
    logger.error('Error validating glasses auth token:', error);
    return res.status(500).json({ error: 'Server error during authentication' });
  }
};