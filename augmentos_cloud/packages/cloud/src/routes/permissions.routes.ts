import { Router, Request } from 'express';
import { validateCoreToken, UserRequest } from '../middleware/supabaseMiddleware';
import App from '../models/app.model';
import { PermissionType } from '@mentra/sdk';
import { logger } from '@mentra/utils';
import { Types } from 'mongoose';
import { User } from '../models/user.model';
import { OrganizationService } from '../services/core/organization.service';

const router = Router();

// Extended UserRequest with organization context
interface OrgUserRequest extends UserRequest {
  currentOrgId?: Types.ObjectId;
}

// TODO(isaiah): Instead of trusting the org ID from the header,
// we should make an orgMiddleware that populates the orgs the authenticated user is a member of.
/**
 * Get permissions for an app
 * GET /api/permissions/:packageName
 * Requires authentication
 */
router.get('/:packageName', validateCoreToken, async (req: Request, res) => {
  try {
    const { packageName } = req.params;
    const userEmail = (req as OrgUserRequest).email;

    // Check for organization context in headers
    const orgIdHeader = req.headers['x-org-id'];
    if (orgIdHeader && typeof orgIdHeader === 'string') {
      (req as OrgUserRequest).currentOrgId = new Types.ObjectId(orgIdHeader);
    }

    const app = await App.findOne({ packageName });

    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }

    // Check if the organization owns this app or if the app is published
    let hasPermission = false;

    console.log('app.organizationId', app.organizationId);
    console.log('req.currentOrgId', (req as OrgUserRequest).currentOrgId);

    if (app.appStoreStatus === 'PUBLISHED') {
      hasPermission = true;
    } else if ((req as OrgUserRequest).currentOrgId && app.organizationId) {
      hasPermission = app.organizationId.toString() === (req as OrgUserRequest).currentOrgId?.toString();
      console.log('hasPermission', hasPermission);
    } else if (app.developerId === userEmail) {
      // For backward compatibility
      hasPermission = true;
    } else if (userEmail && app.organizationId) {
      // Check if the user is in the org that owns the app
      const user = await User.findOne({ email: userEmail });
      if (user) {
        hasPermission = await OrganizationService.isOrgMember(user, app.organizationId);
      }
    }

    if (!hasPermission) {
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
 * Requires authentication and organization ownership of the app
 */
router.patch('/:packageName', validateCoreToken, async (req: Request, res) => {
  try {
    const { packageName } = req.params;
    const { permissions } = req.body;
    const userEmail = (req as OrgUserRequest).email;

    // Check for organization context in headers
    const orgIdHeader = req.headers['x-org-id'];
    if (orgIdHeader && typeof orgIdHeader === 'string') {
      (req as OrgUserRequest).currentOrgId = new Types.ObjectId(orgIdHeader);
    }

    // Validate permissions
    if (!Array.isArray(permissions)) {
      return res.status(400).json({ error: 'Permissions must be an array' });
    }

    // Verify app exists and the organization owns it
    const app = await App.findOne({ packageName });

    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }

    // Check if the organization owns this app
    let hasPermission = false;

    if ((req as OrgUserRequest).currentOrgId && app.organizationId) {
      hasPermission = app.organizationId.toString() === (req as OrgUserRequest).currentOrgId?.toString();
    } else if (app.developerId === userEmail) {
      // For backward compatibility
      hasPermission = true;
    } else if (userEmail && app.organizationId) {
      // Check if the user is in the org that owns the app
      const user = await User.findOne({ email: userEmail });
      if (user) {
        hasPermission = await OrganizationService.isOrgMember(user, app.organizationId);
      }
    }

    if (!hasPermission) {
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