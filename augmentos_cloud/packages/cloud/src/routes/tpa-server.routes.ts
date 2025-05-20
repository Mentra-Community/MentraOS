/**
 * TPA Server Registration Routes
 * 
 * API endpoints for TPA server registration and management.
 * These routes handle:
 * - Server registration
 * - Heartbeats
 * - Server restart notifications
 */

import express, { Request, Response } from 'express';
import { 
  tpaRegistrationService,
  TpaServerRegistrationRequest,
  TpaServerHeartbeatRequest 
} from '../services/core/tpa-registration.service';
import { logger } from '@augmentos/utils';

const router = express.Router();

/**
 * Register a new TPA server
 * POST /api/tpa-server/register
 */
router.post('/register', async (req: Request, res: Response) => {
  try {
    const registrationRequest: TpaServerRegistrationRequest = {
      packageName: req.body.packageName,
      apiKey: req.body.apiKey,
      webhookUrl: req.body.webhookUrl,
      serverUrls: req.body.serverUrls || ''
    };
    
    logger.info(`TPA server registration request: ${registrationRequest.packageName}`);
    
    // Validate required fields
    if (!registrationRequest.packageName || !registrationRequest.webhookUrl) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: packageName and webhookUrl are required'
      });
    }
    
    // If API key is not provided, use a placeholder for now
    // TODO: Remove this when API key system is implemented
    if (!registrationRequest.apiKey) {
      registrationRequest.apiKey = `temp-key-${registrationRequest.packageName}`;
      logger.debug(`Using temporary API key for ${registrationRequest.packageName}`);
    }
    
    // Process registration
    const result = tpaRegistrationService.registerServer(registrationRequest);
    
    if (result.success) {
      return res.status(201).json(result);
    } else {
      return res.status(400).json(result);
    }
  } catch (error) {
    logger.error('Error processing TPA server registration:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Send a heartbeat from a TPA server
 * POST /api/tpa-server/heartbeat
 */
router.post('/heartbeat', (req: Request, res: Response) => {
  try {
    const heartbeatRequest: TpaServerHeartbeatRequest = {
      registrationId: req.body.registrationId
    };
    
    // Validate required fields
    if (!heartbeatRequest.registrationId) {
      return res.status(400).json({
        success: false,
        error: 'Missing registrationId'
      });
    }
    
    // Process heartbeat
    const success = tpaRegistrationService.processHeartbeat(heartbeatRequest);
    
    if (success) {
      return res.status(200).json({
        success: true
      });
    } else {
      return res.status(404).json({
        success: false,
        error: 'Registration not found'
      });
    }
  } catch (error) {
    logger.error('Error processing TPA server heartbeat:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Notify system of a TPA server restart to recover sessions
 * POST /api/tpa-server/restart
 */
router.post('/restart', async (req: Request, res: Response) => {
  try {
    const { registrationId } = req.body;
    
    // Validate required fields
    if (!registrationId) {
      return res.status(400).json({
        success: false,
        error: 'Missing registrationId'
      });
    }
    
    // Process server restart and recover sessions
    logger.info(`TPA server restart notification: ${registrationId}`);
    const recoveredCount = await tpaRegistrationService.handleTpaServerRestart(registrationId);
    
    return res.status(200).json({
      success: true,
      recoveredSessions: recoveredCount
    });
  } catch (error) {
    logger.error('Error processing TPA server restart:', error);
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
