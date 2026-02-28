/**
 * @fileoverview Routes for handling photo uploads from smart glasses.
 */

import express, { Request, Response, NextFunction } from "express";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import path from "path";
import fs from "fs";
import { logger } from "../services/logging/pino-logger";
import { validateGlassesAuth } from "../middleware/glasses-auth.middleware";

import photoTakenService from "../services/core/photo-taken.service";

import UserSession from "../services/session/UserSession";

// Function to clean up old photos
async function cleanupOldPhotos(uploadDir: string) {
  try {
    const files = await fs.promises.readdir(uploadDir);
    const now = Date.now();
    const fiveMinutesAgo = now - 5 * 60 * 1000;

    for (const file of files) {
      const filePath = path.join(uploadDir, file);
      const stats = await fs.promises.stat(filePath);

      // Check if file is older than 5 minutes
      if (stats.mtimeMs < fiveMinutesAgo) {
        await fs.promises.unlink(filePath);
        logger.info(`Deleted old photo: ${file}`);
      }
    }
  } catch (error) {
    logger.error(error as Error, "Error cleaning up old photos:");
  }
}

const router = express.Router();

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
    fieldSize: 10 * 1024 * 1024, // 10MB limit for fields
  },
  fileFilter: async (req, file, cb) => {
    try {
      // Log the raw request for debugging
      logger.debug(
        {
          headers: req.headers,
          contentType: req.headers["content-type"],
          body: req.body,
          file: {
            fieldname: file.fieldname,
            originalname: file.originalname,
            mimetype: file.mimetype,
            size: file.size,
          },
        },
        "Processing file upload:",
      );

      if (!file) {
        throw new Error("No file object received");
      }

      if (!file.mimetype) {
        throw new Error("No mimetype on file object");
      }

      if (!file.mimetype.startsWith("image/")) {
        throw new Error(`Invalid mimetype: ${file.mimetype}`);
      }

      return cb(null, true);
    } catch (error) {
      logger.error(error as Error, "File filter error:");
      return cb(error instanceof Error ? error : new Error(String(error)));
    }
  },
});

// Add error handler for multer
const uploadMiddleware = (req: Request, res: Response, next: NextFunction) => {
  upload.single("file")(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      logger.error(err as Error, "Multer error:");
      return res.status(400).json({
        error: "File upload failed",
        details: err.message,
        code: err.code,
      });
    } else if (err) {
      logger.error(err as Error, "Upload error:");
      return res.status(500).json({
        error: "Internal server error during upload",
        details: err.message,
      });
    }
    next();
  });
};

/**
 * @route POST /api/photos/upload
 * @desc Upload a photo from smart glasses
 * @access Private (requires glasses auth)
 */
router.post(
  "/upload",
  validateGlassesAuth,
  uploadMiddleware,
  async (req: Request, res: Response) => {
    try {
      // Parse metadata from request body
      let metadata;
      try {
        metadata = JSON.parse(req.body.metadata || "{}");
      } catch (error) {
        logger.error(error as Error, "Failed to parse metadata:");
        return res.status(400).json({ error: "Invalid metadata format" });
      }

      const { requestId } = metadata;

      logger.info(`Processing upload for requestId: ${requestId}`);

      if (!requestId) {
        return res.status(400).json({ error: "Request ID is required" });
      }

      // Get uploaded file
      const file = req.file;
      if (!file) {
        return res.status(400).json({ error: "No photo uploaded" });
      }

      if (!file.buffer) {
        logger.error(
          {
            file: {
              fieldname: file.fieldname,
              originalname: file.originalname,
              mimetype: file.mimetype,
              size: file.size,
            },
          },
          "File buffer is missing:",
        );
        return res.status(400).json({ error: "Invalid file data - no buffer" });
      }

      // Get the user session
      const userSession = UserSession.getById("loriamistadi75@gmail.com");
      if (!userSession) {
        logger.error(`User session not found for ${req.headers["x-user-id"]}`);
        return res.status(404).json({ error: "User session not found" });
      }

      // Save the file to disk first
      const uploadDir = path.join(__dirname, "../../uploads/photos");
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }

      // Clean up old photos before saving new one
      await cleanupOldPhotos(uploadDir);

      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const filename = `${timestamp}_${uuidv4()}${path.extname(file.originalname)}`;
      const filepath = path.join(uploadDir, filename);

      try {
        await fs.promises.writeFile(filepath, file.buffer);
        logger.info(`Photo saved to ${filepath}`);
      } catch (error) {
        logger.error(error as Error, "Failed to save photo:");
        return res.status(500).json({ error: "Failed to save photo" });
      }

      // Broadcast to Apps subscribed to PHOTO_TAKEN
      try {
        // photoTakenService.broadcastPhotoTaken(userSession, file.buffer, file.mimetype);
        photoTakenService.broadcastPhotoTaken(
          userSession,
          Buffer.from(file.buffer),
          file.mimetype,
        );
      } catch (error) {
        logger.error(error as Error, "Failed to broadcast photo:");
        // Continue processing even if broadcast fails
      }

      // Generate URL for response
      const baseUrl = process.env.CLOUD_PUBLIC_URL;
      const photoUrl = `${baseUrl}/uploads/${filename}`;

      // Return success response
      res.status(200).json({
        success: true,
        photoUrl,
        requestId,
      });
    } catch (error) {
      logger.error(error as Error, "Error handling photo upload:");
      res.status(500).json({ error: "Failed to process photo upload" });
    }
  },
);

/**
 * @route GET /api/photos/test
 * @desc Test endpoint for photo routes
 * @access Public
 */
router.get("/test", (req: Request, res: Response) => {
  res.json({ message: "Photo routes are working" });
});

export default router;
