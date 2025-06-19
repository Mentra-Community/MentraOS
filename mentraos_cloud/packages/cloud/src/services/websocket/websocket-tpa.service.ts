/**
 * @fileoverview TPA WebSocket service that handles WebSocket connections from Third-Party Applications.
 * This service manages TPA authentication, message processing, and session management.
 */

import WebSocket from 'ws';
import { IncomingMessage } from 'http';
import jwt from 'jsonwebtoken';
import {
  TpaConnectionInit,
  TpaConnectionAck,
  TpaConnectionError,
  TpaToCloudMessage,
  TpaToCloudMessageType,
  CloudToTpaMessageType,
  TpaSubscriptionUpdate,
  AppStateChange,
  StreamType,
  DataStream,
  LocationUpdate,
  GlassesToCloudMessageType,
  CloudToGlassesMessageType,
  PhotoRequest,
  RtmpStreamRequest,
  RtmpStreamStopRequest,
} from '@augmentos/sdk';
import UserSession from '../session/UserSession';
import * as developerService from '../core/developer.service';
import { sessionService } from '../session/session.service';
import subscriptionService from '../session/subscription.service';
import { logger as rootLogger } from '../logging/pino-logger';
import transcriptionService from '../processing/transcription.service';
import photoRequestService from '../core/photo-request.service';
import e from 'express';

const SERVICE_NAME = 'websocket-tpa.service';
const logger = rootLogger.child({ service: SERVICE_NAME });

/**
 * Error codes for TPA connection issues
 */
export enum TpaErrorCode {
  INVALID_JWT = 'INVALID_JWT',
  JWT_SIGNATURE_FAILED = 'JWT_SIGNATURE_FAILED',
  PACKAGE_NOT_FOUND = 'PACKAGE_NOT_FOUND',
  INVALID_API_KEY = 'INVALID_API_KEY',
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',
  MALFORMED_MESSAGE = 'MALFORMED_MESSAGE',
  INTERNAL_ERROR = 'INTERNAL_ERROR'
}

/**
 * JWT payload structure for TPA authentication
 */
interface TpaJwtPayload {
  packageName: string;
  apiKey: string;
}

interface TpaIncomingMessage extends IncomingMessage {
  tpaJwtPayload?: TpaJwtPayload;
  userId?: string;
  sessionId?: string;
}

/**
 * Service that handles TPA WebSocket connections
 */
export class TpaWebSocketService {
  private static instance: TpaWebSocketService;
  private logger = rootLogger.child({ service: SERVICE_NAME });
  constructor() { }

  /**
   * Get the singleton instance of TpaWebSocketService
   */
  static getInstance(): TpaWebSocketService {
    if (!TpaWebSocketService.instance) {
      TpaWebSocketService.instance = new TpaWebSocketService();
    }
    return TpaWebSocketService.instance;
  }

  /**
   * Handle a new TPA WebSocket connection
   * 
   * @param ws WebSocket connection
   * @param request HTTP request object
   */
  async handleConnection(ws: WebSocket, request: TpaIncomingMessage): Promise<void> {
    logger.info('New TPA WebSocket connection');

    // Get user session if we have a sessionId
    let userSession: UserSession | undefined = undefined;

    // TPAs using new SDK connecting to the cloud will send a JWT token in the request headers.
    try {
      // Check if the request has a valid JWT token.
      const tpaJwtPayload = request?.tpaJwtPayload as TpaJwtPayload;

      if (tpaJwtPayload) {
        logger.info('TPA WebSocket connection with JWT token');
        const userId = request?.userId as string;
        const sessionId = request?.sessionId as string;

        // Enure there is an existing userSession for the tpa to connect to.
        userSession = UserSession.getById(userId);
        if (!userSession) {
          logger.error({ request }, 'User session not found for TPA message');
          this.sendError(ws, TpaErrorCode.SESSION_NOT_FOUND, 'Session not found');
          return;
        }

        // Create ConnectionInit message, and sent to the app manager to handle it.
        const initMessage: TpaConnectionInit = {
          type: TpaToCloudMessageType.CONNECTION_INIT,
          packageName: tpaJwtPayload.packageName,
          sessionId: sessionId,
          apiKey: tpaJwtPayload.apiKey
        };
        await userSession.appManager.handleTpaInit(ws, initMessage);
      }
    } catch (error) {
      logger.error(error, 'Error processing TPA connection request');
      ws.close(1011, 'Internal server error');
      return;
    }

    // Set up message handler
    ws.on('message', async (data: WebSocket.Data) => {
      try {
        // Parse the incoming message
        const message = JSON.parse(data.toString()) as TpaToCloudMessage;

        // Check if it's old auth via TPA Init message.
        if (message.type === TpaToCloudMessageType.CONNECTION_INIT) {
          const initMessage = message as TpaConnectionInit;
          // Parse session ID to get user session ID
          const sessionParts = initMessage.sessionId.split('-');
          const userId = sessionParts[0];
          if (sessionParts.length < 2) {
            logger.error({ service: SERVICE_NAME, message }, `Invalid session ID format: ${initMessage.sessionId}`);
            ws.close(1008, 'Invalid session ID format');
            return;
          }

          userSession = UserSession.getById(userId);
          if (!userSession) {
            logger.error({ request, message }, 'User session not found for TPA message');
            this.sendError(ws, TpaErrorCode.SESSION_NOT_FOUND, 'Session not found');
            return;
          }
          await userSession.appManager.handleTpaInit(ws, initMessage);
        }

        else {
          // If we don't have a user session, we can't process other messages.
          if (!userSession) {
            logger.error({ request, data }, 'User session not found for TPA message');
            this.sendError(ws, TpaErrorCode.SESSION_NOT_FOUND, 'Session not found');
            return;
          }

          // Only handle non-connection init messages if we have a user session.
          await this.handleTpaMessage(ws, userSession, message)
        }
      } catch (error) {
        logger.error(error, 'Unexpected error processing TPA message');
        logger.debug({ service: SERVICE_NAME, data }, '[debug] Unexpected error processing TPA message', data);
        // General error handling when we can't even parse the message
        ws.close(1011, 'Internal server error');
      }
    });
  }

  /**
   * Handle TPA message
   * 
   * @param userSession UserSession
   * @param message TpaToCloudMessage
   */
  private async handleTpaMessage(tpaWebsocket: WebSocket, userSession: UserSession, message: TpaToCloudMessage): Promise<void> {
    try {
      // Process based on message type
      switch (message.type) {
        case TpaToCloudMessageType.SUBSCRIPTION_UPDATE:
          this.handleSubscriptionUpdate(tpaWebsocket, userSession, message);
          break;

        case TpaToCloudMessageType.DISPLAY_REQUEST:
          userSession.logger.debug({ service: SERVICE_NAME, message, packageName: message.packageName }, `Received display request from TPA: ${message.packageName}`);
          userSession.displayManager.handleDisplayRequest(message);
          // Handle display request
          break;

        // Dashboard message handling
        case TpaToCloudMessageType.DASHBOARD_CONTENT_UPDATE:
        case TpaToCloudMessageType.DASHBOARD_MODE_CHANGE:
        case TpaToCloudMessageType.DASHBOARD_SYSTEM_UPDATE: {
          userSession.dashboardManager.handleTpaMessage(message);
          break;
        }

        // Mentra Live Photo / Video Stream Request message handling.
        case TpaToCloudMessageType.RTMP_STREAM_REQUEST:
          // Delegate to VideoManager
          // The RtmpStreamRequest SDK type should be used by the TPA
          try {
            const streamId = await userSession.videoManager.startRtmpStream(message as RtmpStreamRequest);
            // Optionally send an immediate ack to TPA if startRtmpStream doesn't or if TPA expects it
            // (VideoManager.startRtmpStream already sends initial status)
            this.logger.info({ streamId, packageName: message.packageName }, "RTMP Stream request processed by VideoManager.");
          } catch (e) {
            this.logger.error({ e, packageName: message.packageName }, "Error starting RTMP stream via VideoManager");
            this.sendError(tpaWebsocket, TpaErrorCode.INTERNAL_ERROR, (e as Error).message || "Failed to start stream.");
          }
          break;

        case TpaToCloudMessageType.RTMP_STREAM_STOP:
          // Delegate to VideoManager
          try {
            await userSession.videoManager.stopRtmpStream(message as RtmpStreamStopRequest);
            this.logger.info({ packageName: message.packageName, streamId: (message as RtmpStreamStopRequest).streamId }, "RTMP Stream stop request processed by VideoManager.");
          } catch (e) {
            this.logger.error({ e, packageName: message.packageName }, "Error stopping RTMP stream via VideoManager");
            this.sendError(tpaWebsocket, TpaErrorCode.INTERNAL_ERROR, (e as Error).message || "Failed to stop stream.");
          }
          break;

        case TpaToCloudMessageType.PHOTO_REQUEST:
          // Delegate to PhotoManager
          // The TpaPhotoRequestSDK type should be used by the TPA
          // PhotoManager's requestPhoto now takes the TpaPhotoRequestSDK object
          try {
            const photoRequestMsg = message as PhotoRequest;
            // The PhotoManager's requestPhoto method now takes the entire TPA request object
            // and internally extracts what it needs, plus gets the tpaWebSocket.
            // The old `photoRequestService.createTpaPhotoRequest` took `userId, appId, ws, config`.
            // The new `PhotoManager.requestPhoto` will take the `TpaPhotoRequestSDK` object
            // and the `tpaWs` is passed from `handleTpaMessage`.
            // We need to make sure the PhotoManager has access to the tpaWs that sent this message.
            // The current PhotoManager.requestPhoto is:
            // async requestPhoto(tpaRequest: TpaPhotoRequestSDK): Promise<string>
            // It internally uses this.userSession.appWebsockets.get(tpaRequest.packageName) to get the websocket.
            // This is fine if the TPA ws is already stored by AppManager.handleTpaInit.
            const requestId = await userSession.photoManager.requestPhoto(photoRequestMsg);
            this.logger.info({ requestId, packageName: photoRequestMsg.packageName }, "Photo request processed by PhotoManager.");
          } catch(e) {
            this.logger.error({e, packageName: message.packageName}, "Error requesting photo via PhotoManager");
            this.sendError(tpaWebsocket, TpaErrorCode.INTERNAL_ERROR, (e as Error).message || "Failed to request photo.");
          }

        default:
          logger.warn(`Unhandled TPA message type: ${message.type}`);
          break;
      }
    } catch (error) {
      userSession.logger.error({ error, message }, 'Error handling TPA message');
    }
  }

  // Handle Subscription updates.
  private async handleSubscriptionUpdate(tpaWebsocket: WebSocket, userSession: UserSession, message: TpaSubscriptionUpdate): Promise<void> {
    const packageName = message.packageName;
    userSession.logger.debug(
      { service: SERVICE_NAME, message, packageName },
      `Received subscription update from TPA: ${packageName}`
    );

    // Get the minimal language subscriptions before update
    const previousLanguageSubscriptions = subscriptionService.getMinimalLanguageSubscriptions(userSession.userId);

    // Check if the app is newly subscribing to calendar events
    const isNewCalendarSubscription =
      !subscriptionService.hasSubscription(userSession.userId, message.packageName, StreamType.CALENDAR_EVENT) &&
      message.subscriptions.includes(StreamType.CALENDAR_EVENT);

    // Check if the app is newly subscribing to location updates
    const isNewLocationSubscription =
      !subscriptionService.hasSubscription(userSession.userId, message.packageName, StreamType.LOCATION_UPDATE) &&
      message.subscriptions.includes(StreamType.LOCATION_UPDATE);

    // Update subscriptions (async)
    await subscriptionService.updateSubscriptions(
      userSession,
      message.packageName,
      message.subscriptions
    );

    // Get the new minimal language subscriptions after update
    const newLanguageSubscriptions = subscriptionService.getMinimalLanguageSubscriptions(userSession.userId);

    // Check if language subscriptions have changed
    const languageSubscriptionsChanged =
      previousLanguageSubscriptions.length !== newLanguageSubscriptions.length ||
      !previousLanguageSubscriptions.every(sub => newLanguageSubscriptions.includes(sub));

    if (languageSubscriptionsChanged) {
      userSession.logger.info({ service: SERVICE_NAME, languageSubscriptionsChanged, packageName }, `Language subscriptions changed for ${packageName} in session ${userSession.userId}`);
      // console.log("🔥🔥🔥: newLanguageSubscriptions:", newLanguageSubscriptions);
      // Update transcription streams with new language subscriptions
      transcriptionService.updateTranscriptionStreams(userSession, newLanguageSubscriptions);

      // Check if we need to update microphone state based on media subscriptions
      userSession.microphoneManager.handleSubscriptionChange();
    }

    // Send cached calendar event if app just subscribed to calendar events
    if (isNewCalendarSubscription) {
      userSession.logger.info({ service: SERVICE_NAME, isNewCalendarSubscription, packageName }, `isNewCalendarSubscription: ${isNewCalendarSubscription} for app ${packageName}`);
      const allCalendarEvents = subscriptionService.getAllCalendarEvents(userSession.userId);
      if (allCalendarEvents.length > 0) {
        userSession.logger.debug({ service: SERVICE_NAME, allCalendarEvents }, `Sending ${allCalendarEvents.length} cached calendar events to newly subscribed app ${message.packageName}`);

        if (tpaWebsocket && tpaWebsocket.readyState === WebSocket.OPEN) {
          for (const event of allCalendarEvents) {
            const dataStream: DataStream = {
              type: CloudToTpaMessageType.DATA_STREAM,
              streamType: StreamType.CALENDAR_EVENT,
              sessionId: `${userSession.userId}-${message.packageName}`,
              data: event,
              timestamp: new Date()
            };
            tpaWebsocket.send(JSON.stringify(dataStream));
          }
        }
      }
    }

    // Send cached location if app just subscribed to location updates
    if (isNewLocationSubscription) {
      userSession.logger.info({ service: SERVICE_NAME, isNewLocationSubscription, packageName }, `isNewLocationSubscription: ${isNewLocationSubscription} for app ${packageName}`);
      const lastLocation = subscriptionService.getLastLocation(userSession.userId);
      if (lastLocation) {
        userSession.logger.info(`Sending cached location to newly subscribed app ${message.packageName}`);
        const tpaSessionId = `${userSession.userId}-${message.packageName}`;

        if (tpaWebsocket && tpaWebsocket.readyState === WebSocket.OPEN) {
          const locationUpdate: LocationUpdate = {
            type: GlassesToCloudMessageType.LOCATION_UPDATE,
            sessionId: tpaSessionId,
            lat: lastLocation.latitude,
            lng: lastLocation.longitude,
            timestamp: new Date()
          };

          const dataStream: DataStream = {
            type: CloudToTpaMessageType.DATA_STREAM,
            sessionId: tpaSessionId,
            streamType: StreamType.LOCATION_UPDATE,
            data: locationUpdate,
            timestamp: new Date()
          };
          tpaWebsocket.send(JSON.stringify(dataStream));
        }
      }
    }

    // Send cached userDatetime if app just subscribed to custom_message
    const isNewCustomMessageSubscription = message.subscriptions.includes(StreamType.CUSTOM_MESSAGE);

    if (isNewCustomMessageSubscription && userSession.userDatetime) {
      userSession.logger.info(`Sending cached userDatetime to app ${message.packageName} on custom_message subscription`);
      if (tpaWebsocket && tpaWebsocket.readyState === WebSocket.OPEN) {
        const customMessage = {
          type: CloudToTpaMessageType.CUSTOM_MESSAGE,
          action: 'update_datetime',
          payload: {
            datetime: userSession.userDatetime,
            section: 'topLeft'
          },
          timestamp: new Date()
        };
        tpaWebsocket.send(JSON.stringify(customMessage));
      }
    }

    const clientResponse: AppStateChange = {
      type: CloudToGlassesMessageType.APP_STATE_CHANGE,
      sessionId: userSession.sessionId,
      userSession: await sessionService.transformUserSessionForClient(userSession),
      timestamp: new Date()
    };

    userSession.websocket.send(JSON.stringify(clientResponse));
  }

  /**
   * Send an error response to the TPA client
   * 
   * @param ws WebSocket connection
   * @param code Error code
   * @param message Error message
   */
  private sendError(ws: WebSocket, code: TpaErrorCode, message: string): void {
    try {
      const errorResponse: TpaConnectionError = {
        type: CloudToTpaMessageType.CONNECTION_ERROR,
        code: code,
        message: message,
        timestamp: new Date()
      };
      ws.send(JSON.stringify(errorResponse));
      // Close the connection with an appropriate code
      ws.close(1008, message);
    } catch (error) {
      logger.error('Failed to send error response', error);
      // Try to close the connection anyway
      try {
        ws.close(1011, 'Internal server error');
      } catch (closeError) {
        logger.error('Failed to close WebSocket connection', closeError);
      }
    }
  }

}

export default TpaWebSocketService;