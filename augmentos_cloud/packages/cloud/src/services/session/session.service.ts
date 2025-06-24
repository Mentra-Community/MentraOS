/**
 * @fileoverview Refactored Session Service that coordinates session-related functionality.
 * This service now works with the UserSession class that encapsulates session state
 * and uses specialized managers for different concerns.
 */

import WebSocket from 'ws';
import {
  StreamType,
  CloudToGlassesMessageType,
  DisplayRequest,
  TranscriptSegment,
  TpaConnectionInit,
  DataStream,
  CloudToTpaMessageType,
  GlassesToCloudMessage
} from '@mentra/sdk';
import { Logger } from 'pino';
import { logger as rootLogger } from '../logging/pino-logger';
import { DebugService } from '../debug/debug-service';
import transcriptionService from '../processing/transcription.service';
import subscriptionService from './subscription.service';
import { User } from '../../models/user.model';
import UserSession from './UserSession';
import { getCapabilitiesForModel } from '../../config/hardware-capabilities';

// Constants
const SERVICE_NAME = 'session.service';
const logger = rootLogger.child({ service: SERVICE_NAME });

// Default settings
const DEFAULT_AUGMENTOS_SETTINGS = {
  useOnboardMic: false,
  contextualDashboard: true,
  headUpAngle: 20,
  brightness: 50,
  autoBrightness: false,
  sensingEnabled: true,
  alwaysOnStatusBar: false,
  bypassVad: false,
  bypassAudioEncoding: false,
  metricSystemEnabled: false
};

/**
 * Session Service
 * Coordinates session-related functionality across the system
 */
export class SessionService {

  constructor() {
    logger.info('Session Service initialized');
  }

  /**
   * Creates or retrieves a user session
   *
   * @param ws WebSocket connection
   * @param userId User ID
   * @returns User session
   */
  async createSession(ws: WebSocket, userId: string): Promise<{ userSession: UserSession, reconnection: boolean }> {
    try {
      // Check if user already has an active session
      const existingSession = UserSession.getById(userId);

      if (existingSession) {
        logger.info(`User ${userId} already has a session, updating WebSocket`);

        // Update the WebSocket connection and restart heartbeat
        existingSession.updateWebSocket(ws);

        // Update disconnected state
        existingSession.disconnectedAt = null;

        // Clear any cleanup timer
        if (existingSession.cleanupTimerId) {
          clearTimeout(existingSession.cleanupTimerId);
          existingSession.cleanupTimerId = undefined;
        }

        // Return the existing session
        return { userSession: existingSession, reconnection: true };
      }

      // Create a new session
      logger.info(`Creating new session for user ${userId}`);

      // Create new session with WebSocket
      const userSession = new UserSession(userId, ws);

      // Determine device capabilities based on model
      // For now, we'll default to Even Realities G1 if no model info is available
      // In the future, this will be determined from the glasses connection info
      const modelName = "Even Realities G1"; // TODO: Get from glasses connection info
      const capabilities = getCapabilitiesForModel(modelName);

      if (capabilities) {
        userSession.capabilities = capabilities;
        logger.info(`Set capabilities for ${modelName} on session ${userId}`);
      } else {
        logger.warn(`No capabilities found for model: ${modelName}, session ${userId}`);
      }

      // TODO(isaiah): Create a init method in UserSession to handle initialization logic.
      // Fetch installed apps
      try {
        const installedApps = await appService.getAllApps(userId);

        // Populate installedApps map
        for (const app of installedApps) {
          userSession.installedApps.set(app.packageName, app);
        }

        logger.info(`Fetched ${installedApps.length} installed apps for user ${userId}`);
      } catch (error) {
        logger.error(`Error fetching apps for user ${userId}:`, error);
      }

      // Return the new session
      return { userSession: userSession, reconnection: false };
    } catch (error) {
      logger.error(`Error creating session for user ${userId}:`, error);
      throw error;
    }
  }

  /**
   * Get a session by ID
   *
   * @param sessionId Session ID
   * @returns User session or null if not found
   */
  getSession(sessionId: string): UserSession | null {
    return UserSession.getById(sessionId) || null;
  }

  /**
   * Transforms a user session for client consumption
   *
   * @param userSession User session to transform
   * @returns Transformed session data
   */
  async transformUserSessionForClient(userSession: UserSession): Promise<any> {
    try {
      const userId = userSession.userId;

      // Collect app subscriptions
      const appSubscriptions: Record<string, string[]> = {};

      // For each running app, get its subscriptions
      for (const packageName of userSession.runningApps) {
        appSubscriptions[packageName] = subscriptionService.getAppSubscriptions(
          userId,
          packageName
        );
      }

      // Calculate streams that need to be active
      const requiresAudio = subscriptionService.hasMediaSubscriptions(userId);
      userSession.microphoneManager.updateState(requiresAudio); // TODO(isaiah): Feels like an odd place to put it, but it works for now.

      const minimumTranscriptionLanguages = subscriptionService.getMinimalLanguageSubscriptions(userId);

      // Transform to client-friendly format
      return {
        userId,
        startTime: userSession.startTime,
        activeAppSessions: Array.from(userSession.runningApps),
        loadingApps: Array.from(userSession.loadingApps),
        appSubscriptions,
        requiresAudio,
        minimumTranscriptionLanguages,
        isTranscribing: userSession.isTranscribing || false,
      };
    } catch (error) {
      logger.error(`Error transforming session for client:`, error);
      // Return basic session info on error
      return {
        userId: userSession.userId,
        startTime: userSession.startTime,
        activeAppSessions: Array.from(userSession.runningApps),
        loadingApps: Array.from(userSession.loadingApps),
        isTranscribing: userSession.isTranscribing || false,
      };
    }
  }


  /**
   * Add a transcript segment to a user session
   *
   * @param userSession User session
   * @param segment Transcript segment
   * @param language Language code
   */
  addTranscriptSegment(
    userSession: UserSession,
    segment: TranscriptSegment,
    language: string = 'en-US'
  ): void {
    try {
      // Add to main transcript segments (for backward compatibility)
      if (language === 'en-US') {
        userSession.transcript.segments.push(segment);

        // Prune old segments
        const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000;
        userSession.transcript.segments = userSession.transcript.segments.filter(
          s => new Date(s.timestamp).getTime() > thirtyMinutesAgo
        );
      }

      // Add to language-specific segments
      if (!userSession.transcript.languageSegments) {
        userSession.transcript.languageSegments = new Map();
      }

      if (!userSession.transcript.languageSegments.has(language)) {
        userSession.transcript.languageSegments.set(language, []);
      }

      userSession.transcript.languageSegments.get(language)!.push(segment);

      // Prune old language-specific segments
      const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000;
      for (const [lang, segments] of userSession.transcript.languageSegments.entries()) {
        userSession.transcript.languageSegments.set(
          lang,
          segments.filter(s => new Date(s.timestamp).getTime() > thirtyMinutesAgo)
        );
      }
    } catch (error) {
      logger.error(`Error adding transcript segment:`, error);
    }
  }

  /**
   * Get all active sessions
   *
   * @returns Array of active user sessions
   */
  getAllSessions(): UserSession[] {
    return UserSession.getAllSessions();
  }

  /**
   * Get a session by user ID
   *
   * @param userId User ID
   * @returns User session or null if not found
   */
  getSessionByUserId(userId: string): UserSession | null {
    return UserSession.getById(userId) || null;
  }


  /**
   * Handle transcription start
   *
   * @param userSession User session
   */
  async handleTranscriptionStart(userSession: UserSession): Promise<void> {
    try {
      // If not already transcribing, start transcription
      if (!userSession.isTranscribing) {
        userSession.logger.info('Starting transcription service');
        userSession.isTranscribing = true;
        await transcriptionService.startTranscription(userSession);
      } else {
        userSession.logger.debug('Transcription already running, ignoring start request');
      }
    } catch (error) {
      userSession.logger.error('Error starting transcription:', error);
      // Don't throw - we want to handle errors gracefully
    }
  }

  /**
   * Handle transcription stop
   *
   * @param userSession User session
   */
  async handleTranscriptionStop(userSession: UserSession): Promise<void> {
    try {
      // If currently transcribing, stop transcription
      if (userSession.isTranscribing) {
        userSession.logger.info('Stopping transcription service');
        userSession.isTranscribing = false;
        await transcriptionService.stopTranscription(userSession);
      } else {
        userSession.logger.debug('Transcription already stopped, ignoring stop request');
      }
    } catch (error) {
      userSession.logger.error('Error stopping transcription:', error);
      // Don't throw - we want to handle errors gracefully
    }
  }

  /**
   * Get user settings
   *
   * @param userId User ID
   * @returns User settings
   */
  async getUserSettings(userId: string): Promise<Record<string, any>> {
    try {
      // Look up user in database
      const user = await User.findOne({ email: userId });

      if (!user) {
        logger.warn(`No user found for ID: ${userId}, using default settings`);
        return DEFAULT_AUGMENTOS_SETTINGS;
      }

      // Get augmentos settings
      const augmentosSettings = user.getAugmentosSettings();

      // Create a settings object combining both augmentOS settings and app settings
      const allSettings: Record<string, any> = {
        ...augmentosSettings
      };

      // Get app settings and add them to the response
      if (user.appSettings && user.appSettings.size > 0) {
        // Convert Map to object
        const appSettingsObj: Record<string, any> = {};

        for (const [appName, settings] of user.appSettings.entries()) {
          appSettingsObj[appName] = settings;
        }

        allSettings.appSettings = appSettingsObj;
      } else {
        allSettings.appSettings = {};
      }

      return allSettings;
    } catch (error) {
      logger.error(`Error fetching settings for user ${userId}:`, error);
      // Return default settings on error
      return DEFAULT_AUGMENTOS_SETTINGS;
    }
  }

  /**
   * Get app-specific settings
   *
   * @param userId User ID
   * @param packageName App package name
   * @returns App settings
   */
  async getAppSettings(userId: string, packageName: string): Promise<Record<string, any>> {
    try {
      const allSettings = await this.getUserSettings(userId);
      return allSettings.appSettings?.[packageName] || {};
    } catch (error) {
      logger.error(`Error fetching app settings for ${packageName}:`, error);
      return {};
    }
  }

  /**
   * Relay a message to TPAs
   *
   * @param userSession User session
   * @param streamType Stream type
   * @param data Message data
   */
  relayMessageToTpas(userSession: UserSession, data: GlassesToCloudMessage): void {
    try {
      // Get all TPAs subscribed to this stream type
      const subscribedPackageNames = subscriptionService.getSubscribedApps(userSession, data.type);

      if (subscribedPackageNames.length === 0) {
        return; // No subscribers, nothing to do
      }

      userSession.logger.debug({ service: SERVICE_NAME, data }, `Relaying ${data.type} to ${subscribedPackageNames.length} TPAs for user ${userSession.userId}`);

      // Send to each subscribed TPA
      for (const packageName of subscribedPackageNames) {
        const connection = userSession.appWebsockets.get(packageName);

        if (connection && connection.readyState === WebSocket.OPEN) {
          const tpaSessionId = `${userSession.sessionId}-${packageName}`;
          const dataStream: DataStream = {
            type: CloudToTpaMessageType.DATA_STREAM,
            sessionId: tpaSessionId,
            streamType: data.type as StreamType, // Base type remains the same in the message.
            data,      // The data now may contain language info.
            timestamp: new Date()
          };
          try {
            const messageStr = JSON.stringify(dataStream);
            connection.send(messageStr);
          } catch (sendError) {
            userSession.logger.error({ service: SERVICE_NAME, error: sendError, packageName, data }, `Error sending streamType: ${data.type} to ${packageName}:`, sendError);
          }
        }
      }
    } catch (error) {
      userSession.logger.error({ service: SERVICE_NAME, error, data }, `Error relaying streamType: ${data.type} message`);
    }
  }

  /**
   * Relay audio to TPAs
   *
   * @param userSession User session
   * @param audioData Audio data
   */
  relayAudioToTpas(userSession: UserSession, audioData: ArrayBuffer): void {
    try {
      // Delegate to audio manager
      userSession.audioManager.processAudioData(audioData, false);
    } catch (error) {
      userSession.logger.error({ error }, `Error relaying audio for user: ${userSession.userId}`);
    }
  }

}

// We'll initialize this in index.ts after creating the debug service
let _sessionService: SessionService | null = null;

/**
 * Initialize the session service
 *
 * @param debugService Debug service
 * @returns Session service instance
 */
export function initializeSessionService(): SessionService {
  if (!_sessionService) {
    _sessionService = new SessionService();
    logger.info('✅ Session Service Initialized');
  }
  return _sessionService;
}

/**
 * Get the session service
 *
 * @returns Session service instance
 */
export function getSessionService(): SessionService {
  if (!_sessionService) {
    throw new Error('Session service not initialized');
  }
  return _sessionService;
}

// Create a proxy object that forwards calls to the real service once initialized
const sessionServiceProxy = new Proxy({} as SessionService, {
  get(target, prop: keyof SessionService) {
    const service = _sessionService;
    if (!service) {
      throw new Error('Session service accessed before initialization');
    }
    return service[prop];
  }
});

initializeSessionService();

// Export both the named export and default export using the same proxy
export const sessionService = sessionServiceProxy;
export default sessionServiceProxy;

// Import the app service here to avoid circular dependencies
import appService from '../core/app.service';