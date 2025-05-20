/**
 * @fileoverview Routes for handling photo uploads from smart glasses.
 */

import express, { Request, Response } from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { logger } from '@augmentos/utils';
import { validateGlassesAuth } from '../middleware/glasses-auth.middleware';
import photoRequestService from '../services/core/photo-request.service';
import { GalleryPhoto } from '../models/gallery-photo.model';

const router = express.Router();

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Create uploads directory if it doesn't exist
    const uploadDir = path.join(__dirname, '../../uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Generate unique filename
    const uniqueFilename = `${Date.now()}-${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueFilename);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    // Accept only images
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

/**
 * @route POST /api/photos/upload
 * @desc Upload a photo from smart glasses
 * @access Private (requires glasses auth)
 */
router.post('/upload', validateGlassesAuth, upload.single('photo'), async (req: Request, res: Response) => {
  try {
    // Get request ID from the request body
    const { requestId } = req.body;

    if (!requestId) {
      return res.status(400).json({ error: 'Request ID is required' });
    }

    // Get uploaded file
    const file = req.file;
    if (!file) {
      return res.status(400).json({ error: 'No photo uploaded' });
    }

    // In a production environment, you would upload this to a CDN
    // For now, we'll just use a local URL
    const baseUrl = process.env.CLOUD_PUBLIC_URL || `http://localhost:${process.env.PORT || 80}`;
    const photoUrl = `${baseUrl}/uploads/${file.filename}`;

    // Get the pending request from the centralized service
    const pendingRequest = photoRequestService.getPendingPhotoRequest(requestId);
    
    if (!pendingRequest) {
      logger.warn(`No pending photo request found for requestId: ${requestId}`);
      // Clean up the file if no pending request
      fs.unlinkSync(file.path);
      return res.status(404).json({ error: 'Photo request not found or expired' });
    }
    
    // Save photo to gallery if flag is set
    if (pendingRequest.saveToGallery) {
      try {
        // Save to gallery
        await GalleryPhoto.create({
          userId: pendingRequest.userId,
          filename: file.filename,
          photoUrl,
          requestId,
          appId: pendingRequest.appId || 'system',
          metadata: {
            originalFilename: file.originalname,
            size: file.size,
            mimeType: file.mimetype
          }
        });
        
        logger.info(`Photo saved to gallery for user ${pendingRequest.userId}, requestId: ${requestId}`);
      } catch (error) {
        // Just log error but continue processing - don't fail the request
        logger.error('Error saving photo to gallery:', error);
      }
    }

    // Process the photo response through the centralized service
    const processed = photoRequestService.processPhotoResponse(requestId, photoUrl);

    if (!processed) {
      logger.warn(`Failed to process photo response for requestId: ${requestId}`);
      // We still keep the photo since it might be in the gallery
      // Only delete if we didn't save to gallery
      if (!pendingRequest.saveToGallery) {
        fs.unlinkSync(file.path);
      }
      return res.status(404).json({ error: 'Error processing photo response' });
    }

    // Return success response
    res.status(200).json({
      success: true,
      requestId,
      photoUrl,
      savedToGallery: pendingRequest.saveToGallery || false
    });
  } catch (error) {
    logger.error('Error handling photo upload:', error);
    res.status(500).json({ error: 'Failed to process photo upload' });
  }
});

/**
 * @route GET /api/photos/test
 * @desc Test endpoint for photo routes
 * @access Public
 */
router.get('/test', (req: Request, res: Response) => {
  res.json({ message: 'Photo routes are working' });
});

export default router;