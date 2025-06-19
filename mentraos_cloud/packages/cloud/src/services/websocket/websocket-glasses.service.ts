/**
 * @fileoverview Glasses WebSocket service that handles WebSocket connections from smart glasses clients.
 * This service manages glasses authentication, message processing, and session management.
 */

import WebSocket from 'ws';
import { IncomingMessage } from 'http';
import {
  AugmentosSettingsUpdateRequest,
  CalendarEvent,
  CloudToGlassesMessage,
  CloudToGlassesMessageType,
  ConnectionAck,
  ConnectionError,
  ConnectionInit,
  CoreStatusUpdate,
  GlassesConnectionState,
  GlassesToCloudMessage,
  GlassesToCloudMessageType,
  HeadPosition,
  KeepAliveAck,
  LocationUpdate,
  PhotoResponse,
  RequestSettings,
  RtmpStreamStatus,
  SettingsUpdate,
  Vad
} from '@augmentos/sdk';
import UserSession from '../session/UserSession';
// import { SessionService } from '../session/session.service';
import { logger as rootLogger } from '../logging/pino-logger';
import subscriptionService from '../session/subscription.service';
import { PosthogService } from '../logging/posthog.service';
// import { systemApps } from '../core/system-apps';
import { sessionService } from '../session/session.service';
import transcriptionService from '../processing/transcription.service';
import { User } from '../../models/user.model';
import { SYSTEM_DASHBOARD_PACKAGE_NAME } from '../core/app.service';

const SERVICE_NAME = 'websocket-glasses.service';
const logger = rootLogger.child({ service: SERVICE_NAME });

// Constants
const RECONNECT_GRACE_PERIOD_MS = 1000 * 60 * 1; // 1 minute

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
} as const;

/**
 * Error codes for glasses connection issues
 */
export enum GlassesErrorCode {
  INVALID_TOKEN = 'INVALID_TOKEN',
  SESSION_ERROR = 'SESSION_ERROR',
  MALFORMED_MESSAGE = 'MALFORMED_MESSAGE',
  INTERNAL_ERROR = 'INTERNAL_ERROR'
}

/**
 * Singleton Service that handles all glasses WebSocket connections.
 */
export class GlassesWebSocketService {

  private static instance: GlassesWebSocketService;
  private constructor() { }

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

      if (!userId) {
        logger.error({
          error: GlassesErrorCode.INVALID_TOKEN,
          request,
        }, 'No user ID provided in request');
        this.sendError(ws, GlassesErrorCode.INVALID_TOKEN, 'Authentication failed');
        return;
      }

      // Create or retrieve user session
      const { userSession, reconnection } = await sessionService.createSession(ws, userId);
      userSession.logger.info(`Glasses WebSocket connection from user: ${userId}`);

      // Handle incoming messages
      ws.on('message', async (data: WebSocket.Data, isBinary) => {
        try {
          // Handle binary message (audio data)
          if (isBinary) {
            await this.handleBinaryMessage(userSession, data);
            return;
          }

          // Parse text message
          const message = JSON.parse(data.toString()) as GlassesToCloudMessage;

          if (message.type === GlassesToCloudMessageType.CONNECTION_INIT) {
            // Handle connection initialization message
            const connectionInitMessage = message as ConnectionInit;
            userSession.logger.info(`Received connection init message from glasses: ${JSON.stringify(connectionInitMessage)}`);
            // If this is a reconnection, we can skip the initialization logic
            await this.handleConnectionInit(userSession, reconnection);
            return;
          }

          // Process the message
          await this.handleGlassesMessage(userSession, message);
        } catch (error) {
          userSession.logger.error(error, 'Error processing glasses message:');
        }
      });

      // Handle connection close
      ws.on('close', (code: number, reason: string) => {
        this.handleGlassesConnectionClose(userSession, code, reason);
      });

      // Handle connection errors
      ws.on('error', (error: Error) => {
        userSession.logger.error(error, 'Glasses WebSocket error:');
      });

      // Handle connection initialization
      this.handleConnectionInit(userSession, reconnection);

      // Track connection in analytics
      PosthogService.trackEvent('glasses_connection', userId, {
        sessionId: userSession.userId,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error(error, 'Error handling glasses connection for user:' + (request as any).userId);
      logger.debug({ service: SERVICE_NAME, request, userId: (request as any).userId }, 'Request details');
      this.sendError(ws, GlassesErrorCode.SESSION_ERROR, 'Failed to create session');
    }
  }


  /**
   * Handle binary message (audio data)
   * 
   * @param userSession User session
   * @param data Binary audio data
   */
  private async handleBinaryMessage(userSession: UserSession, data: WebSocket.Data): Promise<void> {
    try {
      // Process audio data
      // userSession.logger.debug({ service: SERVICE_NAME, data }, `Handling binary message for user: ${userSession.userId}`);
      userSession.audioManager.processAudioData(data);
      // userSession.logger.debug({ service: SERVICE_NAME }, `Processed binary message for user: ${userSession.userId}`);
      // await sessionService.(userSession, data);
    } catch (error) {
      userSession.logger.error('Error handling binary message:', error);
    }
  }

  /**
   * Handle glasses message
   * 
   * @param userSession User session
   * @param message Glasses message
   */
  private async handleGlassesMessage(userSession: UserSession, message: GlassesToCloudMessage): Promise<void> {
    try {
      const userId = userSession.userId;
      userSession.logger.debug({ service: SERVICE_NAME, message, type: message.type }, `Handling glasses message for user: ${userId}`);

      // Process message based on type
      switch (message.type) {
        // case GlassesToCloudMessageType.CONNECTION_INIT:
        //   await this.handleConnectionInit(userSession);
        //   break;

        // Looks Good.
        case GlassesToCloudMessageType.START_APP:
          await userSession.appManager.startApp(message.packageName);
          break;

        // Looks Good.
        case GlassesToCloudMessageType.STOP_APP:
          await userSession.appManager.stopApp(message.packageName);
          break;

        // Looks Good.
        case GlassesToCloudMessageType.GLASSES_CONNECTION_STATE:
          // TODO(isaiah): verify logic
          await this.handleGlassesConnectionState(userSession, message as GlassesConnectionState);
          sessionService.relayMessageToTpas(userSession, message);
          break;

        // Looks Good.
        case GlassesToCloudMessageType.VAD:
          await this.handleVad(userSession, message as Vad);
          sessionService.relayMessageToTpas(userSession, message);
          // TODO(isaiah): relay to TPAs
          break;

        case GlassesToCloudMessageType.LOCATION_UPDATE:
          await this.handleLocationUpdate(userSession, message as LocationUpdate);
          sessionService.relayMessageToTpas(userSession, message);
          // TODO(isaiah): broadcast to TPAs
          break;

        case GlassesToCloudMessageType.CALENDAR_EVENT:
          // TODO(isaiah): verify logic
          userSession.logger.debug({ service: SERVICE_NAME, message }, 'Calendar event received from glasses');
          subscriptionService.cacheCalendarEvent(userSession.sessionId, message as CalendarEvent);
          sessionService.relayMessageToTpas(userSession, message);
          break;

        // TODO(isaiah): verify logic
        case GlassesToCloudMessageType.REQUEST_SETTINGS:
          await this.handleRequestSettings(userSession, message as RequestSettings);
          break;

        case GlassesToCloudMessageType.AUGMENTOS_SETTINGS_UPDATE_REQUEST:
          await this.handleAugmentOSSettingsUpdateRequest(userSession, message as AugmentosSettingsUpdateRequest);
          break;

        case GlassesToCloudMessageType.CORE_STATUS_UPDATE: {
          const coreStatusUpdate = message as CoreStatusUpdate;
          const logger = userSession.logger.child({ service: SERVICE_NAME, type: GlassesToCloudMessageType.CORE_STATUS_UPDATE });
          // userSession.logger.info('Received core status update:', coreStatusUpdate);

          try {
            // The status is already an object, no need to parse
            const statusObj = coreStatusUpdate.status as any;
            const coreInfo = statusObj.status.core_info;
            const connectedGlasses = statusObj.status.connected_glasses;
            logger.debug({ service: SERVICE_NAME, coreInfo, connectedGlasses }, 'Core status update received');

            if (!coreInfo || !connectedGlasses) {
              userSession.logger.error('Invalid core status update format - missing required fields');
              break;
            }
;
            
            let brightness = statusObj.status.glasses_settings.brightness;
            const glassesSettings = statusObj.status.glasses_settings;
            
            // Map core status fields to augmentos settings
            const newSettings = {
              useOnboardMic: coreInfo.force_core_onboard_mic,
              contextualDashboard: coreInfo.contextual_dashboard_enabled,
              metricSystemEnabled: coreInfo.metric_system_enabled,
              headUpAngle: connectedGlasses.head_up_angle,

              // Glasses settings.
              brightness: glassesSettings.brightness,
              autoBrightness: glassesSettings.auto_brightness,
              dashboard_height: glassesSettings.dashboard_height,
              dashboard_depth: glassesSettings.dashboard_depth,

              sensingEnabled: coreInfo.sensing_enabled,
              alwaysOnStatusBar: coreInfo.always_on_status_bar_enabled,
              bypassVad: coreInfo.bypass_vad_for_debugging,
              bypassAudioEncoding: coreInfo.bypass_audio_encoding_for_debugging,
            };

            logger.debug("🔥🔥🔥: newSettings:", newSettings);

            // Find or create the user
            const user = await User.findOrCreateUser(userSession.userId);

            // Get current settings before update
            const currentSettingsBeforeUpdate = JSON.parse(JSON.stringify(user.augmentosSettings));
            userSession.logger.info('Current settings before update:', currentSettingsBeforeUpdate);

            logger.debug("🔥🔥🔥: currentSettingsBeforeUpdate:", currentSettingsBeforeUpdate);
            logger.debug("🔥🔥🔥: newSettings:", newSettings);

            // Check if anything actually changed
            const changedKeys = this.getChangedKeys(currentSettingsBeforeUpdate, newSettings);
            logger.debug("🔥🔥🔥: changedKeys:", changedKeys);
            if (changedKeys.length === 0) {
              userSession.logger.info('No changes detected in settings from core status update');
            } else {
              userSession.logger.info('Changes detected in settings from core status update:', {
                changedFields: changedKeys.map(key => ({
                  key,
                  from: `${(currentSettingsBeforeUpdate as Record<string, any>)[key]} (${typeof (currentSettingsBeforeUpdate as Record<string, any>)[key]})`,
                  to: `${(newSettings as Record<string, any>)[key]} (${typeof (newSettings as Record<string, any>)[key]})`
                }))
              });
              // Update the settings in the database before broadcasting
              try {
                await user.updateAugmentosSettings(newSettings);
                userSession.logger.info('Updated AugmentOS settings in the database.');
              } catch (dbError) {
                userSession.logger.error(dbError, 'Failed to update AugmentOS settings in the database:');
                return; // Do not broadcast if DB update fails
              }
              // Only notify for changed keys
              const notifiedApps = new Set<string>();
              for (const key of changedKeys) {
                const subscribedApps = subscriptionService.getSubscribedAppsForAugmentosSetting(userSession, key);
                // userSession.logger.info('Subscribed apps for key:', key, subscribedApps);
                for (const packageName of subscribedApps) {
                  if (notifiedApps.has(packageName)) continue;
                  const tpaWs = userSession.appWebsockets.get(packageName);
                  if (tpaWs && tpaWs.readyState === 1) {
                    userSession.logger.info(`[websocket.service]: Broadcasting AugmentOS settings update to ${packageName}`);
                    const augmentosSettingsUpdate = {
                      type: 'augmentos_settings_update',
                      sessionId: `${userSession.sessionId}-${packageName}`,
                      settings: newSettings,
                      timestamp: new Date()
                    };
                    tpaWs.send(JSON.stringify(augmentosSettingsUpdate));
                    notifiedApps.add(packageName);
                  }
                }
              }
            }
          } catch (error) {
            userSession.logger.error(error, 'Error updating settings from core status:');
          }
          break;
        }

        // Mentra Live.
        case GlassesToCloudMessageType.RTMP_STREAM_STATUS:
          // Delegate to VideoManager within the user's session
          userSession.videoManager.handleRtmpStreamStatus(message as RtmpStreamStatus);
          break;

        case GlassesToCloudMessageType.KEEP_ALIVE_ACK:
          // Delegate to VideoManager
          userSession.videoManager.handleKeepAliveAck(message as KeepAliveAck);
          break;

        case GlassesToCloudMessageType.PHOTO_RESPONSE:
          // Delegate to PhotoManager
          userSession.photoManager.handlePhotoResponse(message as PhotoResponse);
          break;

        case GlassesToCloudMessageType.HEAD_POSITION:
          await this.handleHeadPosition(userSession, message as HeadPosition);
          // Also relay to TPAs in case they want to handle head position events
          sessionService.relayMessageToTpas(userSession, message);
          break;

        // TODO(isaiah): Add other message type handlers as needed
        default:
          // For messages that don't need special handling, relay to TPAs
          // based on subscriptions
          userSession.logger.debug(`Relaying message type ${message.type} to TPAs for user: ${userId}`);
          sessionService.relayMessageToTpas(userSession, message);
          // TODO(isaiah): Verify Implemention message relaying to TPAs
          break;
      }
    } catch (error) {
      userSession.logger.error('Error handling glasses message:', error);
    }
  }

  /**
   * Handle connection init
   * 
   * @param userSession User session
   */
  private async handleConnectionInit(userSession: UserSession, reconnection: boolean): Promise<void> {
    if (!reconnection) {
      // Start all the apps that the user has running.
      try {
        // Start the dashboard app, but let's not add to the user's running apps since it's a system app.
        // honestly there should be no annyomous users so if it's an anonymous user we should just not start the dashboard
        await userSession.appManager.startApp(SYSTEM_DASHBOARD_PACKAGE_NAME);
      }
      catch (error) {
        userSession.logger.error({ error }, `Error starting dashboard app`);
      }

      // Start all the apps that the user has running.
      try {
        await userSession.appManager.startPreviouslyRunningApps();
      }
      catch (error) {
        userSession.logger.error({ error }, `Error starting user apps`);
      }

      // TODO(isaiah): Check if we really need to start the transcription service here.
      // or if instead we should be checkig if the user has any media subscriptions and starting the transcription service if they do.
      // Start transcription
      transcriptionService.startTranscription(userSession);

      // Track connection event.
      PosthogService.trackEvent('connected', userSession.userId, {
        sessionId: userSession.sessionId,
        timestamp: new Date().toISOString()
      });
    }

    // const ackMessage: CloudConnectionAckMessage = {
    const ackMessage: ConnectionAck = {
      type: CloudToGlassesMessageType.CONNECTION_ACK,
      sessionId: userSession.sessionId,
      userSession: await sessionService.transformUserSessionForClient(userSession),
      timestamp: new Date()
    };

    userSession.websocket.send(JSON.stringify(ackMessage));
  }


  // Utility function to get changed keys between two objects
  private getChangedKeys<T extends Record<string, any>>(before: T, after: T): string[] {
    return Object.keys(after).filter(
      key => before[key] !== after[key] ||
        (typeof before[key] !== typeof after[key] && before[key] != after[key])
    );
  }


  /**
   * Handle VAD (Voice Activity Detection) message
   * 
   * @param userSession User session
   * @param message VAD message
   */
  private async handleVad(userSession: UserSession, message: Vad): Promise<void> {
    const isSpeaking = message.status === true || message.status === 'true';

    try {
      if (isSpeaking) {
        userSession.logger.info('🎙️ VAD detected speech - starting transcription');
        userSession.isTranscribing = true;
        transcriptionService.startTranscription(userSession);
      } else {
        userSession.logger.info('🤫 VAD detected silence - stopping transcription');
        userSession.isTranscribing = false;
        transcriptionService.stopTranscription(userSession);
      }
    } catch (error) {
      userSession.logger.error({ error }, '❌ Error handling VAD state change');
      userSession.isTranscribing = false;
      transcriptionService.stopTranscription(userSession);
    }
  }

  /**
   * Handle location update message
   * 
   */
  private async handleLocationUpdate(userSession: UserSession, message: LocationUpdate): Promise<void> {
    userSession.logger.debug({ message, service: SERVICE_NAME }, 'Location update received from glasses');
    try {
      // Cache the location update in subscription service
      subscriptionService.cacheLocation(userSession.sessionId, {
        latitude: message.lat,
        longitude: message.lng,
        timestamp: new Date()
      });

      const user = await User.findByEmail(userSession.userId);
      if (user) {
        await user.setLocation(message);
      }
    }
    catch (error) {
      userSession.logger.error({ error, service: SERVICE_NAME }, `Error updating user location:`, error);
    }
  }

  /**
   * Handle head position event message
   * 
   * @param userSession User session
   * @param message Head position message
   */
  private async handleHeadPosition(userSession: UserSession, message: HeadPosition): Promise<void> {
    userSession.logger.debug({
      position: message.position,
      service: SERVICE_NAME
    }, `Head position event received: ${message.position}`);

    try {
      // If head position is 'up', trigger dashboard content cycling
      if (message.position === 'up') {
        userSession.logger.info({
          service: SERVICE_NAME,
          sessionId: userSession.sessionId
        }, 'Head up detected - triggering dashboard content cycling');

        // Call the dashboard manager's onHeadsUp method to cycle content
        userSession.dashboardManager.onHeadsUp();
      }

      // Track the head position event
      PosthogService.trackEvent(GlassesToCloudMessageType.HEAD_POSITION, userSession.userId, {
        sessionId: userSession.sessionId,
        position: message.position,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      userSession.logger.error({
        error,
        service: SERVICE_NAME,
        position: message.position
      }, 'Error handling head position event');
    }
  }

  /**
   * Handle glasses connection state message
   * 
   * @param userSession User session
   * @param message Connection state message
   */
  private async handleGlassesConnectionState(userSession: UserSession, message: GlassesConnectionState): Promise<void> {
    const glassesConnectionStateMessage = message as GlassesConnectionState;

    userSession.logger.info({ service: SERVICE_NAME, message }, `handleGlassesConnectionState for user ${userSession.userId}`);
    userSession.microphoneManager.handleConnectionStateChange(glassesConnectionStateMessage.status);

    // Track the connection state event
    PosthogService.trackEvent(GlassesToCloudMessageType.GLASSES_CONNECTION_STATE, userSession.userId, {
      sessionId: userSession.sessionId,
      eventType: message.type,
      timestamp: new Date().toISOString(),
      connectionState: glassesConnectionStateMessage,
    });
  }

  // NOTE(isaiah): This really should be a rest request instead of a websocket message.
  /**
   * Handle request settings message
   * @param userSession User session
   * @param message Request settings message
   */
  private async handleRequestSettings(userSession: UserSession, message: RequestSettings): Promise<void> {
    userSession.logger.info({ service: SERVICE_NAME, message }, `handleRequestSettings for user ${userSession.userId}`);

    try {
      const user = await User.findByEmail(userSession.userId);
      const userSettings = user?.augmentosSettings || DEFAULT_AUGMENTOS_SETTINGS;

      const settingsMessage: CloudToGlassesMessage = {
        type: CloudToGlassesMessageType.SETTINGS_UPDATE,
        sessionId: userSession.sessionId,
        settings: userSettings,
        timestamp: new Date()
      };

      userSession.logger.debug({ service: SERVICE_NAME, settingsMessage, message }, "🔥🔥🔥: Sending settings update");
      userSession.websocket.send(JSON.stringify(settingsMessage));
      userSession.logger.info({ service: SERVICE_NAME }, 'Sent settings update');
    } catch (error) {
      userSession.logger.error('Error sending settings:', error);
      const errorMessage: ConnectionError = {
        type: CloudToGlassesMessageType.CONNECTION_ERROR,
        message: 'Error retrieving settings',
        timestamp: new Date()
      };
      userSession.websocket.send(JSON.stringify(errorMessage));
    }
  }

  // NOTE(isaiah): This really should be a rest request instead of a websocket message.
  // TODO(isaiah): This also doesn't seem to be implemented correctly. / fully.
  /**
   * Handle settings update message
   * 
   * @param userSession User session
   * @param message Settings update message
   */
  private async handleAugmentOSSettingsUpdateRequest(userSession: UserSession, message: AugmentosSettingsUpdateRequest): Promise<void> {
    userSession.logger.info({ service: SERVICE_NAME, message }, `handleAugmentOSSettingsUpdateRequest for user ${userSession.userId}`);

    try {
      // Find or create the user
      const user = await User.findOrCreateUser(userSession.userId);

      // Get current settings from database
      const currentSettings = user.augmentosSettings || DEFAULT_AUGMENTOS_SETTINGS;
      userSession.logger.debug({ currentSettings, message, service: SERVICE_NAME }, `Current AugmentOS settings for user ${userSession.userId}`);

      // Send current settings back to the client
      const responseMessage = {
        type: 'settings_update',
        success: true,
        message: 'Current settings retrieved successfully',
        settings: currentSettings,
        timestamp: new Date()
      };

      userSession.websocket.send(JSON.stringify(responseMessage));
    } catch (error) {
      userSession.logger.error('Error retrieving AugmentOS settings:', error);

      // Send error back to client
      const errorMessage = {
        type: 'augmentos_settings_update_error',
        success: false,
        message: error instanceof Error ? error.message : 'Error retrieving settings',
        timestamp: new Date()
      };
      userSession.websocket.send(JSON.stringify(errorMessage));
    }
  }

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
      `[WebsocketGlassesService:handleGlassesConnectionClose]: (${userSession.userId}, ${code}, ${reason}) - Glasses connection closed`
    );

    // Mark session as disconnected
    // Clear any existing cleanup timer
    if (userSession.cleanupTimerId) {
      clearTimeout(userSession.cleanupTimerId);
      userSession.cleanupTimerId = undefined;
    }

    // Stop transcription
    if (userSession.isTranscribing) {
      userSession.isTranscribing = false;
      transcriptionService.stopTranscription(userSession);
    }

    // Mark as disconnected
    userSession.disconnectedAt = new Date();

    // Set cleanup timer if not already set
    if (!userSession.cleanupTimerId) {
      userSession.cleanupTimerId = setTimeout(() => {
        userSession.logger.debug({ service: SERVICE_NAME }, `Cleanup grace period expired for user session: ${userSession.userId}`);

        // Check to see if the session has reconnected / if the user is still active.
        const wsState = userSession.websocket?.readyState;
        const wsExists = !!userSession.websocket;
        const wsOpen = wsState === WebSocket.OPEN;
        const wsConnecting = wsState === WebSocket.CONNECTING;

        userSession.logger.debug({
          service: SERVICE_NAME,
          websocketExists: wsExists,
          websocketState: wsState,
          websocketStateNames: {
            0: 'CONNECTING',
            1: 'OPEN',
            2: 'CLOSING',
            3: 'CLOSED'
          }[wsState] || 'UNKNOWN',
          isOpen: wsOpen,
          isConnecting: wsConnecting,
          disconnectedAt: userSession.disconnectedAt,
          timeSinceDisconnect: userSession.disconnectedAt ? Date.now() - userSession.disconnectedAt.getTime() : null
        }, `Grace period check: WebSocket state analysis for ${userSession.userId}`);

        // Check if user reconnected by looking at disconnectedAt (more reliable than WebSocket state)
        if (!userSession.disconnectedAt) {
          userSession.logger.debug({
            service: SERVICE_NAME,
            reason: 'disconnectedAt_cleared'
          }, `User session ${userSession.userId} has reconnected (disconnectedAt cleared), skipping cleanup.`);
          clearTimeout(userSession.cleanupTimerId!);
          userSession.cleanupTimerId = undefined;
          return;
        }

        // Fallback: also check WebSocket state for backward compatibility
        if (userSession.websocket && userSession.websocket.readyState === WebSocket.OPEN) {
          userSession.logger.debug({
            service: SERVICE_NAME,
            reason: 'websocket_open'
          }, `User session ${userSession.userId} has reconnected (WebSocket open), skipping cleanup.`);
          clearTimeout(userSession.cleanupTimerId!);
          userSession.cleanupTimerId = undefined;
          return;
        }

        userSession.logger.debug({
          service: SERVICE_NAME,
          finalWebsocketState: wsState,
          websocketExists: wsExists,
          reason: !wsExists ? 'no_websocket' : !wsOpen ? 'websocket_not_open' : 'unknown'
        }, `User session ${userSession.userId} determined not reconnected, cleaning up session.`);
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
        timestamp: new Date()
      };

      ws.send(JSON.stringify(errorMessage));
      ws.close(1008, message);
    } catch (error) {
      logger.error('Error sending error message to glasses:', error);

      try {
        ws.close(1011, 'Internal server error');
      } catch (closeError) {
        logger.error('Error closing WebSocket connection:', closeError);
      }
    }
  }
}

// export default GlassesWebSocketService;