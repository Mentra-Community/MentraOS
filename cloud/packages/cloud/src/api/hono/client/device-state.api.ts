/**
 * @fileoverview Hono device-state API routes.
 * API endpoint for device connection state updates from mobile clients.
 * Mounted at: /api/client/device/state
 */

import { Hono } from "hono";
import { GlassesInfo } from "@mentra/types";
import { clientAuth, requireUserSession } from "../middleware/client.middleware";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "device-state.api" });

const app = new Hono<AppEnv>();

// ============================================================================
// Routes
// ============================================================================

app.post("/", clientAuth, requireUserSession, updateDeviceState);

// ============================================================================
// Handlers
// ============================================================================

/**
 * POST /api/client/device/state
 * Update device connection state.
 * Accepts partial updates - only specified properties are changed.
 * Body: Partial<GlassesInfo>
 */
async function updateDeviceState(c: AppContext) {
  const userSession = c.get("userSession")!;
  const reqLogger = c.get("logger") || logger;

  try {
    const deviceStateUpdate = (await c.req.json().catch(() => ({}))) as Partial<GlassesInfo>;

    reqLogger.debug({ feature: "device-state", deviceStateUpdate, function: "updateDeviceState" }, "updateDeviceState");

    // No validation needed - DeviceManager will infer connected state from modelName

    // Update device state via DeviceManager
    await userSession.deviceManager.updateDeviceState(deviceStateUpdate);

    // Return confirmation with current state
    return c.json({
      success: true,
      appliedState: {
        isGlassesConnected: userSession.deviceManager.isGlassesConnected,
        isPhoneConnected: userSession.deviceManager.isPhoneConnected,
        modelName: userSession.deviceManager.getModel(),
        capabilities: userSession.deviceManager.getCapabilities(),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    reqLogger.error({ error, feature: "device-state", userId: userSession.userId }, "Failed to update device state");
    return c.json(
      {
        success: false,
        message: "Failed to update device state",
        timestamp: new Date().toISOString(),
      },
      500,
    );
  }
}

export default app;
