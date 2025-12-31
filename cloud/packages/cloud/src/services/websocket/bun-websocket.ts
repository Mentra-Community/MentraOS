/**
 * @fileoverview Bun native WebSocket handlers for glasses and app connections.
 *
 * This module implements WebSocket handling using Bun's native ServerWebSocket API,
 * replacing the Node.js `ws` package for better performance.
 *
 * Key features:
 * - Native Bun WebSocket performance (3-5x faster than ws)
 * - Type-safe per-connection data via ws.data
 * - Built-in backpressure handling via drain()
 * - Clean upgrade flow without request hacks
 */

import jwt from "jsonwebtoken";

import {
  CloudToGlassesMessageType,
  CloudToAppMessageType,
  ConnectionAck,
  GlassesToCloudMessage,
  GlassesToCloudMessageType,
  AppToCloudMessage,
  AppToCloudMessageType,
  AppConnectionInit,
} from "@mentra/sdk";

import { SYSTEM_DASHBOARD_PACKAGE_NAME } from "../core/app.service";
import { logger as rootLogger } from "../logging/pino-logger";
import { PosthogService } from "../logging/posthog.service";
import UserSession from "../session/UserSession";

import type {
  GlassesWebSocketData,
  AppWebSocketData,
  GlassesServerWebSocket,
  AppServerWebSocket,
  CloudServerWebSocket,
} from "./types";

const logger = rootLogger.child({ service: "bun-websocket" });

const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET || "";

// Grace period for glasses reconnection (1 minute)
const RECONNECT_GRACE_PERIOD_MS = 1000 * 60 * 1;

// Enable grace period cleanup
const GRACE_PERIOD_CLEANUP_ENABLED = true;

/**
 * Handle WebSocket upgrade requests.
 * Returns true if upgrade was successful, false otherwise.
 */
export function handleUpgrade(req: Request, server: any): Response | undefined {
  const url = new URL(req.url);
  const path = url.pathname;

  if (path === "/glasses-ws") {
    return handleGlassesUpgrade(req, server, url);
  } else if (path === "/app-ws") {
    return handleAppUpgrade(req, server, url);
  }

  return new Response("Unknown WebSocket path", { status: 404 });
}

/**
 * Handle glasses WebSocket upgrade
 */
function handleGlassesUpgrade(req: Request, server: any, url: URL): Response | undefined {
  const token = req.headers.get("authorization")?.split(" ")[1] || url.searchParams.get("token");

  if (!token) {
    logger.warn("Glasses upgrade rejected: no token");
    return new Response(
      JSON.stringify({
        type: CloudToGlassesMessageType.CONNECTION_ERROR,
        message: "No core token provided",
        timestamp: new Date(),
      }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  try {
    const payload = jwt.verify(token, AUGMENTOS_AUTH_JWT_SECRET) as any;
    const userId = payload.email;

    if (!userId) {
      logger.warn("Glasses upgrade rejected: no userId in token");
      return new Response(
        JSON.stringify({
          type: CloudToGlassesMessageType.CONNECTION_ERROR,
          message: "Invalid core token - no user ID",
          timestamp: new Date(),
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }

    const livekitRequested = url.searchParams.get("livekit") === "true" || req.headers.get("livekit") === "true";

    if (livekitRequested) {
      logger.info({ userId, feature: "livekit" }, "Client requested LiveKit transport");
    }

    const upgraded = server.upgrade(req, {
      data: {
        type: "glasses",
        userId,
        livekitRequested,
      } as GlassesWebSocketData,
    });

    if (upgraded) {
      logger.debug({ userId }, "Glasses WebSocket upgrade successful");
      return undefined; // Upgrade successful
    }

    return new Response("WebSocket upgrade failed", { status: 500 });
  } catch (error) {
    logger.warn({ error }, "Glasses upgrade rejected: invalid token");
    return new Response(
      JSON.stringify({
        type: CloudToGlassesMessageType.CONNECTION_ERROR,
        message: "Invalid core token",
        timestamp: new Date(),
      }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }
}

/**
 * Handle app WebSocket upgrade
 */
function handleAppUpgrade(req: Request, server: any, _url: URL): Response | undefined {
  const authHeader = req.headers.get("authorization");
  const userId = req.headers.get("x-user-id") || "";
  const sessionId = req.headers.get("x-session-id") || "";

  let appJwtPayload: { packageName: string; apiKey: string } | undefined;

  // If we have auth header, try to validate JWT
  if (authHeader?.startsWith("Bearer ")) {
    const appJwt = authHeader.substring(7);

    // Check for required headers when using JWT auth
    if (!userId || !sessionId) {
      logger.error("Missing userId or sessionId in app request headers");
      return new Response(
        JSON.stringify({
          type: "tpa_connection_error",
          code: "MISSING_HEADERS",
          message: "Missing userId or sessionId in request headers",
          timestamp: new Date(),
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }

    try {
      appJwtPayload = jwt.verify(appJwt, AUGMENTOS_AUTH_JWT_SECRET) as {
        packageName: string;
        apiKey: string;
      };
      logger.debug({ packageName: appJwtPayload.packageName }, "App JWT authentication successful");
    } catch (jwtError) {
      if (jwtError instanceof jwt.JsonWebTokenError) {
        logger.warn({ error: jwtError }, "Invalid JWT token for App WebSocket connection");
        return new Response(
          JSON.stringify({
            type: "tpa_connection_error",
            code: "JWT_INVALID",
            message: "Invalid JWT token: " + jwtError.message,
            timestamp: new Date(),
          }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        );
      }
      // For other errors, continue without failing (backward compatibility)
      logger.error({ error: jwtError }, "Error verifying App JWT token");
    }
  }

  // Allow upgrade for both JWT-authenticated and legacy CONNECTION_INIT flows
  const upgraded = server.upgrade(req, {
    data: {
      type: "app",
      userId,
      sessionId,
      appJwtPayload,
    } as AppWebSocketData,
  });

  if (upgraded) {
    logger.debug({ userId, hasJwt: !!appJwtPayload }, "App WebSocket upgrade successful");
    return undefined;
  }

  return new Response("WebSocket upgrade failed", { status: 500 });
}

/**
 * Bun WebSocket handlers configuration
 */
export const websocketHandlers = {
  /**
   * Called when a WebSocket connection is opened
   */
  async open(ws: CloudServerWebSocket) {
    if (ws.data.type === "glasses") {
      await handleGlassesOpen(ws as GlassesServerWebSocket);
    } else if (ws.data.type === "app") {
      await handleAppOpen(ws as AppServerWebSocket);
    }
  },

  /**
   * Called when a message is received
   */
  async message(ws: CloudServerWebSocket, message: string | Buffer) {
    if (ws.data.type === "glasses") {
      await handleGlassesMessage(ws as GlassesServerWebSocket, message);
    } else if (ws.data.type === "app") {
      await handleAppMessage(ws as AppServerWebSocket, message);
    }
  },

  /**
   * Called when the connection is closed
   */
  close(ws: CloudServerWebSocket, code: number, reason: string) {
    if (ws.data.type === "glasses") {
      handleGlassesClose(ws as GlassesServerWebSocket, code, reason);
    } else if (ws.data.type === "app") {
      handleAppClose(ws as AppServerWebSocket, code, reason);
    }
  },

  /**
   * Called when backpressure is relieved (can resume sending)
   */
  drain(ws: CloudServerWebSocket) {
    logger.debug({ userId: ws.data.userId, type: ws.data.type }, "WebSocket drain - backpressure relieved");
  },

  /**
   * Called when a pong is received in response to a ping
   */
  pong(ws: CloudServerWebSocket, _data: Buffer) {
    if (ws.data.type === "glasses") {
      handleGlassesPong(ws as GlassesServerWebSocket);
    }
    // Apps don't need pong handling currently
  },

  // WebSocket configuration
  idleTimeout: 120, // 2 minutes
  sendPings: true, // Bun will send pings automatically
  maxPayloadLength: 16 * 1024 * 1024, // 16 MB max message size
};

// ============================================================================
// Glasses Handlers
// ============================================================================

/**
 * Handle glasses WebSocket connection open
 */
async function handleGlassesOpen(ws: GlassesServerWebSocket): Promise<void> {
  const { userId, livekitRequested } = ws.data;

  try {
    // Create or reconnect user session
    const { userSession, reconnection } = await UserSession.createOrReconnect(ws as any, userId);

    // Store LiveKit preference
    userSession.livekitRequested = livekitRequested;

    userSession.logger.info(
      { reconnection, livekitRequested },
      `Glasses WebSocket connection opened for user: ${userId}`,
    );

    // Handle connection initialization
    await handleGlassesConnectionInit(userSession, ws, reconnection, livekitRequested);

    // Track connection in analytics
    PosthogService.trackEvent("glasses_connection", userId, {
      sessionId: userSession.sessionId,
      timestamp: new Date().toISOString(),
      reconnection,
    });
  } catch (error) {
    logger.error({ error, userId }, "Error handling glasses connection open");
    ws.close(1011, "Internal server error");
  }
}

/**
 * Handle glasses connection initialization (send ACK, start apps)
 */
async function handleGlassesConnectionInit(
  userSession: UserSession,
  ws: GlassesServerWebSocket,
  reconnection: boolean,
  livekitRequested: boolean,
): Promise<void> {
  if (!reconnection) {
    // Start dashboard app
    try {
      await userSession.appManager.startApp(SYSTEM_DASHBOARD_PACKAGE_NAME);
    } catch (error) {
      userSession.logger.error({ error }, "Error starting dashboard app");
    }

    // Start previously running apps
    try {
      await userSession.appManager.startPreviouslyRunningApps();
    } catch (error) {
      userSession.logger.error({ error }, "Error starting user apps");
    }

    // Track connection event
    PosthogService.trackEvent("connected", userSession.userId, {
      sessionId: userSession.sessionId,
      timestamp: new Date().toISOString(),
    });
  }

  // Handle reconnection - check LiveKit bridge status
  if (reconnection) {
    try {
      const hadBridge =
        typeof userSession.liveKitManager.getBridgeClient === "function" &&
        !!userSession.liveKitManager.getBridgeClient();

      if (hadBridge || livekitRequested) {
        const status = await userSession.liveKitManager.getBridgeStatus?.();
        userSession.logger.info({ feature: "livekit", status, reconnection }, "Reconnect: bridge status");

        if (!status || status.connected === false) {
          await userSession.liveKitManager.rejoinBridge?.();
          userSession.logger.info({ feature: "livekit" }, "Reconnect: bridge rejoin attempted");
        } else {
          userSession.logger.info({ feature: "livekit" }, "Reconnect: bridge healthy, keeping session");
        }
      }
    } catch (err) {
      userSession.logger.warn({ feature: "livekit", err }, "Reconnect: bridge status check failed");
    }
  }
  // Testing client livekit reconnection logic.
  // if (reconnection)
  //   return userSession.logger.warn({ feature: "livekit" }, "Reconnecting, skipping CONNECTION_ACK message");

  // Prepare ACK message
  const ackMessage: ConnectionAck = {
    type: CloudToGlassesMessageType.CONNECTION_ACK,
    sessionId: userSession.sessionId,
    timestamp: new Date(),
  };

  // Include UDP endpoint if configured
  const udpHost = process.env.UDP_HOST;
  const udpPort = process.env.UDP_PORT ? parseInt(process.env.UDP_PORT, 10) : 8000;
  if (udpHost) {
    (ackMessage as any).udpHost = udpHost;
    (ackMessage as any).udpPort = udpPort;
    userSession.logger.info({ udpHost, udpPort, feature: "udp-audio" }, "Included UDP endpoint in CONNECTION_ACK");
  }

  // Include LiveKit info if requested
  if (livekitRequested) {
    try {
      const livekitInfo = await userSession.liveKitManager.handleLiveKitInit();
      if (livekitInfo) {
        (ackMessage as any).livekit = {
          url: livekitInfo.url,
          roomName: livekitInfo.roomName,
          token: livekitInfo.token,
        };
        userSession.logger.info(
          { url: livekitInfo.url, roomName: livekitInfo.roomName, feature: "livekit" },
          "Included LiveKit info in CONNECTION_ACK",
        );
      }
    } catch (error) {
      userSession.logger.warn({ error, feature: "livekit" }, "Failed to initialize LiveKit for CONNECTION_ACK");
    }
  }

  ws.send(JSON.stringify(ackMessage));
}

/**
 * Handle glasses WebSocket message
 */
async function handleGlassesMessage(ws: GlassesServerWebSocket, message: string | Buffer): Promise<void> {
  const { userId } = ws.data;
  const userSession = UserSession.getById(userId);

  if (!userSession) {
    logger.error({ userId }, "No user session found for glasses message");
    return;
  }

  try {
    // Handle binary message (audio data)
    if (message instanceof Buffer || message instanceof ArrayBuffer) {
      userSession.audioManager.processAudioData(message);
      return;
    }

    // Parse text message
    const messageStr = typeof message === "string" ? message : message.toString();
    const parsed = JSON.parse(messageStr) as GlassesToCloudMessage;

    // Handle connection init specially (re-init after reconnect)
    if (parsed.type === GlassesToCloudMessageType.CONNECTION_INIT) {
      userSession.logger.info("Received CONNECTION_INIT from glasses");
      await handleGlassesConnectionInit(userSession, ws, true, userSession.livekitRequested || false);
      return;
    }

    // Delegate all other messages to UserSession
    await userSession.handleGlassesMessage(parsed);
  } catch (error) {
    userSession.logger.error({ error }, "Error processing glasses message");
  }
}

/**
 * Handle glasses pong response
 */
function handleGlassesPong(ws: GlassesServerWebSocket): void {
  const { userId } = ws.data;
  const userSession = UserSession.getById(userId);

  if (userSession) {
    // Handle pong - updates lastPongTime and resets timeout timer
    userSession.handlePong();
  }
}

/**
 * Handle glasses WebSocket close
 */
function handleGlassesClose(ws: GlassesServerWebSocket, code: number, reason: string): void {
  const { userId } = ws.data;
  const userSession = UserSession.getById(userId);

  logger.info({ userId, code, reason }, "Glasses WebSocket closed");

  if (!userSession) {
    return;
  }

  userSession.logger.warn({ code, reason }, "Glasses connection closed");

  // Mark session as disconnected
  userSession.disconnectedAt = new Date();

  // Clear any existing cleanup timer
  if (userSession.cleanupTimerId) {
    clearTimeout(userSession.cleanupTimerId);
    userSession.cleanupTimerId = undefined;
  }

  // Set up grace period cleanup
  if (!GRACE_PERIOD_CLEANUP_ENABLED) {
    userSession.logger.debug("Grace period cleanup disabled");
    return;
  }

  userSession.cleanupTimerId = setTimeout(() => {
    userSession.logger.debug("Cleanup grace period expired");

    // Check if user reconnected
    if (!userSession.disconnectedAt) {
      userSession.logger.debug("User reconnected, skipping cleanup");
      if (userSession.cleanupTimerId) {
        clearTimeout(userSession.cleanupTimerId);
        userSession.cleanupTimerId = undefined;
      }
      return;
    }

    userSession.logger.info("User did not reconnect, disposing session");
    userSession.dispose();
  }, RECONNECT_GRACE_PERIOD_MS);
}

// ============================================================================
// App Handlers
// ============================================================================

/**
 * Handle app WebSocket connection open
 */
async function handleAppOpen(ws: AppServerWebSocket): Promise<void> {
  const { userId, sessionId, appJwtPayload } = ws.data;

  logger.info({ userId, hasJwt: !!appJwtPayload }, "App WebSocket connection opened");

  // If we have JWT auth, handle init immediately
  if (appJwtPayload && userId && sessionId) {
    const userSession = UserSession.getById(userId);
    if (!userSession) {
      logger.error({ userId }, "User session not found for app connection");
      ws.send(
        JSON.stringify({
          type: CloudToAppMessageType.CONNECTION_ERROR,
          code: "SESSION_NOT_FOUND",
          message: "Session not found",
          timestamp: new Date(),
        }),
      );
      ws.close(1008, "Session not found");
      return;
    }

    // Create connection init message
    const initMessage: AppConnectionInit = {
      type: AppToCloudMessageType.CONNECTION_INIT,
      packageName: appJwtPayload.packageName,
      sessionId: sessionId,
      apiKey: appJwtPayload.apiKey,
    };

    try {
      await userSession.appManager.handleAppInit(ws as any, initMessage);
      // Store package name in ws.data for later use
      ws.data.packageName = appJwtPayload.packageName;
    } catch (error) {
      logger.error({ error, packageName: appJwtPayload.packageName }, "Error handling app init");
      ws.close(1011, "Internal server error");
    }
  }
  // Otherwise wait for CONNECTION_INIT message (legacy flow)
}

/**
 * Handle app WebSocket message
 */
async function handleAppMessage(ws: AppServerWebSocket, message: string | Buffer): Promise<void> {
  const { userId, packageName } = ws.data;

  try {
    const parsed = JSON.parse(message.toString()) as AppToCloudMessage;

    // Handle CONNECTION_INIT for legacy apps
    if (parsed.type === AppToCloudMessageType.CONNECTION_INIT) {
      const initMessage = parsed as AppConnectionInit;

      // Parse session ID to get user ID
      const sessionParts = initMessage.sessionId.split("-");
      const parsedUserId = sessionParts[0];

      if (sessionParts.length < 2) {
        logger.error({ sessionId: initMessage.sessionId }, "Invalid session ID format");
        ws.close(1008, "Invalid session ID format");
        return;
      }

      const userSession = UserSession.getById(parsedUserId);
      if (!userSession) {
        logger.error({ userId: parsedUserId }, "User session not found for app message");
        ws.send(
          JSON.stringify({
            type: CloudToAppMessageType.CONNECTION_ERROR,
            code: "SESSION_NOT_FOUND",
            message: "Session not found",
            timestamp: new Date(),
          }),
        );
        ws.close(1008, "Session not found");
        return;
      }

      // Update ws.data with parsed info
      ws.data.userId = parsedUserId;
      ws.data.packageName = initMessage.packageName;

      await userSession.appManager.handleAppInit(ws as any, initMessage);
      return;
    }

    // For other messages, we need an existing session
    const userSession = UserSession.getById(userId || ws.data.userId);
    if (!userSession) {
      logger.error({ userId }, "User session not found for app message");
      ws.send(
        JSON.stringify({
          type: CloudToAppMessageType.CONNECTION_ERROR,
          code: "SESSION_NOT_FOUND",
          message: "Session not found",
          timestamp: new Date(),
        }),
      );
      return;
    }

    // Delegate message handling to UserSession
    await userSession.handleAppMessage(ws as any, parsed);
  } catch (error) {
    logger.error({ error, userId, packageName }, "Error processing app message");
    ws.close(1011, "Internal server error");
  }
}

/**
 * Handle app WebSocket close
 */
function handleAppClose(ws: AppServerWebSocket, code: number, reason: string): void {
  const { userId, packageName } = ws.data;

  logger.info({ userId, packageName, code, reason }, "App WebSocket closed");

  // App disconnect is handled by AppSession's own close handler
  // which is set up when the WebSocket is passed to AppSession
}
