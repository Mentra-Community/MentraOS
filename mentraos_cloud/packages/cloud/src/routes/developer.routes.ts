// routes/developer.routes.ts
import { Router, Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../utils/supabase';
import appService from '../services/core/app.service';
import { User } from '../models/user.model';
import { Types } from 'mongoose';
import { OrganizationService } from '../services/core/organization.service';
import App from '../models/app.model';
import sessionService from '../services/session/session.service';
import { logger as rootLogger } from '../services/logging/pino-logger';
import multer from 'multer';
import FormData from 'form-data';
import axios from 'axios';

const logger = rootLogger.child({ service: 'developer.routes' });
// TODO(isaiah): refactor this code to use this logger instead of console.log, console.error, etc.

// Configure multer for memory storage (files stored in memory as Buffer)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    // Accept only image files
    const allowedMimeTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'];
    if (allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PNG, JPEG, GIF, and WebP images are allowed.'));
    }
  }
});

// Define request with user and organization info
interface DevPortalRequest extends Request {
  developerEmail: string;
  currentOrgId?: Types.ObjectId;
}

const router = Router();

// ------------- MIDDLEWARE -------------

/**
 * Middleware to validate Core token - similar to how apps.routes.ts works
 */
import jwt from 'jsonwebtoken';
import UserSession from 'src/services/session/UserSession';
const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET || "";

// TODO(isaiah): This is called validateSupabaseToken, but i'm pretty sure this is using an AugmentOS JWT(coreToken), not a Supabase token.
// TODO(isaiah): Investigate how currentOrgId is used, the DevPortalRequest claims it's optional yet this middleware fails if it's not provided.
// Also the middleware doesn't validate the currentOrgId, only injects it into the request object, maybe it should just be a query param instead of a header?
const validateSupabaseToken = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  // Extract token from Authorization header
  const authHeader = req.headers.authorization;
  console.log('Auth header:', authHeader ? `${authHeader.substring(0, 20)}...` : 'none');

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.log('Missing or invalid Authorization header');
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.substring(7); // Remove 'Bearer ' prefix
  console.log('Token length:', token.length);

  try {
    // Verify using our AUGMENTOS_AUTH_JWT_SECRET instead of Supabase directly
    // This matches the token format used by the apps.routes.ts
    const userData = jwt.verify(token, AUGMENTOS_AUTH_JWT_SECRET);

    if (!userData || !(userData as jwt.JwtPayload).email) {
      console.error('No user or email in token payload');
      res.status(401).json({ error: 'Invalid token data' });
      return;
    }

    console.log('User authenticated:', (userData as jwt.JwtPayload).email);

    // Add developer email to request object
    (req as DevPortalRequest).developerEmail = ((userData as jwt.JwtPayload).email as string).toLowerCase();

    // Check for organization context in headers
    const orgIdHeader = req.headers['x-org-id'];
    if (orgIdHeader && typeof orgIdHeader === 'string') {
      (req as DevPortalRequest).currentOrgId = new Types.ObjectId(orgIdHeader);
    } else {
      // If no org ID in header, get the user's default org
      const user = await User.findOne({ email: (req as DevPortalRequest).developerEmail });
      if (user && user.defaultOrg) {
        (req as DevPortalRequest).currentOrgId = user.defaultOrg;
      }
    }

    // Ensure we have an organization ID
    if (!(req as DevPortalRequest).currentOrgId) {
      res.status(400).json({ error: 'No organization context provided' });
      return;
    }

    next();
  } catch (error) {
    console.error('Token verification error:', error);
    res.status(500).json({ error: 'Authentication failed' });
    return;
  }
};

// ------------- HANDLER FUNCTIONS -------------

/**
 * Helper function to automatically install an app for the developer who created it
 * @param packageName - The package name of the app to install
 * @param developerEmail - The email of the developer who created the app
 */
const autoInstallAppForDeveloper = async (packageName: string, developerEmail: string): Promise<void> => {
  try {
    logger.info(`Auto-installing app ${packageName} for developer ${developerEmail}`);

    // Find the user (do not create if not found)
    const user = await User.findOne({ email: developerEmail.toLowerCase() });
    if (!user) {
      logger.error(`User not found for auto-install: ${developerEmail}`);
      return;
    }

    // Check if app is already installed (safety check)
    if (user.isAppInstalled(packageName)) {
      logger.info(`App ${packageName} is already installed for developer ${developerEmail}`);
      return;
    }

    // Install the app using the user model method
    await user.installApp(packageName);

    logger.info(`Successfully auto-installed app ${packageName} for developer ${developerEmail}`);

    // Trigger app state change notification for any active sessions
    try {
      // sessionService.triggerAppStateChange(developerEmail);
      const userSession = UserSession.getById(user.email);
      if (userSession) {
        userSession.appManager.broadcastAppState();
      } else {
        logger.warn(`No active session found for developer ${developerEmail} to trigger app state change`);
      }
    } catch (error) {
      logger.warn({ error, email: developerEmail, packageName }, 'Error sending app state notification after auto-install');
      // Non-critical error, installation succeeded
    }
  } catch (error) {
    logger.error({ error, packageName, developerEmail }, 'Error auto-installing app for developer');
    // Don't throw the error - we don't want app creation to fail if auto-install fails
  }
};

/**
 * Get authenticated developer user
 */
const getAuthenticatedUser = async (req: Request, res: Response): Promise<void> => {
  try {
    const email = (req as DevPortalRequest).developerEmail;
    const user = await User.findOrCreateUser(email);

    res.json({
      id: user._id,
      email: user.email,
      profile: user.profile || {
        company: '',
        website: '',
        contactEmail: '',
        description: '',
        logo: ''
      },
      organizations: user.organizations || [],
      defaultOrg: user.defaultOrg
    });
  } catch (error) {
    console.error('Error fetching user data:', error);
    res.status(500).json({ error: 'Failed to fetch user data' });
  }
};

/**
 * Get developer's Third Party Apps (TPAs)
 */
const getDeveloperApps = async (req: Request, res: Response): Promise<void> => {
  try {
    const email = (req as DevPortalRequest).developerEmail;
    const orgId = (req as DevPortalRequest).currentOrgId;

    // Fetch all apps owned by the organization
    const allApps = await appService.getAppsByOrgId(orgId!, email);

    res.json(allApps);
  } catch (error) {
    console.error('Error fetching developer TPAs:', error);
    res.status(500).json({ error: 'Failed to fetch TPAs' });
  }
};

/**
 * Get a specific TPA by package name
 */
const getAppByPackageName = async (req: Request, res: Response) => {
  try {
    const email = (req as DevPortalRequest).developerEmail;
    const orgId = (req as DevPortalRequest).currentOrgId;
    const { packageName } = req.params;

    const tpa = await appService.getAppByPackageName(packageName, email, orgId);

    if (!tpa) {
      return res.status(404).json({ error: 'TPA not found' });
    }

    res.json(tpa);
  } catch (error) {
    console.error('Error fetching TPA:', error);
    return res.status(500).json({ error: 'Failed to fetch TPA' });
  }
};

/**
 * Create a new TPA
 */
const createApp = async (req: Request, res: Response) => {
  try {
    const email = (req as DevPortalRequest).developerEmail;
    const orgId = (req as DevPortalRequest).currentOrgId;
    const tpaData = req.body;

    // Check if TPA with this package name already exists
    const existingTpa = await appService.getAppByPackageName(tpaData.packageName);
    if (existingTpa) {
      return res.status(409).json({
        error: `TPA with package name '${tpaData.packageName}' already exists`
      });
    }

    // Create app with organization ownership
    const result = await appService.createApp({
      ...tpaData,
      organizationId: orgId
    }, email);

    // Auto-install the app for the developer who created it
    autoInstallAppForDeveloper(tpaData.packageName, email);

    res.status(201).json(result);
  } catch (error: any) {
    console.error('Error creating TPA:', error);

    // Handle duplicate key error specifically
    if (error.code === 11000 && error.keyPattern?.packageName) {
      return res.status(409).json({
        error: `TPA with package name '${error.keyValue.packageName}' already exists`
      });
    }

    return res.status(500).json({ error: error.message || 'Failed to create app' });
  }
};

/**
 * Update an existing TPA
 */
const updateApp = async (req: Request, res: Response) => {
  try {
    const email = (req as DevPortalRequest).developerEmail;
    const orgId = (req as DevPortalRequest).currentOrgId;
    const { packageName } = req.params;
    const tpaData = req.body;

    const updatedTpa = await appService.updateApp(packageName, tpaData, email, orgId);

    res.json(updatedTpa);
  } catch (error: any) {
    console.error('Error updating TPA:', error);

    // Check for specific error types
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }

    if (error.message.includes('permission')) {
      return res.status(403).json({ error: error.message });
    }

    // For validation errors (like tool/setting validation), return the specific error message
    if (error.message.includes('Invalid tool definitions') || error.message.includes('Invalid setting definitions')) {
      return res.status(400).json({ error: error.message });
    }

    // Return the actual error message instead of a generic one
    res.status(500).json({ error: error.message || 'Failed to update TPA' });
  }
};

/**
 * Delete a TPA
 */
const deleteApp = async (req: Request, res: Response) => {
  try {
    const email = (req as DevPortalRequest).developerEmail;
    const orgId = (req as DevPortalRequest).currentOrgId;
    const { packageName } = req.params;

    await appService.deleteApp(packageName, email, orgId);

    return res.status(200).json({ message: `TPA ${packageName} deleted successfully` });
  } catch (error: any) {
    console.error('Error deleting TPA:', error);

    // Check for specific error types
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }

    if (error.message.includes('permission')) {
      return res.status(403).json({ error: error.message });
    }

    return res.status(500).json({ error: 'Failed to delete TPA' });
  }
};

/**
 * Regenerate API Key for a TPA
 */
const regenerateApiKey = async (req: Request, res: Response) => {
  try {
    const email = (req as DevPortalRequest).developerEmail;
    const orgId = (req as DevPortalRequest).currentOrgId;
    const { packageName } = req.params;

    const apiKey = await appService.regenerateApiKey(packageName, email, orgId);

    res.json({
      apiKey,
      createdAt: new Date().toISOString()
    });
  } catch (error: any) {
    console.error('Error regenerating API key:', error);

    // Check for specific error types
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }

    if (error.message.includes('permission')) {
      return res.status(403).json({ error: error.message });
    }

    res.status(500).json({ error: 'Failed to regenerate API key' });
  }
};

/**
 * Get shareable installation link
 */
const getShareableLink = async (req: Request, res: Response) => {
  try {
    const email = (req as DevPortalRequest).developerEmail;
    const orgId = (req as DevPortalRequest).currentOrgId;
    const { packageName } = req.params;

    // Verify that organization owns this app
    const app = await appService.getAppByPackageName(packageName, email, orgId);
    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }

    // Generate a shareable URL directly to the app's page on the app store
    const installUrl = `${process.env.APP_STORE_URL || 'https://store.augmentos.org'}/package/${packageName}`;

    res.json({ installUrl });
  } catch (error) {
    console.error('Error generating shareable link:', error);
    res.status(500).json({ error: 'Failed to generate shareable link' });
  }
};

/**
 * Track app sharing
 */
const trackSharing = async (req: Request, res: Response) => {
  try {
    const email = (req as DevPortalRequest).developerEmail;
    const orgId = (req as DevPortalRequest).currentOrgId;
    const { packageName } = req.params;
    const { emails } = req.body;

    if (!Array.isArray(emails)) {
      return res.status(400).json({ error: 'Emails must be an array' });
    }

    // Verify that organization owns this app
    const app = await appService.getAppByPackageName(packageName, email, orgId);
    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }

    // In a real implementation, you would track who the app was shared with
    // For MVP, just acknowledge the request

    return res.json({ success: true, sharedWith: emails.length });
  } catch (error) {
    console.error('Error tracking app sharing:', error);
    return res.status(500).json({ error: 'Failed to track app sharing' });
  }
};

/**
 * Publish app to the app store
 */
const publishApp = async (req: Request, res: Response) => {
  try {
    const email = (req as DevPortalRequest).developerEmail;
    const orgId = (req as DevPortalRequest).currentOrgId;
    const { packageName } = req.params;

    // Call service to publish app
    const updatedApp = await appService.publishApp(packageName, email, orgId);

    return res.json(updatedApp);
  } catch (error: any) {
    console.error('Error publishing app:', error);

    // Check for specific error types
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }

    if (error.message.includes('permission')) {
      return res.status(403).json({ error: error.message });
    }

    if (error.message.includes('PROFILE_INCOMPLETE')) {
      return res.status(400).json({ error: error.message });
    }

    return res.status(500).json({ error: 'Failed to publish app' });
  }
};

/**
 * Update developer profile - redirects to organization profile update
 */
const updateDeveloperProfile = async (req: Request, res: Response) => {
  try {
    return res.status(410).json({
      error: 'This endpoint is deprecated',
      message: 'Please use the organization profile update endpoint: PUT /api/orgs/:orgId'
    });
  } catch (error) {
    console.error('Error updating developer profile:', error);
    return res.status(500).json({ error: 'Failed to update profile' });
  }
};

// No longer needed - visibility is now based on organization membership
const updateAppVisibility = async (req: Request, res: Response) => {
  return res.status(410).json({
    error: 'This endpoint is deprecated',
    message: 'App visibility is now managed through organization membership'
  });
};

/**
 * Update sharedWithEmails - deprecated
 */
const updateSharedEmails = async (req: Request, res: Response) => {
  return res.status(410).json({
    error: 'This endpoint is deprecated',
    message: 'App sharing is now managed through organization membership'
  });
};

/**
 * Move a TPA to a different organization
 */
const moveToOrg = async (req: Request, res: Response) => {
  console.log('moveToOrg handler called with:', {
    packageName: req.params.packageName,
    targetOrgId: req.body.targetOrgId,
    sourceOrgId: (req as DevPortalRequest).currentOrgId?.toString(),
    url: req.originalUrl,
    method: req.method
  });

  try {
    const email = (req as DevPortalRequest).developerEmail;
    const sourceOrgId = (req as DevPortalRequest).currentOrgId;
    const { packageName } = req.params;
    const { targetOrgId } = req.body;

    if (!sourceOrgId || !targetOrgId) {
      return res.status(400).json({ error: 'Source and target organization IDs are required' });
    }

    // Get the user document
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check if source org exists and user has admin access
    const hasSourceAdminAccess = await OrganizationService.isOrgAdmin(user, sourceOrgId);
    if (!hasSourceAdminAccess) {
      return res.status(403).json({ error: 'Insufficient permissions in source organization' });
    }

    // Check if target org exists and user has admin access
    const hasTargetAdminAccess = await OrganizationService.isOrgAdmin(user, targetOrgId);
    if (!hasTargetAdminAccess) {
      return res.status(403).json({ error: 'Insufficient permissions in target organization' });
    }

    // Use app service to move the app
    const updatedApp = await appService.moveApp(
      packageName,
      sourceOrgId,
      new Types.ObjectId(targetOrgId.toString()),
      email
    );

    // Return updated app
    return res.json(updatedApp);
  } catch (error: any) {
    console.error('Error moving TPA to new organization:', error);

    // Check for specific error types
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }

    if (error.message.includes('permission')) {
      return res.status(403).json({ error: error.message });
    }

    return res.status(500).json({ error: 'Failed to move TPA to new organization' });
  }
};

/**
 * Upload an image to Cloudflare Images
 */
const uploadImage = async (req: Request, res: Response) => {
  try {
    const email = (req as DevPortalRequest).developerEmail;

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    // Get Cloudflare credentials from environment
    const cloudflareAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const cloudflareApiToken = process.env.CLOUDFLARE_API_TOKEN;

    if (!cloudflareAccountId || !cloudflareApiToken) {
      logger.error('Cloudflare credentials not configured');
      return res.status(500).json({ error: 'Image upload service not configured' });
    }

    // Parse metadata if provided
    let metadata: any = {};
    if (req.body.metadata) {
      try {
        metadata = JSON.parse(req.body.metadata);
      } catch (e) {
        logger.warn('Failed to parse metadata:', e);
      }
    }

    // Check if we're replacing an existing image
    const replaceImageId = req.body.replaceImageId;

    // Create form data for Cloudflare API
    const formData = new FormData();
    formData.append('file', req.file.buffer, {
      filename: req.file.originalname,
      contentType: req.file.mimetype,
    });

    // Add metadata to help identify the image
    const cfMetadata = {
      uploadedBy: email,
      uploadedAt: new Date().toISOString(),
      ...(metadata.appPackageName && { appPackageName: metadata.appPackageName }),
      ...(replaceImageId && { replacedImageId: replaceImageId }),
    };

    formData.append('metadata', JSON.stringify(cfMetadata));

    // Make request to Cloudflare Images API
    const cloudflareUrl = `https://api.cloudflare.com/client/v4/accounts/${cloudflareAccountId}/images/v1`;

    try {
      const response = await axios.post(cloudflareUrl, formData, {
        headers: {
          'Authorization': `Bearer ${cloudflareApiToken}`,
          ...formData.getHeaders(),
        },
      });

      if (!response.data.success) {
        logger.error('Cloudflare API error:', response.data.errors);
        return res.status(500).json({ error: 'Failed to upload image to Cloudflare' });
      }

      const imageData = response.data.result;

      // Construct the delivery URL
      // Cloudflare Images uses the format: https://imagedelivery.net/{account_hash}/{image_id}/{variant_name}
      // The 'public' variant is typically available by default
      const deliveryUrl = imageData.variants?.[0] || `https://imagedelivery.net/${cloudflareAccountId}/${imageData.id}/public`;

      // If we were replacing an image, delete the old one
      if (replaceImageId) {
        try {
          await axios.delete(
            `https://api.cloudflare.com/client/v4/accounts/${cloudflareAccountId}/images/v1/${replaceImageId}`,
            {
              headers: {
                'Authorization': `Bearer ${cloudflareApiToken}`,
              },
            }
          );
          logger.info(`Deleted old image: ${replaceImageId}`);
        } catch (deleteError) {
          // Log but don't fail the request if delete fails
          logger.warn(`Failed to delete old image ${replaceImageId}:`, deleteError);
        }
      }

      // Return the image URL and ID
      res.json({
        url: deliveryUrl,
        imageId: imageData.id,
      });

    } catch (cfError: any) {
      logger.error('Cloudflare API request failed:', cfError.response?.data || cfError.message);
      return res.status(500).json({
        error: 'Failed to upload image',
        details: cfError.response?.data?.errors?.[0]?.message || 'Unknown error'
      });
    }

  } catch (error) {
    logger.error('Error in image upload handler:', error);
    return res.status(500).json({ error: 'Internal server error during image upload' });
  }
};

/**
 * Delete an image from Cloudflare Images
 */
const deleteImage = async (req: Request, res: Response) => {
  try {
    const email = (req as DevPortalRequest).developerEmail;
    const { imageId } = req.params;

    if (!imageId) {
      return res.status(400).json({ error: 'Image ID is required' });
    }

    // Get Cloudflare credentials from environment
    const cloudflareAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const cloudflareApiToken = process.env.CLOUDFLARE_API_TOKEN;

    if (!cloudflareAccountId || !cloudflareApiToken) {
      logger.error('Cloudflare credentials not configured');
      return res.status(500).json({ error: 'Image delete service not configured' });
    }

    // Delete from Cloudflare
    try {
      await axios.delete(
        `https://api.cloudflare.com/client/v4/accounts/${cloudflareAccountId}/images/v1/${imageId}`,
        {
          headers: {
            'Authorization': `Bearer ${cloudflareApiToken}`,
          },
        }
      );

      logger.info(`Image ${imageId} deleted by ${email}`);
      res.json({ success: true, message: 'Image deleted successfully' });

    } catch (cfError: any) {
      if (cfError.response?.status === 404) {
        return res.status(404).json({ error: 'Image not found' });
      }

      logger.error('Cloudflare API delete request failed:', cfError.response?.data || cfError.message);
      return res.status(500).json({
        error: 'Failed to delete image',
        details: cfError.response?.data?.errors?.[0]?.message || 'Unknown error'
      });
    }

  } catch (error) {
    logger.error('Error in image delete handler:', error);
    return res.status(500).json({ error: 'Internal server error during image deletion' });
  }
};

// ------------- ROUTES REGISTRATION -------------

// Auth routes
router.get('/auth/me', validateSupabaseToken, getAuthenticatedUser);
router.put('/auth/profile', validateSupabaseToken, updateDeveloperProfile);

// TEMPORARY DEBUG ROUTE - NO AUTH CHECK
router.get('/debug/apps', (req: Request, res: Response): void => {
  console.log('Debug route hit - bypassing auth');
  res.json([{
    name: 'Debug App',
    packageName: 'com.debug.app',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tpaType: 'STANDARD',
    description: 'Debug mode app',
    publicUrl: 'http://localhost:3000'
  }]);
});

// Developer Portal routes
router.get('/apps', validateSupabaseToken, getDeveloperApps);
router.post('/apps/register', validateSupabaseToken, createApp);
router.get('/apps/:packageName', validateSupabaseToken, getAppByPackageName);
router.put('/apps/:packageName', validateSupabaseToken, updateApp);
router.delete('/apps/:packageName', validateSupabaseToken, deleteApp);
router.post('/apps/:packageName/api-key', validateSupabaseToken, regenerateApiKey);
router.get('/apps/:packageName/share', validateSupabaseToken, getShareableLink);
router.post('/apps/:packageName/share', validateSupabaseToken, trackSharing);
router.post('/apps/:packageName/publish', validateSupabaseToken, publishApp);
router.patch('/apps/:packageName/visibility', validateSupabaseToken, updateAppVisibility);
router.patch('/apps/:packageName/share-emails', validateSupabaseToken, updateSharedEmails);
router.post('/apps/:packageName/move-org', validateSupabaseToken, moveToOrg);

// Image upload routes
router.post('/images/upload', validateSupabaseToken, upload.single('file'), uploadImage);
router.delete('/images/:imageId', validateSupabaseToken, deleteImage);

export default router;