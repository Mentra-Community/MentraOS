/**
 * @fileoverview App WebSocket service that handles WebSocket connections from Third-Party Applications.
 * This service manages App authentication, message processing, and session management.
 *
 * NOTE: Message handling logic has been extracted to handlers/app-message-handler.ts
 * This service now focuses on connection lifecycle only (Issue 009-001).
 */

import { IncomingMessage } from "http";

import WebSocket from "ws";

import {
  AppConnectionInit,
  AppConnectionError,
  AppToCloudMessage,
  AppToCloudMessageType,
  CloudToAppMessageType,
} from "@mentra/sdk";

import { logger as rootLogger } from "../logging/pino-logger";
import UserSession from "../session/UserSession";

const SERVICE_NAME = "websocket-app.service";
const logger = rootLogger.child({ service: SERVICE_NAME });

// AppErrorCode is now exported from handlers/app-message-handler.ts
// Re-export for backward compatibility
export { AppErrorCode } from "../session/handlers/app-message-handler";

/**
 * JWT payload structure for App authentication
 */
interface AppJwtPayload {
  packageName: string;
  apiKey: string;
}

interface AppIncomingMessage extends IncomingMessage {
  appJwtPayload?: AppJwtPayload;
  userId?: string;
  sessionId?: string;
}

/**
 * Service that handles App WebSocket connections
 *
 * This service focuses on connection lifecycle management only.
 * Message routing is delegated to UserSession.handleAppMessage()
 * which uses handlers/app-message-handler.ts for the actual handling.
 */
export class AppWebSocketService {
  private static instance: AppWebSocketService;
  private logger = rootLogger.child({ service: SERVICE_NAME });

  /**
   * Get the singleton instance of AppWebSocketService
   */
  static getInstance(): AppWebSocketService {
    if (!AppWebSocketService.instance) {
      AppWebSocketService.instance = new AppWebSocketService();
    }
    return AppWebSocketService.instance;
  }

  /**
   * Handle a new App WebSocket connection
   *
   * @param ws WebSocket connection
   * @param request HTTP request object
   */
  async handleConnection(ws: WebSocket, request: AppIncomingMessage): Promise<void> {
    logger.info("New App WebSocket connection");

    // Get user session if we have a sessionId
    let userSession: UserSession | undefined = undefined;

    // Apps using new SDK connecting to the cloud will send a JWT token in the request headers.
    try {
      // Check if the request has a valid JWT token.
      const appJwtPayload = request?.appJwtPayload as AppJwtPayload;

      if (appJwtPayload) {
        logger.info("App WebSocket connection with JWT token");
        const userId = request?.userId as string;
        const sessionId = request?.sessionId as string;

        // Ensure there is an existing userSession for the app to connect to.
        userSession = UserSession.getById(userId);
        if (!userSession) {
          logger.error({ request }, "User session not found for App message");
          this.sendError(ws, "SESSION_NOT_FOUND", "Session not found");
          return;
        }

        // Create ConnectionInit message, and send to the app manager to handle it.
        const initMessage: AppConnectionInit = {
          type: AppToCloudMessageType.CONNECTION_INIT,
          packageName: appJwtPayload.packageName,
          sessionId: sessionId,
          apiKey: appJwtPayload.apiKey,
        };
        await userSession.appManager.handleAppInit(ws, initMessage);
        // Note: AppSession.handleConnect() now handles reconnect timestamp for subscription grace
      }
    } catch (error) {
      logger.error(error, "Error processing App connection request");
      ws.close(1011, "Internal server error");
      return;
    }

    // Set up message handler
    ws.on("message", async (data: WebSocket.Data) => {
      try {
        // Parse the incoming message
        const message = JSON.parse(data.toString()) as AppToCloudMessage;

        // Check if it's old auth via App Init message.
        if (message.type === AppToCloudMessageType.CONNECTION_INIT) {
          const initMessage = message as AppConnectionInit;
          // Parse session ID to get user session ID
          const sessionParts = initMessage.sessionId.split("-");
          const userId = sessionParts[0];
          if (sessionParts.length < 2) {
            logger.error({ service: SERVICE_NAME, message }, `Invalid session ID format: ${initMessage.sessionId}`);
            ws.close(1008, "Invalid session ID format");
            return;
          }

          userSession = UserSession.getById(userId);
          if (!userSession) {
            logger.error({ request, message }, "User session not found for App message");
            this.sendError(ws, "SESSION_NOT_FOUND", "Session not found");
            return;
          }
          await userSession.appManager.handleAppInit(ws, initMessage);
          // Note: AppSession.handleConnect() now handles reconnect timestamp for subscription grace
        } else {
          // If we don't have a user session, we can't process other messages.
          if (!userSession) {
            logger.error({ request, data }, "User session not found for App message");
            this.sendError(ws, "SESSION_NOT_FOUND", "Session not found");
            return;
          }

          // Delegate message handling to UserSession
          // This keeps the WebSocket service focused on connection lifecycle
          await userSession.handleAppMessage(ws as any, message);
        }
      } catch (error) {
        logger.error(error, "Unexpected error processing App message");
        logger.debug({ service: SERVICE_NAME, data }, "[debug] Unexpected error processing App message");
        // General error handling when we can't even parse the message
        ws.close(1011, "Internal server error");
      }
    });
  }

  // NOTE: handleAppMessage and handleSubscriptionUpdate have been moved to:
  // - UserSession.handleAppMessage() which delegates to
  // - handlers/app-message-handler.ts
  //
  // This keeps the WebSocket service focused on connection lifecycle only.

  /**
   * Send an error response to the App client
   *
   * @param ws WebSocket connection
   * @param code Error code
   * @param message Error message
   */
  private sendError(ws: WebSocket, code: string, message: string): void {
    try {
      const errorResponse: AppConnectionError = {
        type: CloudToAppMessageType.CONNECTION_ERROR,
        code: code,
        message: message,
        timestamp: new Date(),
      };
      ws.send(JSON.stringify(errorResponse));
      // Close the connection with an appropriate code
      ws.close(1008, message);
    } catch (error) {
      logger.error(error, "Failed to send error response");
      // Try to close the connection anyway
      try {
        ws.close(1011, "Internal server error");
      } catch (closeError) {
        logger.error(closeError, "Failed to close WebSocket connection");
      }
    }
  }
}

export default AppWebSocketService;
