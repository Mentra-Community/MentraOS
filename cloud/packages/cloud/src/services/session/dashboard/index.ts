/**
 * Dashboard Service
 *
 * Exports the DashboardManager class and handler functions for WebSocketService integration.
 * Uses a per-session approach where each user session has its own DashboardManager.
 */
import { AppToCloudMessage } from "@mentra/sdk";
import { logger } from "../../logging/pino-logger";
// import { ExtendedUserSession } from '../session/session.service';
import { DashboardManager } from "./DashboardManager";
import UserSession from "../UserSession";

// Export DashboardManager for session creation
export { DashboardManager };

/**
 * Handles App messages for dashboard functionality
 * This function will be called from WebSocketService
 *
 * @param message App message
 * @param userSession User session that received the message
 * @returns True if the message was handled, false otherwise
 */
export function handleAppMessage(
  message: AppToCloudMessage,
  userSession: UserSession,
): boolean {
  try {
    if (!userSession.dashboardManager) {
      logger.error(
        `Dashboard manager not found for session ${userSession.sessionId}`,
      );
      return false;
    }

    // Forward the message to the session's dashboard manager
    return userSession.dashboardManager.handleAppMessage(message);
  } catch (error) {
    logger.error(
      error,
      `Error routing dashboard message to session ${userSession.sessionId}:`,
    );
    return false;
  }
}

/**
 * Handles App disconnection to clean up dashboard content
 * This function will be called from WebSocketService
 *
 * @param packageName App package name
 * @param userSession User session that had the App disconnected
 */
export function handleAppDisconnected(
  packageName: string,
  userSession: UserSession,
): void {
  try {
    if (!userSession.dashboardManager) {
      logger.error(
        `Dashboard manager not found for session ${userSession.sessionId}`,
      );
      return;
    }

    // Forward the cleanup request to the session's dashboard manager
    userSession.dashboardManager.handleAppDisconnected(packageName);
  } catch (error) {
    logger.error(
      error,
      `Error cleaning up dashboard content for App ${packageName}:`,
    );
  }
}
