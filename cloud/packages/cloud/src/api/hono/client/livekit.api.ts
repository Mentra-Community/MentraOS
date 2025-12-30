/**
 * @fileoverview Hono LiveKit API routes.
 * LiveKit endpoints for client APIs.
 * Mounted at: /api/client/livekit
 */

import { Hono } from "hono";
import * as LiveKitService from "../../../services/client/livekit.service";
import { logger as rootLogger } from "../../../services/logging/pino-logger";
import { clientAuth, requireUserSession } from "../middleware/client.middleware";
import type { AppEnv, AppContext } from "../../../types/hono";

const logger = rootLogger.child({ service: "livekit.api" });

const app = new Hono<AppEnv>();

// ============================================================================
// Routes
// ============================================================================

app.get("/token", clientAuth, mintToken);
app.post("/test/mint-token", mintTestToken);
app.get("/room-status", clientAuth, requireUserSession, getRoomStatus);

// ============================================================================
// Handlers
// ============================================================================

/**
 * GET /api/client/livekit/token
 * Mint a LiveKit token for the authenticated user.
 */
async function mintToken(c: AppContext) {
  const email = c.get("email")!;

  try {
    const roomName = email; // Use email as room name for now

    if (!email || typeof email !== "string" || !roomName || typeof roomName !== "string") {
      return c.json(
        {
          success: false,
          message: "email and roomName are required",
          timestamp: new Date(),
        },
        400,
      );
    }

    const { url, token, identity } = await LiveKitService.mintToken(email, roomName);

    return c.json({
      success: true,
      data: { url, token, room: roomName, identity },
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(error, "Error minting LiveKit token");
    return c.json(
      {
        success: false,
        message: "Failed to mint token",
        timestamp: new Date(),
      },
      500,
    );
  }
}

/**
 * POST /api/client/livekit/test/mint-token
 * Mint a test LiveKit token (non-production only).
 * Body: { email: string, roomName: string }
 */
async function mintTestToken(c: AppContext) {
  // Only work in non-production environment
  if (process.env.NODE_ENV === "production") {
    return c.json(
      {
        success: false,
        message: "Not allowed in production",
        timestamp: new Date(),
      },
      400,
    );
  }

  try {
    const body = await c.req.json().catch(() => ({}));
    const { email, roomName } = body as { email?: string; roomName?: string };

    if (!email || typeof email !== "string" || !roomName || typeof roomName !== "string") {
      return c.json(
        {
          success: false,
          message: "email and roomName are required",
          timestamp: new Date(),
        },
        400,
      );
    }

    // Optional feature flag to disable
    if (process.env.LIVEKIT_TEST_ENABLED === "false") {
      return c.json(
        {
          success: false,
          message: "Not found",
          timestamp: new Date(),
        },
        404,
      );
    }

    const { url, token, identity } = await LiveKitService.mintTestToken(email, roomName);

    return c.json({
      success: true,
      data: { url, token, room: roomName, identity },
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(error, "Error minting LiveKit test token");
    return c.json(
      {
        success: false,
        message: "Failed to mint token",
        timestamp: new Date(),
      },
      500,
    );
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
async function getRoomStatus(c: AppContext) {
  const userSession = c.get("userSession")!;
  const email = c.get("email")!;

  try {
    if (!userSession.liveKitManager) {
      return c.json(
        {
          success: false,
          message: "LiveKitManager not available for this session",
          timestamp: new Date(),
        },
        500,
      );
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

    return c.json({
      success: true,
      data: roomStatus,
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error(error, "Error getting LiveKit room status");
    return c.json(
      {
        success: false,
        message: "Failed to get room status",
        timestamp: new Date(),
      },
      500,
    );
  }
}

export default app;
