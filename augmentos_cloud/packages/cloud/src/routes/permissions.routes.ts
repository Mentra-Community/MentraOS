import { Router, Request } from 'express';
import { validateCoreToken, UserRequest } from '../middleware/supabaseMiddleware';
import App from '../models/app.model';
import { PermissionType } from '../models/app.model';
import { logger } from '@augmentos/utils';

const router = Router();

/**
 * Get permissions for an app
 * GET /api/permissions/:packageName
 * Requires authentication
 */
router.get('/:packageName', validateCoreToken, async (req: Request, res) => {
  try {
    const { packageName } = req.params;
    const userEmail = (req as UserRequest).email;
    
    const app = await App.findOne({ packageName });
    
    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }
    
    // Check if the user owns this app or if the app is published (allowing all authenticated users to view)
    if (app.developerId !== userEmail && app.appStoreStatus !== 'PUBLISHED') {
      logger.warn(`Unauthorized permission view attempt for ${packageName} by ${userEmail}`);
      return res.status(403).json({ 
        error: 'Unauthorized', 
        message: 'You do not have permission to view this app\'s permissions' 
      });
    }
    
    return res.json({ permissions: app.permissions || [] });
  } catch (error) {
    logger.error(`Error fetching app permissions: ${error}`);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Update permissions for an app
 * PATCH /api/permissions/:packageName
 * Requires authentication and developer ownership of the app
 */
router.patch('/:packageName', validateCoreToken, async (req: Request, res) => {
  try {
    const { packageName } = req.params;
    const { permissions } = req.body;
    const userEmail = (req as UserRequest).email;
    
    // Validate permissions
    if (!Array.isArray(permissions)) {
      return res.status(400).json({ error: 'Permissions must be an array' });
    }
    
    // Verify app exists and the developer owns it
    const app = await App.findOne({ packageName });
    
    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }
    
    // Check if the user owns this app
    if (app.developerId && app.developerId !== userEmail) {
      logger.warn(`Unauthorized permission update attempt for ${packageName} by ${userEmail}`);
      return res.status(403).json({ 
        error: 'Unauthorized', 
        message: 'You do not have permission to modify this app' 
      });
    }
    
    // Validate each permission
    for (const perm of permissions) {
      if (!perm.type || !Object.values(PermissionType).includes(perm.type)) {
        return res.status(400).json({ error: `Invalid permission type: ${perm.type}` });
      }
      
      if (perm.description && typeof perm.description !== 'string') {
        return res.status(400).json({ error: 'Permission description must be a string' });
      }
    }
    
    // Update app permissions
    const updatedApp = await App.findOneAndUpdate(
      { packageName },
      { $set: { permissions } },
      { new: true }
    );
    
    logger.info(`Updated permissions for app ${packageName} by developer ${userEmail}`);
    return res.json(updatedApp);
  } catch (error) {
    logger.error(`Error updating app permissions: ${error}`);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;