// cloud/src/api/client/device-state.api.ts
// API endpoint for device connection state updates from mobile clients

import { Router, Request, Response } from "express";
import { GlassesInfo } from "@mentra/types";
import {
  clientAuthWithUserSession,
  RequestWithUserSession,
} from "../middleware/client.middleware";

const router = Router();

// POST /api/client/device/state
router.post("/", clientAuthWithUserSession, updateDeviceState);

/**
 * Update device connection state
 * Accepts partial updates - only specified properties are changed
 */
async function updateDeviceState(req: Request, res: Response) {
  const _req = req as RequestWithUserSession;
  const { userSession } = _req;
  const deviceStateUpdate = req.body as Partial<GlassesInfo>;
  _req.logger.debug(
    { feature: "device-state", deviceStateUpdate, function: updateDeviceState },
    "updateDeviceState",
  );

  // No validation needed - DeviceManager will infer connected state from modelName

  try {
    // Update device state via DeviceManager
    await userSession.deviceManager.updateDeviceState(deviceStateUpdate);

    // Return confirmation with current state
    return res.json({
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
    _req.logger.error(
      { error, feature: "device-state", userId: userSession.userId },
      "Failed to update device state",
    );
    return res.status(500).json({
      success: false,
      message: "Failed to update device state",
      timestamp: new Date().toISOString(),
    });
  }
}

export default router;
