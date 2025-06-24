// routes/admin.routes.ts
import { Router, Request, Response } from 'express';
import { logger } from '@mentra/utils';
// import { getSessionStats } from '../services/debug/server-stats';

const router = Router();

/**
 * Get admin dashboard stats - simplified version
 */
// async function sessionStats(req: Request, res: Response) {
//   try {
//     const sessionStats = getSessionStats();
//     res.json(sessionStats);
//   } catch (error) {
//     logger.error('Error fetching admin stats:', error);
//     res.status(500).json({ error: 'Failed to fetch admin stats' });
//   }
// };

// // App review routes
// router.get('/session-stats', sessionStats);


export default router;