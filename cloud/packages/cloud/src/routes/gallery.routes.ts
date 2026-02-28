/**
 * @fileoverview Routes for accessing and managing the user's photo gallery.
 */

import express, { Request, Response } from "express";
import { logger } from "../services/logging/pino-logger";
import { validateGlassesAuth } from "../middleware/glasses-auth.middleware";
import fs from "fs";
import path from "path";
import { GalleryPhoto } from "../models/gallery-photo.model";

const router = express.Router();

/**
 * @route GET /api/gallery
 * @desc Get all photos in the user's gallery
 * @access Private (requires authentication)
 */
router.get("/", validateGlassesAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req as any).decodedToken.email;

    console.log("REQUESTING GALLERY PHOTOS FOR USERID:");
    console.log(userId);

    // Get all photos for this user
    const photos = await GalleryPhoto.findByUserId(userId);

    res.status(200).json({
      success: true,
      photos,
    });
  } catch (error) {
    logger.error(error as Error, "Error fetching gallery photos:");
    res.status(500).json({ error: "Failed to fetch gallery photos" });
  }
});

/**
 * @route DELETE /api/gallery/:photoId
 * @desc Delete a photo from the user's gallery
 * @access Private (requires authentication)
 */
router.delete(
  "/:photoId",
  validateGlassesAuth,
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).decodedToken.userId;
      const { photoId } = req.params;

      // Get the photo to find its filename
      const photo = await GalleryPhoto.findById(photoId);

      if (!photo) {
        return res.status(404).json({ error: "Photo not found" });
      }

      // Check if this user owns the photo
      if (photo.userId !== userId) {
        return res
          .status(403)
          .json({ error: "Not authorized to delete this photo" });
      }

      // Delete from database
      const deleted = await GalleryPhoto.findAndDeleteById(photoId, userId);

      if (!deleted) {
        return res.status(404).json({ error: "Failed to delete photo" });
      }

      // Try to delete the file (but don't fail if we can't)
      try {
        const filePath = path.join(__dirname, "../../uploads", photo.filename);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
          logger.info(`Deleted file ${filePath}`);
        }
      } catch (fileError) {
        // Just log this error but don't fail the request
        logger.warn(
          { fileError },
          `Could not delete file for photo ${photoId}:`,
        );
      }

      res.status(200).json({
        success: true,
        message: "Photo deleted successfully",
      });
    } catch (error) {
      logger.error(error as Error, "Error deleting gallery photo:");
      res.status(500).json({ error: "Failed to delete photo" });
    }
  },
);

export default router;
