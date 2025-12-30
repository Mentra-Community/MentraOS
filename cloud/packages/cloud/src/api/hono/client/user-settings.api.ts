/**
 * @fileoverview Hono user settings API routes.
 * API endpoints for managing user settings.
 * Mounted at: /api/client/user/settings
 *
 * Uses UserSettingsService for business logic.
 */

import { Hono } from "hono";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import * as UserSettingsService from "../../../services/client/user-settings.service";
import { clientAuth } from "../middleware/client.middleware";
import UserSession from "../../../services/session/UserSession";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "user-settings.api" });

const app = new Hono<AppEnv>();

// ============================================================================
// Routes
// ============================================================================

app.get("/", clientAuth, getUserSettings);
app.put("/", clientAuth, updateUserSettings);
app.post("/", clientAuth, updateUserSettings);
app.get("/key/:key", clientAuth, getUserSetting);
app.put("/key/:key", clientAuth, setUserSetting);
app.delete("/key/:key", clientAuth, deleteUserSetting);

// ============================================================================
// Handlers
// ============================================================================

/**
 * GET /api/client/user/settings
 * Get all settings for a user.
 */
async function getUserSettings(c: AppContext) {
  const email = c.get("email")!;

  try {
    const settings = await UserSettingsService.getUserSettings(email);

    return c.json({
      success: true,
      data: { settings },
      timestamp: new Date(),
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error(err, `Error fetching settings for user ${email}:`);
    return c.json(
      {
        success: false,
        message: "Failed to fetch user settings",
        timestamp: new Date(),
      },
      500,
    );
  }
}

/**
 * PUT/POST /api/client/user/settings
 * Update settings for a user.
 */
async function updateUserSettings(c: AppContext) {
  const email = c.get("email")!;

  try {
    const body = await c.req.json().catch(() => ({}));
    const { settings } = body as { settings?: Record<string, unknown> };

    if (!settings || typeof settings !== "object") {
      return c.json(
        {
          success: false,
          message: "Settings object required",
        },
        400,
      );
    }

    const updatedSettings = await UserSettingsService.updateUserSettings(email, settings);

    // If an active session exists, apply session bridges (metric_system_enabled, default_wearable)
    const session = UserSession.getById(email);
    if (session) {
      await session.userSettingsManager.onSettingsUpdatedViaRest(settings);
    }

    return c.json({
      success: true,
      data: { settings: updatedSettings },
      timestamp: new Date(),
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error(err, `Error updating settings for user ${email}:`);

    if (error instanceof Error && error.message === "User not found") {
      return c.json(
        {
          success: false,
          message: "User not found",
          timestamp: new Date(),
        },
        404,
      );
    }

    return c.json(
      {
        success: false,
        message: "Failed to update user settings",
        timestamp: new Date(),
      },
      500,
    );
  }
}

/**
 * GET /api/client/user/settings/key/:key
 * Get a specific setting by key.
 */
async function getUserSetting(c: AppContext) {
  const email = c.get("email")!;
  const key = c.req.param("key");

  if (!key) {
    return c.json(
      {
        success: false,
        message: "Setting key required",
      },
      400,
    );
  }

  try {
    const value = await UserSettingsService.getUserSetting(email, key);
    return c.json({
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
    return c.json(
      {
        success: false,
        message: "Failed to fetch user setting",
        timestamp: new Date(),
      },
      500,
    );
  }
}

/**
 * PUT /api/client/user/settings/key/:key
 * Set a specific setting.
 */
async function setUserSetting(c: AppContext) {
  const email = c.get("email")!;
  const key = c.req.param("key");

  if (!key) {
    return c.json(
      {
        success: false,
        message: "Setting key required",
      },
      400,
    );
  }

  try {
    const body = await c.req.json().catch(() => ({}));
    const { value } = body as { value?: unknown };

    await UserSettingsService.setUserSetting(email, key, value);

    return c.json({
      success: true,
      data: { key, value },
      timestamp: new Date(),
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error(err, `Error setting ${key} for user ${email}:`);
    return c.json(
      {
        success: false,
        message: "Failed to set user setting",
        timestamp: new Date(),
      },
      500,
    );
  }
}

/**
 * DELETE /api/client/user/settings/key/:key
 * Delete a specific setting.
 */
async function deleteUserSetting(c: AppContext) {
  const email = c.get("email")!;
  const key = c.req.param("key");

  if (!key) {
    return c.json(
      {
        success: false,
        message: "Setting key required",
      },
      400,
    );
  }

  try {
    await UserSettingsService.deleteUserSetting(email, key);

    return c.json({
      success: true,
      data: { key, deleted: true },
      timestamp: new Date(),
    });
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error(err, `Error deleting setting ${key} for user ${email}:`);
    return c.json(
      {
        success: false,
        message: "Failed to delete user setting",
        timestamp: new Date(),
      },
      500,
    );
  }
}

export default app;
