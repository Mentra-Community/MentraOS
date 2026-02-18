/**
 * @fileoverview Glasses WebSocket service that handles WebSocket connections from smart glasses clients.
 * This service manages glasses authentication, message processing, and session management.
 */

import { IncomingMessage } from "http";

import WebSocket from "ws";

import {
  CloudToGlassesMessageType,
  ConnectionAck,
  ConnectionError,
  ConnectionInit,
  GlassesToCloudMessage,
  GlassesToCloudMessageType,
} from "@mentra/sdk";

import { SYSTEM_DASHBOARD_PACKAGE_NAME } from "../core/app.service";
import { logger as rootLogger } from "../logging/pino-logger";
import { PosthogService } from "../logging/posthog.service";
import UserSession from "../session/UserSession";

const SERVICE_NAME = "websocket-glasses.service";
const logger = rootLogger.child({ service: SERVICE_NAME });

// Constants
const RECONNECT_GRACE_PERIOD_MS = 1000 * 60 * 1; // 1 minute

// SAFETY FLAG: Set to false to disable grace period cleanup entirely
const GRACE_PERIOD_CLEANUP_ENABLED = true; // Enable auto-cleanup when WebSocket disconnects

/**
 * Error codes for glasses connection issues
 */
export enum GlassesErrorCode {
  INVALID_TOKEN = "INVALID_TOKEN",
  SESSION_ERROR = "SESSION_ERROR",
  MALFORMED_MESSAGE = "MALFORMED_MESSAGE",
  INTERNAL_ERROR = "INTERNAL_ERROR",
}

/**
 * Singleton Service that handles all glasses WebSocket connections.
 */
export class GlassesWebSocketService {
  private static instance: GlassesWebSocketService;

  private constructor() {
    // Private constructor for singleton pattern
  }

  /**
   * Get singleton instance
   */
  static getInstance(): GlassesWebSocketService {
    if (!GlassesWebSocketService.instance) {
      GlassesWebSocketService.instance = new GlassesWebSocketService();
    }
    return GlassesWebSocketService.instance;
  }

  /**
   * Handle new glasses WebSocket connection
   *
   * @param ws WebSocket connection
   * @param request HTTP request for the WebSocket upgrade
   */
  async handleConnection(ws: WebSocket, request: IncomingMessage): Promise<void> {
    try {
      // Get user ID from request (attached during JWT verification)
      const userId = (request as any).userId;
      const livekitRequested = (request as any).livekitRequested || false;

      if (!userId) {
        logger.error({ error: GlassesErrorCode.INVALID_TOKEN, request }, "No user ID provided in request");
        this.sendError(ws, GlassesErrorCode.INVALID_TOKEN, "Authentication failed");
        return;
      }

      // Create or retrieve user session
      const { userSession, reconnection } = await UserSession.createOrReconnect(ws, userId);
      userSession.logger.info(`Glasses WebSocket connection from user: ${userId} (LiveKit: ${livekitRequested})`);

      // Store LiveKit preference in the session
      userSession.livekitRequested = livekitRequested;

      let i = 0;
      // Handle incoming messages
      ws.on("message", (data: WebSocket.Data, isBinary) => {
        try {
          // Handle binary message (audio data)
          if (isBinary) {
            i++;
            // await this.handleBinaryMessage(userSession, data);
            if (i % 10 === 0) {
              logger.debug({ service: "LiveKitManager" }, "[Websocket]Received binary message");
            }
            userSession.audioManager.processAudioData(data);
            return;
          }

          // Parse text message
          const message = JSON.parse(data.toString()) as GlassesToCloudMessage;

          if (message.type === GlassesToCloudMessageType.CONNECTION_INIT) {
            // Handle connection initialization message
            const connectionInitMessage = message as ConnectionInit;
            userSession.logger.info(
              `Received connection init message from glasses: ${JSON.stringify(connectionInitMessage)}`,
            );
            // If this is a reconnection, we can skip the initialization logic
            this.handleConnectionInit(userSession, reconnection, userSession.livekitRequested || false)
              .then(() => {
                userSession.logger.info(`✅ Connection reinitialized for user: ${userSession.userId}`);
              })
              .catch((error) => {
                userSession.logger.error(error, `❌ Failed to reinitialize connection for user: ${userSession.userId}`);
              });
            return;
          }

          // Handle LiveKit init handshake (client requests LiveKit info)
          // if (message.type === GlassesToCloudMessageType.LIVEKIT_INIT) {
          //   userSession.liveKitManager
          //     .handleLiveKitInit()
          //     .then((info) => {
          //       if (!info) return;
          //       const livekitInfo: CloudToGlassesMessage = {
          //         type: CloudToGlassesMessageType.LIVEKIT_INFO,
          //         url: info.url,
          //         roomName: info.roomName,
          //         token: info.token,
          //         timestamp: new Date(),
          //       } as any;
          //       ws.send(JSON.stringify(livekitInfo));
          //       userSession.logger.info({ url: info.url, roomName: info.roomName, feature: 'livekit' }, 'Sent LIVEKIT_INFO (on LIVEKIT_INIT)');
          //     })
          //     .catch((e) => {
          //       userSession.logger.warn({ e, feature: 'livekit' }, 'Failed LIVEKIT_INIT handling');
          //     });
          //   return;
          // }

          // Process the message - delegate to UserSession for routing
          userSession
            .handleGlassesMessage(message)
            .then(() => {
              userSession.logger.debug(
                `✅ Successfully processed message of type: ${message.type} for user: ${userId}`,
              );
            })
            .catch((error) => {
              userSession.logger.error(
                error,
                `❌ Error processing message of type: ${message.type} for user: ${userId}`,
              );
            });
        } catch (error) {
          userSession.logger.error(error, "Error processing glasses message:");
        }
      });

      // Handle connection close
      ws.on("close", (code: number, reason: string) => {
        this.handleGlassesConnectionClose(userSession, code, reason);
      });

      // Handle connection errors
      ws.on("error", (error: Error) => {
        userSession.logger.error(error, "Glasses WebSocket error:");
      });

      // Handle connection initialization
      this.handleConnectionInit(userSession, reconnection, livekitRequested);

      // NOTE: Do not auto-send LIVEKIT_INFO here to avoid unnecessary room usage.

      // Track connection in analytics
      PosthogService.trackEvent("glasses_connection", userId, {
        sessionId: userSession.userId,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error(error, "Error handling glasses connection for user:" + (request as any).userId);
      logger.debug({ service: SERVICE_NAME, request, userId: (request as any).userId }, "Request details");
      this.sendError(ws, GlassesErrorCode.SESSION_ERROR, "Failed to create session");
    }
  }

  // NOTE: handleGlassesMessage has been moved to UserSession.handleGlassesMessage()
  // which delegates to handlers/glasses-message-handler.ts
  // This keeps the WebSocket service focused on connection lifecycle only.

  /**
   * Handle connection init
   *
   * @param userSession User session
   * @param reconnection Whether this is a reconnection
   * @param livekitRequested Whether the client requested LiveKit transport
   */
  private async handleConnectionInit(
    userSession: UserSession,
    reconnection: boolean,
    livekitRequested = false,
  ): Promise<void> {
    if (!reconnection) {
      // Start all the apps that the user has running.
      try {
        // Start the dashboard app, but let's not add to the user's running apps since it's a system app.
        // honestly there should be no annyomous users so if it's an anonymous user we should just not start the dashboard
        await userSession.appManager.startApp(SYSTEM_DASHBOARD_PACKAGE_NAME);
      } catch (error) {
        userSession.logger.error({ error }, `Error starting dashboard app`);
      }

      // Start all the apps that the user has running.
      try {
        await userSession.appManager.startPreviouslyRunningApps();
      } catch (error) {
        userSession.logger.error({ error }, `Error starting user apps`);
      }

      // Transcription is now handled by TranscriptionManager based on app subscriptions
      // No need to preemptively start transcription here

      // Track connection event.
      PosthogService.trackEvent("connected", userSession.userId, {
        sessionId: userSession.sessionId,
        timestamp: new Date().toISOString(),
      });
    }

    // Reconnect path: ensure LiveKit bridge has rejoined if it was kicked
    if (reconnection) {
      try {
        // If we previously had a bridge (or client explicitly requested LiveKit), check status
        const hadBridge =
          typeof userSession.liveKitManager.getBridgeClient === "function" &&
          !!userSession.liveKitManager.getBridgeClient();

        if (hadBridge || livekitRequested) {
          const status = await userSession.liveKitManager.getBridgeStatus?.();
          userSession.logger.info({ feature: "livekit", status, reconnection }, "Reconnect: bridge status");

          // If the bridge is not connected to the room, attempt a rejoin with a fresh token
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

    // Prepare the base ACK message
    const ackMessage: ConnectionAck = {
      type: CloudToGlassesMessageType.CONNECTION_ACK,
      sessionId: userSession.sessionId,
      // userSession: await userSession.snapshotForClient(),
      timestamp: new Date(),
    };

    // If LiveKit was requested, initialize and include the info
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
            {
              url: livekitInfo.url,
              roomName: livekitInfo.roomName,
              feature: "livekit",
            },
            "Included LiveKit info in CONNECTION_ACK",
          );
          userSession.logger.debug(
            {
              ackMessage,
              feature: "connection",
            },
            "Sent CONNECTION_ACK",
          );
        }
      } catch (error) {
        userSession.logger.warn(
          {
            error,
            feature: "livekit",
          },
          "Failed to initialize LiveKit for CONNECTION_ACK",
        );
      }
    }
    // TODO(isaiah): Think about weird edge case where it connects with livekit, then a reconnect without livekit. (should probably never happen, unless they change devices  mid-session and the new device doesn't want livekit)
    userSession.websocket.send(JSON.stringify(ackMessage));
  }

  // NOTE: The following handler methods have been moved to handlers/glasses-message-handler.ts:
  // - getChangedKeys
  // - handleLocalTranscription
  // - handleVad
  // - handleHeadPosition
  // - handleGlassesConnectionState
  // - handleRequestSettings
  // - handleMentraOSSettingsUpdateRequest
  //
  // They are now called via UserSession.handleGlassesMessage() which delegates
  // to the glasses-message-handler module.

  // TODO(isaiah): Implement properly with reconnect grace period logic.
  /**
   * Handle glasses connection close
   *
   * @param userSession User session
   * @param code Close code
   * @param reason Close reason
   */
  private handleGlassesConnectionClose(userSession: UserSession, code: number, reason: string): void {
    userSession.logger.warn(
      { service: SERVICE_NAME, code, reason },
      `[WebsocketGlassesService:handleGlassesConnectionClose]: (${userSession.userId}, ${code}, ${reason}) - Glasses connection closed`,
    );

    // WebSocket is closing - connection state will be handled by WebSocket close event
    userSession.logger.info({ service: SERVICE_NAME, code, reason }, "Phone WebSocket connection closing");

    // Mark session as disconnected
    // Clear any existing cleanup timer
    if (userSession.cleanupTimerId) {
      clearTimeout(userSession.cleanupTimerId);
      userSession.cleanupTimerId = undefined;
    }

    // Disconnecting is probably a network issue and the user will likely reconnect.
    // So we don't want to end the session immediately, but rather wait for a grace period
    // to see if the user reconnects.

    // Mark as disconnected
    userSession.disconnectedAt = new Date();

    // Set cleanup timer if not already set (and if cleanup is enabled)
    if (!GRACE_PERIOD_CLEANUP_ENABLED) {
      userSession.logger.debug(
        { service: SERVICE_NAME },
        `Grace period cleanup disabled by GRACE_PERIOD_CLEANUP_ENABLED=false for user: ${userSession.userId}`,
      );
    } else if (!userSession.cleanupTimerId) {
      userSession.cleanupTimerId = setTimeout(() => {
        userSession.logger.debug(
          { service: SERVICE_NAME },
          `Cleanup grace period expired for user session: ${userSession.userId}`,
        );

        // Check to see if the session has reconnected / if the user is still active.
        const wsState = userSession.websocket?.readyState;
        const wsExists = !!userSession.websocket;
        const wsOpen = wsState === WebSocket.OPEN;
        const wsConnecting = wsState === WebSocket.CONNECTING;

        userSession.logger.debug(
          {
            service: SERVICE_NAME,
            websocketExists: wsExists,
            websocketState: wsState,
            websocketStateNames:
              {
                0: "CONNECTING",
                1: "OPEN",
                2: "CLOSING",
                3: "CLOSED",
              }[wsState] || "UNKNOWN",
            isOpen: wsOpen,
            isConnecting: wsConnecting,
            disconnectedAt: userSession.disconnectedAt,
            timeSinceDisconnect: userSession.disconnectedAt ? Date.now() - userSession.disconnectedAt.getTime() : null,
          },
          `Grace period check: WebSocket state analysis for ${userSession.userId}`,
        );

        // Check if user reconnected by looking at disconnectedAt (more reliable than WebSocket state)
        if (!userSession.disconnectedAt) {
          userSession.logger.debug(
            {
              service: SERVICE_NAME,
              reason: "disconnectedAt_cleared",
            },
            `User session ${userSession.userId} has reconnected (disconnectedAt cleared), skipping cleanup.`,
          );
          clearTimeout(userSession.cleanupTimerId!);
          userSession.cleanupTimerId = undefined;
          return;
        }

        // Fallback: also check WebSocket state for backward compatibility
        if (userSession.websocket && userSession.websocket.readyState === WebSocket.OPEN) {
          userSession.logger.debug(
            {
              service: SERVICE_NAME,
              reason: "websocket_open",
            },
            `User session ${userSession.userId} has reconnected (WebSocket open), skipping cleanup.`,
          );
          clearTimeout(userSession.cleanupTimerId!);
          userSession.cleanupTimerId = undefined;
          return;
        }

        userSession.logger.debug(
          {
            service: SERVICE_NAME,
            finalWebsocketState: wsState,
            websocketExists: wsExists,
            reason: !wsExists ? "no_websocket" : !wsOpen ? "websocket_not_open" : "unknown",
          },
          `User session ${userSession.userId} determined not reconnected, cleaning up session.`,
        );
        // End the session
        // sessionService.endSession(userSession);
        userSession.dispose();
      }, RECONNECT_GRACE_PERIOD_MS);
    }
  }

  /**
   * Send error message to glasses
   *
   * @param ws WebSocket connection
   * @param code Error code
   * @param message Error message
   */
  private sendError(ws: WebSocket, code: GlassesErrorCode, message: string): void {
    try {
      const errorMessage: ConnectionError = {
        type: CloudToGlassesMessageType.CONNECTION_ERROR,
        code,
        message,
        timestamp: new Date(),
      };

      ws.send(JSON.stringify(errorMessage));
      ws.close(1008, message);
    } catch (error) {
      logger.error(error, "Error sending error message to glasses:");

      try {
        ws.close(1011, "Internal server error");
      } catch (closeError) {
        logger.error(closeError, "Error closing WebSocket connection:");
      }
    }
  }
}

// export default GlassesWebSocketService;
