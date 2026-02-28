// cloud/src/api/client/notifications.api.ts
// API endpoints for phone notifications from mobile clients

import { Router, Request, Response } from "express";
import {
  clientAuthWithUserSession,
  RequestWithUserSession,
} from "../middleware/client.middleware";
import { StreamType } from "@mentra/sdk";

const router = Router();

// API Endpoints // /api/client/notifications/*
router.post("/", clientAuthWithUserSession, handlePhoneNotification);
router.post(
  "/dismissed",
  clientAuthWithUserSession,
  handlePhoneNotificationDismissed,
);

// Handler function
// POST     /api/client/notifications
// BODY     { notificationId, app, title, content, priority, timestamp, packageName }
async function handlePhoneNotification(req: Request, res: Response) {
  const _req = req as RequestWithUserSession;
  const userSession = _req.userSession;
  const {
    notificationId,
    app,
    title,
    content,
    priority,
    timestamp,
    packageName,
  } = req.body;

  // Validate required fields
  if (!notificationId || !app || !title || !content) {
    return res.status(400).json({
      success: false,
      message: "Missing required fields: notificationId, app, title, content",
    });
  }

  try {
    // Create notification message to relay to apps
    const notificationMessage = {
      type: StreamType.PHONE_NOTIFICATION,
      notificationId,
      app,
      title,
      content,
      priority: priority || "normal",
      timestamp: timestamp || Date.now(),
      packageName,
    };

    _req.logger.debug(
      { notification: notificationMessage },
      `Phone notification received from mobile for user ${userSession.userId}`,
    );

    // Relay to all apps subscribed to phone_notification stream
    userSession.relayMessageToApps(notificationMessage);

    return res.json({
      success: true,
      message: "Notification relayed to subscribed apps",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    _req.logger.error(
      error,
      `Error handling phone notification for user ${userSession.userId}:`,
    );

    return res.status(500).json({
      success: false,
      message: "Failed to handle phone notification",
      timestamp: new Date().toISOString(),
    });
  }
}

// Handler function
// POST     /api/client/notifications/dismissed
// BODY     { notificationId, notificationKey, packageName }
async function handlePhoneNotificationDismissed(req: Request, res: Response) {
  const _req = req as RequestWithUserSession;
  const userSession = _req.userSession;
  const { notificationId, notificationKey, packageName } = req.body;

  // Validate required fields
  if (!notificationId || !notificationKey || !packageName) {
    return res.status(400).json({
      success: false,
      message:
        "Missing required fields: notificationId, notificationKey, packageName",
    });
  }

  try {
    // Create dismissal message to relay to apps
    const dismissalMessage = {
      type: StreamType.PHONE_NOTIFICATION_DISMISSED,
      notificationId,
      notificationKey,
      packageName,
      timestamp: Date.now(),
    };

    _req.logger.debug(
      { dismissal: dismissalMessage },
      `Phone notification dismissal received from mobile for user ${userSession.userId}`,
    );

    // Relay to all apps subscribed to phone_notification_dismissed stream
    userSession.relayMessageToApps(dismissalMessage);

    return res.json({
      success: true,
      message: "Notification dismissal relayed to subscribed apps",
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    _req.logger.error(
      error,
      `Error handling phone notification dismissal for user ${userSession.userId}:`,
    );

    return res.status(500).json({
      success: false,
      message: "Failed to handle phone notification dismissal",
      timestamp: new Date().toISOString(),
    });
  }
}

export default router;
