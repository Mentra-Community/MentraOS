/**
 * TPA Registration Service
 * 
 * Handles TPA server registrations and session recovery.
 * This service manages:
 * - TPA server registrations
 * - Reconnecting TPAs when they restart
 * - Maintaining the registry of active TPA servers
 * - Server heartbeat monitoring
 */

import { WebSocket } from 'ws';
import { 
  TpaConnectionInit, 
  WebhookRequestType,
  UserSession
} from '@augmentos/sdk';
import { tpaServerRegistry, TpaServerRegistration } from '../../models/tpa-server.model';
import appService from './app.service';
import sessionService from './session.service';
import { systemApps } from './system-apps';
import { logger as rootLogger } from "../logging";
const logger = rootLogger.child({ service: 'tpa-registration.service' });

/**
 * Registration request from a TPA server
 */
export interface TpaServerRegistrationRequest {
  // TPA package name (e.g., "org.example.myapp")
  packageName: string;
  
  // API key for authentication
  apiKey: string;
  
  // URL of the TPA's webhook endpoint
  webhookUrl: string;
  
  // Comma-separated list of server URLs this TPA can connect to
  serverUrls: string;
}

/**
 * Registration response to a TPA server
 */
export interface TpaServerRegistrationResponse {
  // Success indicator
  success: boolean;
  
  // Registration ID (if successful)
  registrationId?: string;
  
  // Error message (if unsuccessful)
  error?: string;
}

/**
 * Heartbeat request from a TPA server
 */
export interface TpaServerHeartbeatRequest {
  // Registration ID
  registrationId: string;
}

/**
 * Service for managing TPA server registrations
 */
export class TpaRegistrationService {
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;
  
  constructor() {
    // Start the intervals for cleanup and monitoring
    this.startIntervals();
  }
  
  /**
   * Start maintenance intervals
   */
  private startIntervals(): void {
    // Check for stale registrations every 15 minutes
    this.cleanupInterval = setInterval(() => {
      const cleaned = tpaServerRegistry.cleanupStaleRegistrations();
      if (cleaned > 0) {
        logger.info(`Cleaned up ${cleaned} stale TPA server registrations`);
      }
    }, 15 * 60 * 1000); // 15 minutes
  }
  
  /**
   * Register a new TPA server
   * 
   * @param request - Registration request
   * @returns Registration response
   */
  registerServer(request: TpaServerRegistrationRequest): TpaServerRegistrationResponse {
    try {
      // Validate request
      if (!request.packageName || !request.apiKey || !request.webhookUrl) {
        return {
          success: false,
          error: 'Missing required fields: packageName, apiKey, or webhookUrl'
        };
      }
      
      // Parse server URLs
      const serverUrls = request.serverUrls.split(',').map(url => url.trim());
      
      // Register the server
      const registrationId = tpaServerRegistry.registerServer(
        request.packageName,
        request.apiKey,
        request.webhookUrl,
        serverUrls
      );
      
      return {
        success: true,
        registrationId
      };
    } catch (error) {
      logger.error('Error registering TPA server:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }
  
  /**
   * Process a heartbeat from a TPA server
   * 
   * @param request - Heartbeat request
   * @returns Success flag
   */
  processHeartbeat(request: TpaServerHeartbeatRequest): boolean {
    try {
      const registration = tpaServerRegistry.updateHeartbeat(request.registrationId);
      return registration !== null;
    } catch (error) {
      logger.error('Error processing TPA server heartbeat:', error);
      return false;
    }
  }
  
  /**
   * Handle a TPA connection initialization
   * This method associates the TPA session with a server registration
   * 
   * @param initMessage - TPA connection initialization message
   * @returns Success flag
   */
  handleTpaSessionStart(initMessage: TpaConnectionInit): boolean {
    try {
      // Get registrations for this package
      const registrations = tpaServerRegistry.getRegistrationsByPackage(initMessage.packageName);
      if (registrations.length === 0) {
        logger.debug(`No registered servers found for TPA: ${initMessage.packageName}`);
        return false;
      }
      
      // TODO: When API key system is fully implemented, uncomment this block
      // Find the registration with matching API key
      // const matchingReg = registrations.find(reg => reg.apiKey === initMessage.apiKey);
      // if (!matchingReg) {
      //   logger.debug(`No matching API key found for TPA: ${initMessage.packageName}`);
      //   return false;
      // }
      
      // For now, just use the first registration for this package
      const matchingReg = registrations[0];
      
      // Associate this session with the registration
      return tpaServerRegistry.addSessionToRegistration(
        matchingReg.registrationId, 
        initMessage.sessionId
      );
    } catch (error) {
      logger.error('Error handling TPA session start:', error);
      return false;
    }
  }
  
  /**
   * Handle a TPA session end
   * 
   * @param sessionId - Session ID (userSessionId-packageName)
   * @returns Success flag
   */
  handleTpaSessionEnd(sessionId: string): boolean {
    try {
      // Get registrations for this session
      const registrations = tpaServerRegistry.getRegistrationsBySession(sessionId);
      
      let success = true;
      for (const reg of registrations) {
        // Remove the session from each registration
        const result = tpaServerRegistry.removeSessionFromRegistration(
          reg.registrationId, 
          sessionId
        );
        if (!result) success = false;
      }
      
      return success;
    } catch (error) {
      logger.error('Error handling TPA session end:', error);
      return false;
    }
  }
  
  /**
   * Handle a TPA server restart by recovering sessions
   * 
   * @param registrationId - Registration ID of the restarted server
   * @returns Number of recovered sessions
   */
  async handleTpaServerRestart(registrationId: string): Promise<number> {
    try {
      const registration = tpaServerRegistry.getRegistration(registrationId);
      if (!registration) {
        logger.error(`Registration not found: ${registrationId}`);
        return 0;
      }
      
      // Get all active sessions to recover
      const sessionIdsToRecover = registration.activeSessions;
      if (sessionIdsToRecover.length === 0) {
        logger.info(`No sessions to recover for ${registration.packageName}`);
        return 0;
      }
      
      logger.info(`Recovering ${sessionIdsToRecover.length} sessions for ${registration.packageName}`);
      
      // Count successful recoveries
      let recoveredCount = 0;
      
      // Process each session
      for (const tpaSessionId of sessionIdsToRecover) {
        try {
          // Parse the session ID to get the user session ID and package name
          const [userSessionId, packageName] = tpaSessionId.split('-');
          
          // Get the user session
          const userSession = sessionService.getSession(userSessionId);
          if (!userSession) {
            logger.warn(`User session not found for recovery: ${userSessionId}`);
            continue;
          }
          
          // Is this package active for this user?
          if (!userSession.activeAppSessions.includes(packageName)) {
            logger.warn(`Package ${packageName} not active for user ${userSessionId}`);
            continue;
          }
          
          // Get server URLs appropriate for this server
          const serverUrl = this.determineServerUrl(registration, userSession);
          
          // Trigger the TPA's webhook to restart the session
          await appService.triggerWebhook(registration.webhookUrl, {
            type: WebhookRequestType.SESSION_REQUEST,
            sessionId: tpaSessionId,
            userId: userSession.userId,
            timestamp: new Date().toISOString(),
            augmentOSWebsocketUrl: serverUrl,
          });
          
          recoveredCount++;
          logger.info(`Successfully triggered recovery for session: ${tpaSessionId}`);
        } catch (error) {
          logger.error(`Error recovering session ${tpaSessionId}:`, error);
        }
      }
      
      return recoveredCount;
    } catch (error) {
      logger.error('Error handling TPA server restart:', error);
      return 0;
    }
  }
  
  /**
   * Determine the appropriate server URL for a TPA connection
   * 
   * @param registration - TPA server registration
   * @param userSession - User session
   * @returns WebSocket URL for the TPA to connect to
   */
  private determineServerUrl(
    registration: TpaServerRegistration,
    userSession: UserSession
  ): string {
    // For system apps, use internal URL if available
    if (Object.values(systemApps).some(app => app.packageName === registration.packageName)) {
      // In Docker environment, use internal service name
      if (process.env.CONTAINER_ENVIRONMENT === 'true' || 
          process.env.CLOUD_HOST_NAME === 'cloud' ||
          process.env.PORTER_APP_NAME) {
        
        // Porter environment (Kubernetes)
        if (process.env.PORTER_APP_NAME) {
          const internalUrl = `ws://${process.env.PORTER_APP_NAME}-cloud.default.svc.cluster.local:80/tpa-ws`;
          logger.debug(`Using Porter internal URL for system app ${registration.packageName}: ${internalUrl}`);
          return internalUrl;
        }
        
        // Docker Compose environment
        const internalUrl = 'ws://cloud/tpa-ws';
        logger.debug(`Using Docker internal URL for system app ${registration.packageName}: ${internalUrl}`);
        return internalUrl;
      }
      
      // Local development environment
      const localUrl = 'ws://localhost:8002/tpa-ws';
      logger.debug(`Using local URL for system app ${registration.packageName}: ${localUrl}`);
      return localUrl;
    }
    
    // For non-system apps in production/staging, use the registered server URL if available
    const environment = process.env.NODE_ENV || 'development';
    if ((environment === 'production' || environment === 'staging') && registration.serverUrls.length > 0) {
      const selectedUrl = registration.serverUrls[0];
      logger.debug(`Using registered URL for ${registration.packageName}: ${selectedUrl}`);
      return selectedUrl;
    }
    
    // For non-system apps in development, or as a fallback, use the public host
    const publicUrl = `wss://${process.env.PUBLIC_HOST_NAME || 'dev.augmentos.org'}/tpa-ws`;
    logger.debug(`Using public URL for ${registration.packageName}: ${publicUrl}`);
    return publicUrl;
  }
}

// Singleton instance
export const tpaRegistrationService = new TpaRegistrationService();
export default tpaRegistrationService;