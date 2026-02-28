/**
 * @fileoverview Routes for handling hardware-related requests from glasses.
 */

import express, { Request, Response } from "express";
import { logger } from "../services/logging/pino-logger";
import { validateGlassesAuth } from "../middleware/glasses-auth.middleware";
import UserSession from "../services/session/UserSession";
import { StreamType } from "@mentra/sdk";
import photoRequestService from "../services/core/photo-request.service";

const router = express.Router();

/**
 * @route POST /api/hardware/button-press
 * @desc Handles button press events from glasses
 * @access Private (requires glasses authentication)
 */
router.post(
  "/button-press",
  validateGlassesAuth,
  async (req: Request, res: Response) => {
    try {
      const userId = (req as any).decodedToken.email;
      const { buttonId, pressType } = req.body;

      logger.info(
        `Button press event from user ${userId}: ${buttonId} (${pressType})`,
      );

      // Find the user's active session
      const userSession = UserSession.getById(userId);

      // Check if any Apps are subscribed to button events
      const subscribedApps = userSession
        ? userSession.subscriptionManager.getSubscribedApps(
            StreamType.BUTTON_PRESS,
          )
        : [];

      if (subscribedApps.length === 0) {
        // No Apps subscribed, handle as system action
        logger.info(
          `No Apps subscribed to button events for user ${userId}, handling as system action`,
        );

        // Create a system photo request using the centralized service
        const requestId = photoRequestService.createSystemPhotoRequest(userId);

        return res.status(200).json({
          success: true,
          action: "take_photo",
          requestId,
        });
      } else {
        // Apps are subscribed, let them handle the button press
        logger.info(
          `Apps subscribed to button events for user ${userId}: ${subscribedApps.join(", ")}`,
        );

        return res.status(200).json({
          success: true,
        });
      }
    } catch (error) {
      logger.error(error, "Error handling button press:");
      res.status(500).json({ error: "Failed to process button press" });
    }
  },
);

/**
 * @route GET /api/hardware/system-photo-request/:requestId
 * @desc Checks if a system photo request exists
 * @access Private (requires glasses authentication)
 */
router.get(
  "/system-photo-request/:requestId",
  validateGlassesAuth,
  (req: Request, res: Response) => {
    try {
      const { requestId } = req.params;
      const photoRequest =
        photoRequestService.getPendingPhotoRequest(requestId);

      if (!photoRequest || photoRequest.origin !== "system") {
        return res.status(404).json({
          success: false,
          message: "Photo request not found",
        });
      }

      return res.status(200).json({
        success: true,
        action: "take_photo",
      });
    } catch (error) {
      logger.error(error, "Error checking system photo request:");
      res.status(500).json({ error: "Failed to check system photo request" });
    }
  },
);

export default router;
