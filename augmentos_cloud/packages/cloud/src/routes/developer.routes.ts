// routes/developer.routes.ts
import { Router, Request, Response, NextFunction } from 'express';
import { supabaseAdmin } from '../utils/supabase';
import appService from '../services/core/app.service';
import { User } from '../models/user.model';

// Define request with user info
interface DevPortalRequest extends Request {
  developerEmail: string;
}

const router = Router();

// ------------- MIDDLEWARE -------------

/**
 * Middleware to validate Core token - similar to how apps.routes.ts works
 */
import jwt from 'jsonwebtoken';
const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET || "";

const validateSupabaseToken = async (req: Request, res: Response, next: NextFunction) => {
  // Extract token from Authorization header
  const authHeader = req.headers.authorization;
  console.log('Auth header:', authHeader ? `${authHeader.substring(0, 20)}...` : 'none');
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.log('Missing or invalid Authorization header');
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const token = authHeader.substring(7); // Remove 'Bearer ' prefix
  console.log('Token length:', token.length);

  try {
    // Verify using our AUGMENTOS_AUTH_JWT_SECRET instead of Supabase directly
    // This matches the token format used by the apps.routes.ts
    const userData = jwt.verify(token, AUGMENTOS_AUTH_JWT_SECRET);
    
    if (!userData || !(userData as jwt.JwtPayload).email) {
      console.error('No user or email in token payload');
      return res.status(401).json({ error: 'Invalid token data' });
    }

    console.log('User authenticated:', (userData as jwt.JwtPayload).email);
    
    // Add developer email to request object
    (req as DevPortalRequest).developerEmail = ((userData as jwt.JwtPayload).email as string).toLowerCase();

    next();
  } catch (error) {
    console.error('Token verification error:', error);
    return res.status(500).json({ error: 'Authentication failed' });
  }
};

// ------------- HANDLER FUNCTIONS -------------

/**
 * Get authenticated developer user
 */
const getAuthenticatedUser = async (req: Request, res: Response) => {
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
      }
      //createdAt: user.createdAt
    });
  } catch (error) {
    console.error('Error fetching user data:', error);
    res.status(500).json({ error: 'Failed to fetch user data' });
  }
};

/**
 * Get developer's Third Party Apps (TPAs)
 */
const getDeveloperApps = async (req: Request, res: Response) => {
  try {
    const email = (req as DevPortalRequest).developerEmail;

    // Fetch all apps created by or shared with the user (deduplicated)
    const allApps = await appService.getAppsCreatedOrSharedWith(email);

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
    const { packageName } = req.params;
    
    const tpa = await appService.getAppByPackageName(packageName, email);
    
    if (!tpa) {
      return res.status(404).json({ error: 'TPA not found' });
    }
    
    res.json(tpa);
  } catch (error) {
    console.error('Error fetching TPA:', error);
    res.status(500).json({ error: 'Failed to fetch TPA' });
  }
};

/**
 * Create a new TPA
 */
const createApp = async (req: Request, res: Response) => {
  try {
    const email = (req as DevPortalRequest).developerEmail;
    const tpaData = req.body;
    
    // Check if TPA with this package name already exists
    const existingTpa = await appService.getAppByPackageName(tpaData.packageName);
    if (existingTpa) {
      return res.status(409).json({ 
        error: `TPA with package name '${tpaData.packageName}' already exists`
      });
    }
    
    // Pass sharedWithOrganization to service
    const result = await appService.createApp(tpaData, email);
    res.status(201).json(result);
  } catch (error: any) {
    console.error('Error creating TPA:', error);
    
    // Handle duplicate key error specifically
    if (error.code === 11000 && error.keyPattern?.packageName) {
      return res.status(409).json({ 
        error: `TPA with package name '${error.keyValue.packageName}' already exists`
      });
    }
    
    res.status(500).json({ error: error.message || 'Failed to create app' });
  }
};

/**
 * Update an existing TPA
 */
const updateApp = async (req: Request, res: Response) => {
  try {
    const email = (req as DevPortalRequest).developerEmail;
    const { packageName } = req.params;
    const tpaData = req.body;
    
    const updatedTpa = await appService.updateApp(packageName, tpaData, email);
    
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
    
    res.status(500).json({ error: 'Failed to update TPA' });
  }
};

/**
 * Delete a TPA
 */
const deleteApp = async (req: Request, res: Response) => {
  try {
    const email = (req as DevPortalRequest).developerEmail;
    const { packageName } = req.params;
    
    await appService.deleteApp(packageName, email);
    
    res.status(200).json({ message: `TPA ${packageName} deleted successfully` });
  } catch (error: any) {
    console.error('Error deleting TPA:', error);
    
    // Check for specific error types
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    
    if (error.message.includes('permission')) {
      return res.status(403).json({ error: error.message });
    }
    
    res.status(500).json({ error: 'Failed to delete TPA' });
  }
};

/**
 * Regenerate API Key for a TPA
 */
const regenerateApiKey = async (req: Request, res: Response) => {
  try {
    const email = (req as DevPortalRequest).developerEmail;
    const { packageName } = req.params;
    
    const apiKey = await appService.regenerateApiKey(packageName, email);
    
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
    const { packageName } = req.params;
    
    // Verify that developer owns this app
    const app = await appService.getAppByPackageName(packageName, email);
    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }
    
    // Generate a shareable URL directly to the app's page on the app store
    const installUrl = `${process.env.APP_STORE_URL || 'https://appstore.augmentos.org'}/package/${packageName}`;
    
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
    const { packageName } = req.params;
    const { emails } = req.body;
    
    if (!Array.isArray(emails)) {
      return res.status(400).json({ error: 'Emails must be an array' });
    }
    
    // Verify that developer owns this app
    const app = await appService.getAppByPackageName(packageName, email);
    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }
    
    // In a real implementation, you would track who the app was shared with
    // For MVP, just acknowledge the request
    
    res.json({ success: true, sharedWith: emails.length });
  } catch (error) {
    console.error('Error tracking app sharing:', error);
    res.status(500).json({ error: 'Failed to track app sharing' });
  }
};

/**
 * Publish app to the app store
 */
const publishApp = async (req: Request, res: Response) => {
  try {
    const email = (req as DevPortalRequest).developerEmail;
    const { packageName } = req.params;
    
    // Call service to publish app
    const updatedApp = await appService.publishApp(packageName, email);
    
    res.json(updatedApp);
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
    
    res.status(500).json({ error: 'Failed to publish app' });
  }
};

/**
 * Update developer profile
 */
const updateDeveloperProfile = async (req: Request, res: Response) => {
  try {
    const email = (req as DevPortalRequest).developerEmail;
    const profileData = req.body;
    
    // Validate profile data
    const validFields = ['company', 'website', 'contactEmail', 'description', 'logo'];
    const sanitizedProfile: any = {};
    
    for (const field of validFields) {
      if (profileData[field] !== undefined) {
        sanitizedProfile[field] = profileData[field];
      }
    }
    
    // Update user profile
    const user = await User.findOneAndUpdate(
      { email },
      { $set: { profile: sanitizedProfile } },
      { new: true }
    );
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json({
      id: user._id,
      email: user.email,
      profile: user.profile || {}
    });
  } catch (error) {
    console.error('Error updating developer profile:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
};

// Add endpoint to update app visibility
const updateAppVisibility = async (req: Request, res: Response) => {
  try {
    const email = (req as DevPortalRequest).developerEmail;
    const { packageName } = req.params;
    const { sharedWithOrganization } = req.body;
    const updatedApp = await appService.updateAppVisibility(packageName, email, sharedWithOrganization);
    res.json(updatedApp);
  } catch (error: any) {
    console.error('Error updating app visibility:', error);
    res.status(500).json({ error: error.message || 'Failed to update app visibility' });
  }
};

// Update sharedWithEmails
router.patch('/apps/:packageName/share-emails', validateSupabaseToken, async (req, res) => {
  try {
    const { packageName } = req.params;
    const { emails } = req.body;
    const developerEmail = (req as DevPortalRequest).developerEmail;
    const updatedApp = await appService.updateSharedWithEmails(packageName, emails, developerEmail);
    res.json(updatedApp);
  } catch (error) {
    res.status(400).json({ error: (error as any).message });
  }
});

// ------------- ROUTES REGISTRATION -------------

// Auth routes
router.get('/auth/me', validateSupabaseToken, getAuthenticatedUser);
router.put('/auth/profile', validateSupabaseToken, updateDeveloperProfile);

// TEMPORARY DEBUG ROUTE - NO AUTH CHECK
router.get('/debug/apps', (req, res) => {
  console.log('Debug route hit - bypassing auth');
  return res.json([{ 
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

export default router;