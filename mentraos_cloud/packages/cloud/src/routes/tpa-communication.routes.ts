import express, { Request, Response } from 'express';
import { validateTpaApiKey } from '../middleware/validateApiKey';
import sessionService from '../services/session/session.service';
import multiUserTpaService from '../services/core/multi-user-tpa.service';
import appService from '../services/core/app.service';

const router = express.Router();

/**
 * @route POST /api/tpa-communication/discover-users
 * @desc Discover other users currently using the same TPA
 * @access Private (requires core token)
 * @body { packageName: string, includeUserProfiles?: boolean }
 */
router.post('/discover-users', async (req: Request, res: Response) => {
  try {
    // Parse API key from Authorization header (Bearer token)
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }
    const tpaApiKey = authHeader.replace('Bearer ', '').trim();
    const { packageName, includeUserProfiles = false } = req.body;
    if (!packageName) {
      return res.status(400).json({ error: 'packageName is required' });
    }
    // Retrieve the app by packageName
    const app = await appService.getApp(packageName);
    if (!app) {
      return res.status(401).json({ error: 'Invalid packageName' });
    }
    // Validate the API key
    const isValid = await appService.validateApiKey(packageName, tpaApiKey);
    if (!isValid) {
      return res.status(401).json({ error: 'Invalid API key' });
    }

    const body = req.body as any;

    const userId = body.userId as string;

    // console.log('4324 userId', userId);

    // Find the user's active session
    const userSession = sessionService.getSessionByUserId(userId);
    if (!userSession) {
      return res.status(404).json({ error: 'No active session found for user' });
    }

    multiUserTpaService.addTpaUser(packageName, userId);

    // console.log("users$#%#",  multiUserTpaService.getActiveTpaUsers(packageName))
    // Use the service to get the user list (adapted from websocket handler)
    const users = multiUserTpaService.getActiveTpaUsers(packageName)
      .filter((otherUserId: string) => otherUserId !== userId)
      .map((otherUserId: string) => {
        const otherSession = sessionService.getSessionByUserId(otherUserId);
        return {
          userId: otherUserId,
          sessionId: otherSession?.sessionId || 'unknown',
          joinedAt: new Date(), // TODO: Track actual join time
          userProfile: includeUserProfiles ? multiUserTpaService['getUserProfile'](otherUserId) : undefined
        };
      });
    return res.json({
      users,
      totalUsers: users.length,
      timestamp: new Date()
    });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

export default router;
