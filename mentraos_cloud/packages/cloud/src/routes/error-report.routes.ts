// cloud/src/routes/apps.routes.ts
import express, { Request, Response } from 'express';
import { logger } from '@augmentos/utils';
import jwt, { JwtPayload } from 'jsonwebtoken';
import { PosthogService } from '../services/logging/posthog.service';


export const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET || "";

const router = express.Router();

/**
 * Stop app for session 
 */
async function errorReport(req: Request, res: Response) {
  const reportData = req.body;
  let userId = 'anonymous';
  try {
    // its stored like:         'Authorization': `Bearer ${coreToken}`,
    const authHeader = req.headers['authorization'] || req.headers['Authorization'];
    if (authHeader) {
      const token = authHeader.toString().split(' ')[1];
      const userData = jwt.verify(token, AUGMENTOS_AUTH_JWT_SECRET);
      userId = (userData as JwtPayload).email;
    } else {
      const coreToken = reportData?.coreToken || req.headers['x-core-token'] || req.headers['core-token'];
      if (coreToken) {
        const userData = jwt.verify(coreToken, AUGMENTOS_AUTH_JWT_SECRET);
        userId = (userData as JwtPayload).email;
      }
    }
  }
  catch (error) {
    logger.warn("Failed to get userId for error report");
  }
  try {
    logger.info(`Sending error report`, reportData);
    PosthogService.trackEvent('error_report', userId, reportData);
    res.json({
      success: true,
    });
  } catch (error) {
    logger.error(`Error sending error report`, reportData);
    res.status(500).json({
      success: false,
      message: 'Error sending error report'
    });
  }
}

// Route Definitions
router.post('/app/error-report', errorReport);
router.post('/api/error-report', errorReport);

export default router;
