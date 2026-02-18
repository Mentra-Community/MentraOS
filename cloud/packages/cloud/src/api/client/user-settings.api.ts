// cloud/src/api/client/user-settings.routes.ts
// API endpoints for managing user settings
// /api/client/user/settings
// Uses UserSettingsService for business logic

import { Router, Request, Response } from "express";
import { logger } from "../../services/logging/pino-logger";
import * as UserSettingsService from "../../services/client/user-settings.service";
import {
  clientAuthWithEmail,
  RequestWithEmail,
} from "../middleware/client.middleware";
import UserSession from "../../services/session/UserSession";

const router = Router();

// API Endpoints // /api/client/user/settings/*
router.get("/", clientAuthWithEmail, getUserSettings); // GET      /api/client/user/settings
router.put("/", clientAuthWithEmail, updateUserSettings); // PUT      /api/client/user/settings
router.post("/", clientAuthWithEmail, updateUserSettings); // POST     /api/client/user/settings
router.get("/key/:key", clientAuthWithEmail, getUserSetting); // GET      /api/client/user/settings/key/:key
router.put("/key/:key", clientAuthWithEmail, setUserSetting); // PUT      /api/client/user/settings/key/:key
router.delete("/key/:key", clientAuthWithEmail, deleteUserSetting); // DELETE   /api/client/user/settings/key/:key

// Handler functions

// Get all settings for a user
async function getUserSettings(req: Request, res: Response) {
  const _req = req as RequestWithEmail;
  const email = _req.email;

  try {
    const settings = await UserSettingsService.getUserSettings(email);

    res.json({
      success: true,
      data: { settings },
      timestamp: new Date(),
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error(err, `Error fetching settings for user ${email}:`);
    res.status(500).json({
      success: false,
      message: "Failed to fetch user settings",
      timestamp: new Date(),
    });
  }
}

// Update settings for a user
async function updateUserSettings(req: Request, res: Response) {
  const _req = req as RequestWithEmail;
  const email = _req.email;
  const { settings } = req.body;

  if (!settings || typeof settings !== "object") {
    return res.status(400).json({
      success: false,
      message: "Settings object required",
    });
  }

  try {
    const updatedSettings = await UserSettingsService.updateUserSettings(
      email,
      settings,
    );

    // If an active session exists, apply session bridges (metric_system_enabled, default_wearable)
    const session = UserSession.getById(email);
    if (session) {
      await session.userSettingsManager.onSettingsUpdatedViaRest(settings);
    }

    res.json({
      success: true,
      data: { settings: updatedSettings },
      timestamp: new Date(),
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error(err, `Error updating settings for user ${email}:`);

    if (error instanceof Error && error.message === "User not found") {
      return res.status(404).json({
        success: false,
        message: "User not found",
        timestamp: new Date(),
      });
    }

    res.status(500).json({
      success: false,
      message: "Failed to update user settings",
      timestamp: new Date(),
    });
  }
}

// Get a specific setting by key
async function getUserSetting(req: Request, res: Response) {
  const _req = req as RequestWithEmail;
  const email = _req.email;
  const { key } = req.params;

  if (!key) {
    return res.status(400).json({
      success: false,
      message: "Setting key required",
    });
  }

  try {
    const value = await UserSettingsService.getUserSetting(email, key);
    res.json({
      success: true,
      data: {
        key,
        value: value ?? null,
        exists: value !== undefined,
      },
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(error, `Error fetching setting ${key} for user ${email}`);
    res.status(500).json({
      success: false,
      message: "Failed to fetch user setting",
      timestamp: new Date(),
    });
  }
}

// Set a specific setting
async function setUserSetting(req: Request, res: Response) {
  const _req = req as RequestWithEmail;
  const email = _req.email;
  const { key } = req.params;
  const { value } = req.body;

  if (!key) {
    return res.status(400).json({
      success: false,
      message: "Setting key required",
    });
  }

  try {
    await UserSettingsService.setUserSetting(email, key, value);

    res.json({
      success: true,
      data: { key, value },
      timestamp: new Date(),
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error(err, `Error setting ${key} for user ${email}:`);
    res.status(500).json({
      success: false,
      message: "Failed to set user setting",
      timestamp: new Date(),
    });
  }
}

// Delete a specific setting
async function deleteUserSetting(req: Request, res: Response) {
  const _req = req as RequestWithEmail;
  const email = _req.email;
  const { key } = req.params;

  try {
    await UserSettingsService.deleteUserSetting(email, key);

    res.json({
      success: true,
      data: { key, deleted: true },
      timestamp: new Date(),
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error(err, `Error deleting setting ${key} for user ${email}:`);
    res.status(500).json({
      success: false,
      message: "Failed to delete user setting",
      timestamp: new Date(),
    });
  }
}

export default router;
