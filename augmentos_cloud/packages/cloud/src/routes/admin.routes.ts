// routes/admin.routes.ts
import { Router, Request, Response } from 'express';
import { validateAdminEmail } from '../middleware/admin-auth.middleware';
import App from '../models/app.model';
// import { logger } from '@augmentos/utils';
import { Exception } from '@sentry/node';
import { logger as rootLogger } from '../services/logging/pino-logger';
const logger = rootLogger.child({ service: 'admin.routes' });

const router = Router();

/**
 * Get admin dashboard stats - simplified version
 */
const getAdminStats = async (req: Request, res: Response) => {
  try {
    // Count apps by status
    const [
      developmentCount,
      submittedCount,
      publishedCount,
      rejectedCount
    ] = await Promise.all([
      App.countDocuments({ appStoreStatus: 'DEVELOPMENT' }),
      App.countDocuments({ appStoreStatus: 'SUBMITTED' }),
      App.countDocuments({ appStoreStatus: 'PUBLISHED' }),
      App.countDocuments({ appStoreStatus: 'REJECTED' })
    ]);
    
    // Get recently submitted apps
    const recentSubmissions = await App.find({ appStoreStatus: 'SUBMITTED' })
      .sort({ updatedAt: -1 })
      .limit(5)
      .lean();
    
    const finalStats = {
      counts: {
        development: developmentCount,
        submitted: submittedCount,
        published: publishedCount,
        rejected: rejectedCount,
        admins: 0 // Placeholder since we're not tracking admins in DB anymore
      },
      recentSubmissions
    };
    
    res.json(finalStats);
  } catch (error) {
    logger.error('Error fetching admin stats:', error);
    res.status(500).json({ error: 'Failed to fetch admin stats' });
  }
};

/**
 * Get all submitted apps
 */
const getSubmittedApps = async (req: Request, res: Response) => {
  try {
    logger.info('Fetching submitted apps');
    
    // Get apps marked as SUBMITTED
    const submittedApps = await App.find({ appStoreStatus: 'SUBMITTED' })
      .sort({ updatedAt: -1 }) // Most recent first
      .lean();
    
    logger.info(`Found ${submittedApps.length} submitted apps`);
    res.json(submittedApps);
  } catch (error) {
    logger.error('Error fetching submitted apps:', error);
    res.status(500).json({ error: 'Failed to fetch submitted apps' });
  }
};

/**
 * Get a specific app detail
 */
const getAppDetail = async (req: Request, res: Response) => {
  try {
    const { packageName } = req.params;
    
    const app = await App.findOne({ packageName }).lean();
    
    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }
    
    res.json(app);
  } catch (error) {
    logger.error('Error fetching app detail:', error);
    res.status(500).json({ error: 'Failed to fetch app detail' });
  }
};

// Admin check route - just verifies that the user's email is in the admin list
router.get('/check', validateAdminEmail, (req, res) => {
  res.json({ 
    isAdmin: true, 
    role: 'ADMIN', // Simplified - all admins have the same role now
    email: req.body.userEmail
  });
});

// Public debug route to check database status - no auth required
router.get('/debug', async (req, res) => {
  try {
    // Count apps by status
    const counts = {
      apps: {
        total: await App.countDocuments(),
        development: await App.countDocuments({ appStoreStatus: 'DEVELOPMENT' }),
        submitted: await App.countDocuments({ appStoreStatus: 'SUBMITTED' }),
        published: await App.countDocuments({ appStoreStatus: 'PUBLISHED' }),
        rejected: await App.countDocuments({ appStoreStatus: 'REJECTED' })
      }
    };
    
    // Return JSON with CORS headers to ensure browser can receive it
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.json({
      status: 'Database connection working',
      time: new Date().toISOString(),
      counts
    });
  } catch (error) {
    logger.error('Error in debug route:', error);
    res.status(500).json({ 
      error: 'Error connecting to database', 
      message: (error as Error).message 
    });
  }
});

// Create test submission for development purposes
router.post('/create-test-submission', async (req, res) => {
  try {
    // Check if in development mode
    if (process.env.NODE_ENV !== 'development') {
      return res.status(403).json({ error: 'This endpoint is only available in development mode' });
    }
    
    // Create a test app with SUBMITTED status
    const testApp = new App({
      name: `Test App ${Math.floor(Math.random() * 1000)}`,
      packageName: `com.test.app${Date.now()}`,
      description: 'This is a test app submission for development',
      appStoreStatus: 'SUBMITTED',
      isPublic: true,
      tpaType: 'TPAWebView',
      hashedApiKey: 'test-key-hash',
      logoURL: 'https://placehold.co/100x100?text=Test'
    });
    
    await testApp.save();
    
    res.status(201).json({
      message: 'Test app submission created',
      app: testApp
    });
  } catch (error) {
    logger.error('Error creating test submission:', error);
    res.status(500).json({ 
      error: 'Error creating test submission', 
      message: (error as Error).message 
    });
  }
});

/**
 * Approve an app
 */
const approveApp = async (req: Request, res: Response) => {
  try {
    const { packageName } = req.params;
    const { notes } = req.body;
    const adminEmail = req.body.userEmail; // Set by validateAdminEmail middleware
    
    const app = await App.findOne({ packageName });
    
    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }
    
    if (app.appStoreStatus !== 'SUBMITTED') {
      return res.status(400).json({ error: 'App is not in submitted state' });
    }
    
    // Update app status and store approval notes
    app.appStoreStatus = 'PUBLISHED';
    app.reviewNotes = notes || '';
    app.reviewedBy = adminEmail;
    app.reviewedAt = new Date();
    
    await app.save();
    
    res.json({ 
      message: 'App approved successfully',
      app
    });
  } catch (error) {
    logger.error('Error approving app:', error);
    res.status(500).json({ error: 'Failed to approve app' });
  }
};

/**
 * Reject an app
 */
const rejectApp = async (req: Request, res: Response) => {
  try {
    const { packageName } = req.params;
    const { notes } = req.body;
    const adminEmail = req.body.userEmail; // Set by validateAdminEmail middleware
    
    if (!notes) {
      return res.status(400).json({ error: 'Rejection notes are required' });
    }
    
    const app = await App.findOne({ packageName });
    
    if (!app) {
      return res.status(404).json({ error: 'App not found' });
    }
    
    if (app.appStoreStatus !== 'SUBMITTED') {
      return res.status(400).json({ error: 'App is not in submitted state' });
    }
    
    // Update app status and store rejection notes
    app.appStoreStatus = 'REJECTED';
    app.reviewNotes = notes;
    app.reviewedBy = adminEmail;
    app.reviewedAt = new Date();
    
    await app.save();
    
    // TODO: Send email notification to developer about the rejection
    // This would typically use a notification service or email service
    // For now, we'll just log it
    if (app.developerId) {
      logger.info(`App ${packageName} rejected. Notification should be sent to developer: ${app.developerId}`);
      // In a real implementation, you would send an email here
      // emailService.sendRejectionNotification(app.developerId, app.name, notes);
    }
    
    res.json({ 
      message: 'App rejected',
      app
    });
  } catch (error) {
    logger.error('Error rejecting app:', error);
    res.status(500).json({ error: 'Failed to reject app' });
  }
};

// App review routes
router.get('/apps/stats', validateAdminEmail, getAdminStats);
router.get('/apps/submitted', validateAdminEmail, getSubmittedApps);
router.get('/apps/:packageName', validateAdminEmail, getAppDetail);
router.post('/apps/:packageName/approve', validateAdminEmail, approveApp);
router.post('/apps/:packageName/reject', validateAdminEmail, rejectApp);

export default router;