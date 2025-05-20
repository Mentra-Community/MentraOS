/**
 * Dashboard Service
 * 
 * Exports the DashboardManager class and handler functions for WebSocketService integration.
 * Uses a per-session approach where each user session has its own DashboardManager.
 */
import { TpaToCloudMessage } from '@augmentos/sdk';
import { logger } from '@augmentos/utils';
import { ExtendedUserSession } from '../core/session.service';
import { DashboardManager } from './DashboardManager';

// Export DashboardManager for session creation
export { DashboardManager };

/**
 * Handles TPA messages for dashboard functionality
 * This function will be called from WebSocketService
 * 
 * @param message TPA message
 * @param userSession User session that received the message
 * @returns True if the message was handled, false otherwise
 */
export function handleTpaMessage(message: TpaToCloudMessage, userSession: ExtendedUserSession): boolean {
  try {
    if (!userSession.dashboardManager) {
      logger.error(`Dashboard manager not found for session ${userSession.sessionId}`);
      return false;
    }
    
    // Forward the message to the session's dashboard manager
    return userSession.dashboardManager.handleTpaMessage(message);
  } catch (error) {
    logger.error(`Error routing dashboard message to session ${userSession.sessionId}:`, error);
    return false;
  }
}

/**
 * Handles TPA disconnection to clean up dashboard content
 * This function will be called from WebSocketService
 * 
 * @param packageName TPA package name
 * @param userSession User session that had the TPA disconnected
 */
export function handleTpaDisconnected(packageName: string, userSession: ExtendedUserSession): void {
  try {
    if (!userSession.dashboardManager) {
      logger.error(`Dashboard manager not found for session ${userSession.sessionId}`);
      return;
    }
    
    // Forward the cleanup request to the session's dashboard manager
    userSession.dashboardManager.handleTpaDisconnected(packageName);
  } catch (error) {
    logger.error(`Error cleaning up dashboard content for TPA ${packageName}:`, error);
  }
}