// cloud/src/api/client/livekit.api.ts
// LiveKit endpoints for client APIs
// Mounted at: /api/client/livekit

import { Router, Request, Response } from "express";

import * as LiveKitService from "../../services/client/livekit.service";
import { logger } from "../../services/logging/pino-logger";
import {
  clientAuthWithEmail,
  clientAuthWithUserSession,
  RequestWithEmail,
  RequestWithUserSession,
} from "../middleware/client.middleware";

const router = Router();

// Routes: /api/client/livekit/*
router.get("/token", clientAuthWithEmail, mintToken);
router.post("/test/mint-token", mintTestToken); // only work in non prod environment.
router.get("/room-status", clientAuthWithUserSession, getRoomStatus);

// POST /api/client/livekit/test/mint-token
// Body: { email: string, roomName: string }
// Response: { success: boolean, data?: { url, token, room, identity, expiresAt }, message?: string, timestamp }
async function mintTestToken(req: Request, res: Response) {
  // Only work in non prod environment.
  if (process.env.NODE_ENV === "production") {
    return res.status(400).json({
      success: false,
      message: "Not allowed in production",
      timestamp: new Date(),
    });
  }

  try {
    const { email, roomName } = (req.body ?? {}) as {
      email?: string;
      roomName?: string;
    };
    if (!email || typeof email !== "string" || !roomName || typeof roomName !== "string") {
      return res.status(400).json({
        success: false,
        message: "email and roomName are required",
        timestamp: new Date(),
      });
    }

    // Optional feature flag to disable in prod
    if (process.env.LIVEKIT_TEST_ENABLED === "false") {
      return res.status(404).json({
        success: false,
        message: "Not found",
        timestamp: new Date(),
      });
    }

    const { url, token, identity } = await LiveKitService.mintTestToken(email, roomName);

    return res.json({
      success: true,
      data: { url, token, room: roomName, identity },
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(error, "Error minting LiveKit test token");
    return res.status(500).json({
      success: false,
      message: "Failed to mint token",
      timestamp: new Date(),
    });
  }
}

async function mintToken(req: Request, res: Response) {
  const email = (req as RequestWithEmail).email;
  try {
    const roomName = email; // Use email as room name for now
    if (!email || typeof email !== "string" || !roomName || typeof roomName !== "string") {
      return res.status(400).json({
        success: false,
        message: "email and roomName are required",
        timestamp: new Date(),
      });
    }

    const { url, token, identity } = await LiveKitService.mintToken(email, roomName);

    return res.json({
      success: true,
      data: { url, token, room: roomName, identity },
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(error, "Error minting LiveKit test token");
    return res.status(500).json({
      success: false,
      message: "Failed to mint token",
      timestamp: new Date(),
    });
  }
}

/**
 * GET /api/client/livekit/room-status
 *
 * Debug endpoint to check LiveKit room status for the authenticated user.
 * Uses LiveKit Server SDK to query actual room participants.
 *
 * Response:
 * {
 *   success: boolean,
 *   data: {
 *     roomName: string,
 *     clientInRoom: boolean,      // Is the mobile client in the LiveKit room?
 *     bridgeInRoom: boolean,      // Is the cloud bridge in the room?
 *     participants: string[],     // All participant identities in the room
 *     micEnabled: boolean,        // Is mic enabled in the session?
 *     bridgeConnected: boolean,   // Is the gRPC bridge connected?
 *   },
 *   timestamp: Date
 * }
 *
 * This endpoint is useful for debugging:
 * - Mobile client failed to rejoin LiveKit after WebSocket reconnection
 * - Audio not flowing despite "connected" status
 * - Bridge/client mismatch issues
 */
async function getRoomStatus(req: Request, res: Response) {
  const userSession = (req as RequestWithUserSession).userSession;
  const email = (req as RequestWithEmail).email;

  try {
    if (!userSession.liveKitManager) {
      return res.status(500).json({
        success: false,
        message: "LiveKitManager not available for this session",
        timestamp: new Date(),
      });
    }

    const roomStatus = await userSession.liveKitManager.getRoomStatus();

    logger.info(
      {
        userId: email,
        roomName: roomStatus.roomName,
        clientInRoom: roomStatus.clientInRoom,
        bridgeInRoom: roomStatus.bridgeInRoom,
        participantCount: roomStatus.participants.length,
      },
      "LiveKit room status requested",
    );

    return res.json({
      success: true,
      data: roomStatus,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(error, "Error getting LiveKit room status");
    return res.status(500).json({
      success: false,
      message: "Failed to get room status",
      timestamp: new Date(),
    });
  }
}

export default router;
