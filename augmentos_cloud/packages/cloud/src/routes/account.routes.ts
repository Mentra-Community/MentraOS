import { Router, Request, Response } from 'express';
import { logger } from '@augmentos/utils';
import { validateCoreToken } from '../middleware/supabaseMiddleware';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';

const router = Router();

// Initialize Supabase client using environment variables
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

if (!supabaseUrl || !supabaseServiceKey) {
  logger.error('Missing Supabase environment variables');
}

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false
  }
});

// In-memory stores for deletion and export requests (in a real app, use a database)
interface DeletionRequest {
  id: string;
  userId: string;
  email: string;
  reason?: string;
  verificationCode: string;
  createdAt: Date;
  expiresAt: Date; // 24 hours after creation
}

interface ExportRequest {
  id: string;
  userId: string;
  email: string;
  format: 'json' | 'csv';
  status: 'pending' | 'processing' | 'completed' | 'failed';
  createdAt: Date;
  completedAt?: Date;
  downloadUrl?: string;
  filePath?: string;
}

const deletionRequests = new Map<string, DeletionRequest>();
const exportRequests = new Map<string, ExportRequest>();

// Directory for storing exports
const EXPORTS_DIR = path.join(process.cwd(), 'exports');

// Create exports directory if it doesn't exist
if (!fs.existsSync(EXPORTS_DIR)) {
  fs.mkdirSync(EXPORTS_DIR, { recursive: true });
}

// Clean up expired requests periodically
const cleanupExpiredRequests = () => {
  const now = new Date();
  
  // Clean up deletion requests
  for (const [id, request] of deletionRequests.entries()) {
    if (request.expiresAt < now) {
      deletionRequests.delete(id);
    }
  }
  
  // Clean up old export files (older than 24 hours)
  for (const [id, request] of exportRequests.entries()) {
    if (request.createdAt.getTime() < now.getTime() - 24 * 60 * 60 * 1000) {
      if (request.filePath && fs.existsSync(request.filePath)) {
        fs.unlinkSync(request.filePath);
      }
      exportRequests.delete(id);
    }
  }
};

// Run cleanup every hour
setInterval(cleanupExpiredRequests, 60 * 60 * 1000);

/**
 * Get user profile information
 * GET /api/account/me
 */
router.get('/me', validateCoreToken, async (req: Request, res: Response) => {
  try {
    const userEmail = (req as any).email;
    
    if (!userEmail) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // Get user from Supabase
    const { data: userData, error } = await supabase.auth.admin.listUsers({
      filter: {
        email: userEmail,
      }
    });
    
    if (error) {
      logger.error('Error fetching user data:', error);
      return res.status(500).json({ error: 'Failed to fetch user data' });
    }
    
    if (!userData || userData.users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const user = userData.users[0];
    
    // Return user profile data
    res.json({
      id: user.id,
      email: user.email,
      name: user.user_metadata?.name,
      profile: user.user_metadata?.profile,
      createdAt: user.created_at
    });
  } catch (error) {
    logger.error('Error in /account/me:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Update user profile
 * PUT /api/account/profile
 */
router.put('/profile', validateCoreToken, async (req: Request, res: Response) => {
  try {
    const userEmail = (req as any).email;
    const { name, displayName, phoneNumber, ...otherFields } = req.body;
    
    if (!userEmail) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // Find the user by email
    const { data: userData, error: findError } = await supabase.auth.admin.listUsers({
      filter: {
        email: userEmail,
      }
    });
    
    if (findError) {
      logger.error('Error finding user:', findError);
      return res.status(500).json({ error: 'Failed to find user' });
    }
    
    if (!userData || userData.users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const user = userData.users[0];
    
    // Update user metadata
    const { error: updateError } = await supabase.auth.admin.updateUserById(
      user.id,
      {
        user_metadata: {
          ...user.user_metadata,
          name,
          profile: {
            ...user.user_metadata?.profile,
            displayName,
            phoneNumber,
            ...otherFields
          }
        }
      }
    );
    
    if (updateError) {
      logger.error('Error updating user:', updateError);
      return res.status(500).json({ error: 'Failed to update user profile' });
    }
    
    // Return updated profile
    res.json({
      id: user.id,
      email: user.email,
      name,
      profile: {
        displayName,
        phoneNumber,
        ...otherFields
      }
    });
  } catch (error) {
    logger.error('Error in /account/profile:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Request account deletion
 * POST /api/account/request-deletion
 */
router.post('/request-deletion', validateCoreToken, async (req: Request, res: Response) => {
  try {
    const userEmail = (req as any).email;
    const { reason } = req.body;
    
    if (!userEmail) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // Find the user by email
    const { data: userData, error: findError } = await supabase.auth.admin.listUsers({
      filter: {
        email: userEmail,
      }
    });
    
    if (findError) {
      logger.error('Error finding user:', findError);
      return res.status(500).json({ error: 'Failed to find user' });
    }
    
    if (!userData || userData.users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const user = userData.users[0];
    
    // Generate a random verification code
    const verificationCode = crypto.randomBytes(3).toString('hex').toUpperCase();
    
    // Create deletion request
    const requestId = `req_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24 hours from now
    
    const deletionRequest: DeletionRequest = {
      id: requestId,
      userId: user.id,
      email: userEmail,
      reason,
      verificationCode,
      createdAt: now,
      expiresAt
    };
    
    deletionRequests.set(requestId, deletionRequest);
    
    // In a real implementation, send an email with the verification code
    // For now, we'll just log it
    logger.info(`Verification code for account deletion: ${verificationCode}`);
    
    res.json({
      requestId,
      message: 'Deletion request submitted. Please check your email for verification code.'
    });
  } catch (error) {
    logger.error('Error in /account/request-deletion:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Confirm account deletion
 * DELETE /api/account/confirm-deletion
 */
router.delete('/confirm-deletion', validateCoreToken, async (req: Request, res: Response) => {
  try {
    const userEmail = (req as any).email;
    const { requestId, confirmationCode } = req.body;
    
    if (!userEmail) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    if (!requestId || !confirmationCode) {
      return res.status(400).json({ error: 'Request ID and confirmation code are required' });
    }
    
    // Check if the deletion request exists
    const deletionRequest = deletionRequests.get(requestId);
    
    if (!deletionRequest) {
      return res.status(404).json({ error: 'Deletion request not found' });
    }
    
    // Check if the request has expired
    if (deletionRequest.expiresAt < new Date()) {
      deletionRequests.delete(requestId);
      return res.status(400).json({ error: 'Deletion request has expired' });
    }
    
    // Check if the request belongs to the user
    if (deletionRequest.email !== userEmail) {
      return res.status(403).json({ error: 'Not authorized to confirm this deletion request' });
    }
    
    // Check if the confirmation code is correct
    if (deletionRequest.verificationCode !== confirmationCode) {
      return res.status(400).json({ error: 'Invalid confirmation code' });
    }
    
    // Delete the user from Supabase
    const { error: deleteError } = await supabase.auth.admin.deleteUser(deletionRequest.userId);
    
    if (deleteError) {
      logger.error('Error deleting user:', deleteError);
      return res.status(500).json({ error: 'Failed to delete user account' });
    }
    
    // Remove the deletion request
    deletionRequests.delete(requestId);
    
    // In a real implementation, clean up any additional user data in other systems
    
    res.json({
      message: 'Account deleted successfully'
    });
  } catch (error) {
    logger.error('Error in /account/confirm-deletion:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Request data export
 * POST /api/account/request-export
 */
router.post('/request-export', validateCoreToken, async (req: Request, res: Response) => {
  try {
    const userEmail = (req as any).email;
    const { format = 'json' } = req.body;
    
    if (!userEmail) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // Find the user by email
    const { data: userData, error: findError } = await supabase.auth.admin.listUsers({
      filter: {
        email: userEmail,
      }
    });
    
    if (findError) {
      logger.error('Error finding user:', findError);
      return res.status(500).json({ error: 'Failed to find user' });
    }
    
    if (!userData || userData.users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const user = userData.users[0];
    
    // Create export request
    const exportId = `export_${crypto.randomBytes(8).toString('hex')}`;
    const now = new Date();
    
    const exportRequest: ExportRequest = {
      id: exportId,
      userId: user.id,
      email: userEmail,
      format: format as 'json' | 'csv',
      status: 'pending',
      createdAt: now
    };
    
    exportRequests.set(exportId, exportRequest);
    
    // Start generating the export asynchronously
    generateExport(exportRequest)
      .then(() => {
        logger.info(`Export ${exportId} completed successfully`);
      })
      .catch(error => {
        logger.error(`Error generating export ${exportId}:`, error);
        const request = exportRequests.get(exportId);
        if (request) {
          request.status = 'failed';
          exportRequests.set(exportId, request);
        }
      });
    
    // Return immediately with the export ID
    res.json({
      id: exportId,
      status: 'pending',
      message: 'Export request submitted successfully. The export is being processed.'
    });
  } catch (error) {
    logger.error('Error in /account/request-export:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Generate export data
 */
async function generateExport(exportRequest: ExportRequest): Promise<void> {
  try {
    // Update status to processing
    exportRequest.status = 'processing';
    exportRequests.set(exportRequest.id, exportRequest);
    
    // Simulate processing time
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Get user data from Supabase
    const { data: userData, error: userError } = await supabase.auth.admin.getUserById(
      exportRequest.userId
    );
    
    if (userError || !userData.user) {
      throw new Error(`Failed to fetch user data: ${userError?.message}`);
    }
    
    // Prepare export data
    const exportData = {
      user: {
        id: userData.user.id,
        email: userData.user.email,
        created_at: userData.user.created_at,
        metadata: userData.user.user_metadata
      },
      // In a real implementation, fetch additional user data from other systems
      apps: [],
      devices: [],
      settings: {}
    };
    
    // Create export file
    const filename = `export-${exportRequest.userId}-${Date.now()}.${exportRequest.format}`;
    const filePath = path.join(EXPORTS_DIR, filename);
    
    if (exportRequest.format === 'json') {
      fs.writeFileSync(filePath, JSON.stringify(exportData, null, 2));
    } else {
      // In a real implementation, convert to CSV
      // For now, just write the JSON as a string
      fs.writeFileSync(filePath, JSON.stringify(exportData));
    }
    
    // Update export request
    exportRequest.status = 'completed';
    exportRequest.completedAt = new Date();
    exportRequest.filePath = filePath;
    exportRequest.downloadUrl = `/api/account/download-export/${exportRequest.id}`;
    
    exportRequests.set(exportRequest.id, exportRequest);
  } catch (error) {
    logger.error('Error generating export:', error);
    exportRequest.status = 'failed';
    exportRequests.set(exportRequest.id, exportRequest);
    throw error;
  }
}

/**
 * Get export status
 * GET /api/account/export-status
 */
router.get('/export-status', validateCoreToken, async (req: Request, res: Response) => {
  try {
    const userEmail = (req as any).email;
    const { id } = req.query;
    
    if (!userEmail) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    if (!id) {
      return res.status(400).json({ error: 'Export ID is required' });
    }
    
    // Check if the export request exists
    const exportRequest = exportRequests.get(id as string);
    
    if (!exportRequest) {
      return res.status(404).json({ error: 'Export request not found' });
    }
    
    // Check if the request belongs to the user
    if (exportRequest.email !== userEmail) {
      return res.status(403).json({ error: 'Not authorized to access this export' });
    }
    
    // Return export status
    res.json({
      id: exportRequest.id,
      status: exportRequest.status,
      format: exportRequest.format,
      createdAt: exportRequest.createdAt,
      completedAt: exportRequest.completedAt,
      downloadUrl: exportRequest.status === 'completed' ? exportRequest.downloadUrl : undefined
    });
  } catch (error) {
    logger.error('Error in /account/export-status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Download export
 * GET /api/account/download-export/:id
 */
router.get('/download-export/:id', validateCoreToken, async (req: Request, res: Response) => {
  try {
    const userEmail = (req as any).email;
    const { id } = req.params;
    
    if (!userEmail) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // Check if the export request exists
    const exportRequest = exportRequests.get(id);
    
    if (!exportRequest) {
      return res.status(404).json({ error: 'Export not found' });
    }
    
    // Check if the request belongs to the user
    if (exportRequest.email !== userEmail) {
      return res.status(403).json({ error: 'Not authorized to access this export' });
    }
    
    // Check if the export is completed
    if (exportRequest.status !== 'completed') {
      return res.status(400).json({ error: 'Export is not ready for download' });
    }
    
    // Check if the file exists
    if (!exportRequest.filePath || !fs.existsSync(exportRequest.filePath)) {
      return res.status(404).json({ error: 'Export file not found' });
    }
    
    // Set headers for file download
    const filename = path.basename(exportRequest.filePath);
    res.setHeader('Content-Disposition', `attachment; filename=${filename}`);
    
    if (exportRequest.format === 'json') {
      res.setHeader('Content-Type', 'application/json');
    } else {
      res.setHeader('Content-Type', 'text/csv');
    }
    
    // Stream the file to the response
    const fileStream = fs.createReadStream(exportRequest.filePath);
    fileStream.pipe(res);
  } catch (error) {
    logger.error('Error in /account/download-export:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Get privacy settings
 * GET /api/account/privacy
 */
router.get('/privacy', validateCoreToken, async (req: Request, res: Response) => {
  try {
    const userEmail = (req as any).email;
    
    if (!userEmail) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // Find the user by email
    const { data: userData, error: findError } = await supabase.auth.admin.listUsers({
      filter: {
        email: userEmail,
      }
    });
    
    if (findError) {
      logger.error('Error finding user:', findError);
      return res.status(500).json({ error: 'Failed to find user' });
    }
    
    if (!userData || userData.users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const user = userData.users[0];
    
    // Return privacy settings or defaults if not set
    const privacySettings = user.user_metadata?.privacy || {
      shareUsageData: true,
      receiveNotifications: true,
      allowDataCollection: true
    };
    
    res.json(privacySettings);
  } catch (error) {
    logger.error('Error in /account/privacy:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * Update privacy settings
 * PUT /api/account/privacy
 */
router.put('/privacy', validateCoreToken, async (req: Request, res: Response) => {
  try {
    const userEmail = (req as any).email;
    const settings = req.body;
    
    if (!userEmail) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    // Find the user by email
    const { data: userData, error: findError } = await supabase.auth.admin.listUsers({
      filter: {
        email: userEmail,
      }
    });
    
    if (findError) {
      logger.error('Error finding user:', findError);
      return res.status(500).json({ error: 'Failed to find user' });
    }
    
    if (!userData || userData.users.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const user = userData.users[0];
    
    // Update privacy settings
    const { error: updateError } = await supabase.auth.admin.updateUserById(
      user.id,
      {
        user_metadata: {
          ...user.user_metadata,
          privacy: settings
        }
      }
    );
    
    if (updateError) {
      logger.error('Error updating privacy settings:', updateError);
      return res.status(500).json({ error: 'Failed to update privacy settings' });
    }
    
    res.json(settings);
  } catch (error) {
    logger.error('Error in /account/privacy:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;