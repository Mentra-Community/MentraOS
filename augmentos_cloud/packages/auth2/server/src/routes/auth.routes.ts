//backend/src/routes/apps.ts
import express from 'express';
import type { Request, Response, Router } from 'express';
import { validateCoreToken } from '../middleware/supabaseMiddleware';
import { validateTpaApiKey } from '../middleware/validateApiKey';
import { authService } from '../services/auth.service';
import { logger } from '@augmentos/utils';

const router:Router = express.Router();

export const JOE_MAMA_USER_JWT = process.env.JOE_MAMA_USER_JWT || "";

router.post('/exchange-token', async (req: Request, res: Response) => {
  const { supabaseToken } = req.body;
  if (!supabaseToken) {
    res.status(400).json({ error: 'No token provided' });
    return;
  }

  const result = await authService.exchangeSupabaseToken(supabaseToken);
  
  if ('error' in result) {
    res.status(401).json({ error: result.error });
    return;
  }
  
  res.json({ coreToken: result.coreToken });
});

// Generate a temporary token for webview authentication
router.post('/generate-webview-token', validateCoreToken, async (req: Request, res: Response) => {
  const userId = (req as any).email; // Use the email property set by validateCoreToken
  const { packageName } = req.body;

  const result = await authService.generateWebviewToken(userId, packageName);
  
  if (!result.success) {
    res.status(result.error === 'packageName is required' ? 400 : 500)
      .json({ success: false, error: result.error });
    return;
  }
  
  res.json({ success: true, token: result.token });
});


// Exchange a temporary token for user details (called by TPA backend)
router.post('/exchange-user-token', validateTpaApiKey, async (req: Request, res: Response) => {
  const { aos_temp_token, packageName } = req.body;

  if (!aos_temp_token) {
    res.status(400).json({ success: false, error: 'Missing aos_temp_token' });
    return;
  }

  const result = await authService.exchangeUserToken(aos_temp_token, packageName);
  
  if (!result.success) {
    const statusCode = result.error === 'Missing temporary token' ? 400 : 
                        result.error === 'Invalid or expired token' ? 401 : 500;
    res.status(statusCode).json({ success: false, error: result.error });
    return;
  }
  
  res.json({ success: true, userId: result.userId });

});

export default router;