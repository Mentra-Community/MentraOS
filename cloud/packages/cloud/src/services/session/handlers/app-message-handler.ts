/**
 * @fileoverview App Message Handler
 *
 * Routes incoming app messages to the appropriate managers.
 * This module extracts message handling logic from websocket-app.service.ts
 * to make it testable and keep the WebSocket service focused on connection lifecycle.
 *
 * Part of Issue 009-001: Extract Message Routing
 */

import type { Logger } from "pino";

import {
  AppToCloudMessage,
  AppToCloudMessageType,
  CloudToAppMessageType,
  CloudToGlassesMessageType,
  AppSubscriptionUpdate,
  PhotoRequest,
  AudioPlayRequest,
  AudioStopRequest,
  RtmpStreamRequest,
  RtmpStreamStopRequest,
  ManagedStreamRequest,
  ManagedStreamStopRequest,
  StreamStatusCheckRequest,
  StreamStatusCheckResponse,
  PermissionType,
  RgbLedControlRequest,
  OwnershipReleaseMessage,
  StreamType,
  AppStateChange,
} from "@mentra/sdk";

import App from "../../../models/app.model";
import { SimplePermissionChecker } from "../../permissions/simple-permission-checker";
import { IWebSocket, WebSocketReadyState } from "../../websocket/types";
import type UserSession from "../UserSession";

const SERVICE_NAME = "AppMessageHandler";

/**
 * Error codes for App connection issues
 */
export enum AppErrorCode {
  INVALID_JWT = "INVALID_JWT",
  JWT_SIGNATURE_FAILED = "JWT_SIGNATURE_FAILED",
  PACKAGE_NOT_FOUND = "PACKAGE_NOT_FOUND",
  INVALID_API_KEY = "INVALID_API_KEY",
  SESSION_NOT_FOUND = "SESSION_NOT_FOUND",
  MALFORMED_MESSAGE = "MALFORMED_MESSAGE",
  PERMISSION_DENIED = "PERMISSION_DENIED",
  INTERNAL_ERROR = "INTERNAL_ERROR",
  WIFI_NOT_CONNECTED = "WIFI_NOT_CONNECTED",
}

// Debouncing for subscription changes to prevent rapid stream recreation
const subscriptionChangeTimers = new Map<string, NodeJS.Timeout>();
const SUBSCRIPTION_DEBOUNCE_MS = 500;

/**
 * Handle incoming app message by routing to appropriate managers
 *
 * @param appWebsocket The app's WebSocket connection
 * @param userSession The user session
 * @param message The app message to handle
 */
export async function handleAppMessage(
  appWebsocket: IWebSocket,
  userSession: UserSession,
  message: AppToCloudMessage,
): Promise<void> {
  const logger = userSession.logger.child({ service: SERVICE_NAME });

  try {
    switch (message.type) {
      case AppToCloudMessageType.SUBSCRIPTION_UPDATE:
        await handleSubscriptionUpdate(appWebsocket, userSession, message as AppSubscriptionUpdate, logger);
        break;

      case AppToCloudMessageType.DISPLAY_REQUEST:
        logger.debug(
          { packageName: message.packageName, feature: "device-state", requestType: "display" },
          `Received display request from App: ${message.packageName}`,
        );
        userSession.displayManager.handleDisplayRequest(message);
        break;

      // Dashboard message handling
      case AppToCloudMessageType.DASHBOARD_CONTENT_UPDATE:
      case AppToCloudMessageType.DASHBOARD_MODE_CHANGE:
      case AppToCloudMessageType.DASHBOARD_SYSTEM_UPDATE:
        userSession.dashboardManager.handleAppMessage(message);
        break;

      // RGB LED control
      case AppToCloudMessageType.RGB_LED_CONTROL:
        await handleRgbLedControl(appWebsocket, userSession, message as RgbLedControlRequest, logger);
        break;

      // RTMP streaming
      case AppToCloudMessageType.RTMP_STREAM_REQUEST:
        await handleRtmpStreamRequest(appWebsocket, userSession, message as RtmpStreamRequest, logger);
        break;

      case AppToCloudMessageType.RTMP_STREAM_STOP:
        await handleRtmpStreamStop(appWebsocket, userSession, message as RtmpStreamStopRequest, logger);
        break;

      // Location
      case AppToCloudMessageType.LOCATION_POLL_REQUEST:
        await handleLocationPollRequest(appWebsocket, userSession, message, logger);
        break;

      // Photo
      case AppToCloudMessageType.PHOTO_REQUEST:
        await handlePhotoRequest(appWebsocket, userSession, message as PhotoRequest, logger);
        break;

      // Audio playback
      case AppToCloudMessageType.AUDIO_PLAY_REQUEST:
        await handleAudioPlayRequest(appWebsocket, userSession, message as AudioPlayRequest, logger);
        break;

      case AppToCloudMessageType.AUDIO_STOP_REQUEST:
        await handleAudioStopRequest(appWebsocket, userSession, message as AudioStopRequest, logger);
        break;

      // Managed streaming
      case AppToCloudMessageType.MANAGED_STREAM_REQUEST:
        await handleManagedStreamRequest(appWebsocket, userSession, message as ManagedStreamRequest, logger);
        break;

      case AppToCloudMessageType.MANAGED_STREAM_STOP:
        await handleManagedStreamStop(appWebsocket, userSession, message as ManagedStreamStopRequest, logger);
        break;

      // Stream status check
      case AppToCloudMessageType.STREAM_STATUS_CHECK:
        await handleStreamStatusCheck(appWebsocket, userSession, message as StreamStatusCheckRequest, logger);
        break;

      // WiFi setup
      case AppToCloudMessageType.REQUEST_WIFI_SETUP:
        await handleWifiSetupRequest(userSession, message, logger);
        break;

      // Ownership release
      case AppToCloudMessageType.OWNERSHIP_RELEASE:
        handleOwnershipRelease(userSession, message as OwnershipReleaseMessage, logger);
        break;

      default:
        logger.warn(`Unhandled App message type: ${message.type}`);
        break;
    }
  } catch (error) {
    logger.error({ error, type: message.type }, "Error handling App message");
    throw error;
  }
}

/**
 * Handle subscription update
 *
 * Note: Serialization of per-app subscription updates is handled by
 * AppSession.enqueue() in SubscriptionManager.updateSubscriptions().
 * See Issue 008 for details on the race condition this prevents.
 */
async function handleSubscriptionUpdate(
  appWebsocket: IWebSocket,
  userSession: UserSession,
  message: AppSubscriptionUpdate,
  logger: Logger,
): Promise<void> {
  const packageName = message.packageName;
  logger.debug({ packageName }, `Received subscription update from App: ${packageName}`);

  // Get the minimal language subscriptions before update
  const previousLanguageSubscriptions = userSession.subscriptionManager.getMinimalLanguageSubscriptions();

  try {
    // Update session-scoped subscriptions
    await userSession.subscriptionManager.updateSubscriptions(message.packageName, message.subscriptions);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(
      {
        error: { message: errorMessage, name: (error as Error).name, stack: (error as Error).stack },
        packageName,
        subscriptions: message.subscriptions,
        userId: userSession.userId,
        logKey: "##SUBSCRIPTION_ERROR##",
      },
      `##SUBSCRIPTION_ERROR##: Failed to update subscriptions for App ${packageName}`,
    );
    sendError(appWebsocket, AppErrorCode.MALFORMED_MESSAGE, `Invalid subscription type: ${errorMessage}`, logger);
    return;
  }

  // Get the new minimal language subscriptions after update
  const newLanguageSubscriptions = userSession.subscriptionManager.getMinimalLanguageSubscriptions();

  // Check if language subscriptions have changed
  const languageSubscriptionsChanged =
    previousLanguageSubscriptions.length !== newLanguageSubscriptions.length ||
    !previousLanguageSubscriptions.every((sub) => newLanguageSubscriptions.includes(sub));

  if (languageSubscriptionsChanged) {
    logger.info({ languageSubscriptionsChanged, packageName }, `Language subscriptions changed for ${packageName}`);

    const userId = userSession.userId;

    // Clear existing timer if present
    if (subscriptionChangeTimers.has(userId)) {
      clearTimeout(subscriptionChangeTimers.get(userId)!);
    }

    // Set debounced timer for transcription stream updates
    subscriptionChangeTimers.set(
      userId,
      setTimeout(() => {
        try {
          logger.debug({ newLanguageSubscriptions, userId }, "Applying debounced transcription stream update");

          // Check if we need to update microphone state based on media subscriptions
          userSession.microphoneManager.handleSubscriptionChange();
        } catch (error) {
          logger.error({ error, userId }, "Error in debounced subscription update");
        } finally {
          subscriptionChangeTimers.delete(userId);
        }
      }, SUBSCRIPTION_DEBOUNCE_MS),
    );
  }

  // Send cached userDatetime if app just subscribed to custom_message
  const isNewCustomMessageSubscription = message.subscriptions.includes(StreamType.CUSTOM_MESSAGE as any);

  if (isNewCustomMessageSubscription && userSession.userDatetime) {
    logger.info(`Sending cached userDatetime to app ${message.packageName} on custom_message subscription`);
    if (appWebsocket && appWebsocket.readyState === WebSocketReadyState.OPEN) {
      const customMessage = {
        type: CloudToAppMessageType.CUSTOM_MESSAGE,
        action: "update_datetime",
        payload: { datetime: userSession.userDatetime, section: "topLeft" },
        timestamp: new Date(),
      };
      appWebsocket.send(JSON.stringify(customMessage));
    }
  }

  // Notify glasses of app state change
  const clientResponse: AppStateChange = {
    type: CloudToGlassesMessageType.APP_STATE_CHANGE,
    sessionId: userSession.sessionId,
    timestamp: new Date(),
  };

  userSession.websocket.send(JSON.stringify(clientResponse));
}

/**
 * Handle RGB LED control request
 */
async function handleRgbLedControl(
  appWebsocket: IWebSocket,
  userSession: UserSession,
  message: RgbLedControlRequest,
  logger: Logger,
): Promise<void> {
  try {
    logger.info(
      { requestId: message.requestId, packageName: message.packageName, action: message.action, color: message.color },
      "💡 RGB LED control request received from app",
    );

    const glassesLedRequest = {
      type: CloudToGlassesMessageType.RGB_LED_CONTROL,
      sessionId: userSession.sessionId,
      requestId: message.requestId,
      packageName: message.packageName,
      action: message.action,
      color: message.color,
      ontime: message.ontime,
      offtime: message.offtime,
      count: message.count,
      timestamp: new Date(),
    };

    if (userSession.websocket && userSession.websocket.readyState === WebSocketReadyState.OPEN) {
      userSession.websocket.send(JSON.stringify(glassesLedRequest));
      logger.info({ requestId: message.requestId, action: message.action }, "💡 RGB LED control request forwarded");
    } else {
      sendError(appWebsocket, AppErrorCode.INTERNAL_ERROR, "Glasses not connected", logger);
    }
  } catch (e) {
    logger.error({ e, packageName: message.packageName }, "Error forwarding RGB LED control request");
    sendError(
      appWebsocket,
      AppErrorCode.INTERNAL_ERROR,
      (e as Error).message || "Failed to forward RGB LED control request",
      logger,
    );
  }
}

/**
 * Handle RTMP stream request
 */
async function handleRtmpStreamRequest(
  appWebsocket: IWebSocket,
  userSession: UserSession,
  message: RtmpStreamRequest,
  logger: Logger,
): Promise<void> {
  try {
    // Check camera permission
    const hasCameraPermission = await checkCameraPermission(message.packageName, userSession, logger);
    if (!hasCameraPermission) {
      logger.warn({ packageName: message.packageName }, "RTMP stream request denied: no CAMERA permission");
      sendError(
        appWebsocket,
        AppErrorCode.PERMISSION_DENIED,
        "Camera permission required to start video streams",
        logger,
      );
      return;
    }

    const streamId = await userSession.unmanagedStreamingExtension.startRtmpStream(message);
    logger.info({ streamId, packageName: message.packageName }, "RTMP Stream request processed");
  } catch (e) {
    logger.error({ e, packageName: message.packageName }, "Error starting RTMP stream");

    const errorMessage = (e as Error).message || "Failed to start stream.";
    const errorCode = (e as any).code;
    const isWifiError = errorCode === "WIFI_NOT_CONNECTED" || errorMessage === "no_wifi_connection";

    sendError(
      appWebsocket,
      isWifiError ? AppErrorCode.WIFI_NOT_CONNECTED : AppErrorCode.INTERNAL_ERROR,
      errorMessage,
      logger,
    );
  }
}

/**
 * Handle RTMP stream stop
 */
async function handleRtmpStreamStop(
  appWebsocket: IWebSocket,
  userSession: UserSession,
  message: RtmpStreamStopRequest,
  logger: Logger,
): Promise<void> {
  try {
    await userSession.unmanagedStreamingExtension.stopRtmpStream(message);
    logger.info({ packageName: message.packageName, streamId: message.streamId }, "RTMP Stream stop processed");
  } catch (e) {
    logger.error({ e, packageName: message.packageName }, "Error stopping RTMP stream");
    sendError(appWebsocket, AppErrorCode.INTERNAL_ERROR, (e as Error).message || "Failed to stop stream", logger);
  }
}

/**
 * Handle location poll request
 */
async function handleLocationPollRequest(
  appWebsocket: IWebSocket,
  userSession: UserSession,
  message: any,
  logger: Logger,
): Promise<void> {
  try {
    await userSession.locationManager.handlePollRequestFromApp(
      message.accuracy,
      message.correlationId,
      message.packageName,
    );
  } catch (e) {
    logger.error({ e, packageName: message.packageName }, "Error handling location poll request");
    sendError(
      appWebsocket,
      AppErrorCode.INTERNAL_ERROR,
      (e as Error).message || "Failed to handle location poll",
      logger,
    );
  }
}

/**
 * Handle photo request
 */
async function handlePhotoRequest(
  appWebsocket: IWebSocket,
  userSession: UserSession,
  message: PhotoRequest,
  logger: Logger,
): Promise<void> {
  try {
    // Check camera permission
    const hasCameraPermission = await checkCameraPermission(message.packageName, userSession, logger);
    if (!hasCameraPermission) {
      logger.warn({ packageName: message.packageName }, "Photo request denied: no CAMERA permission");
      sendError(appWebsocket, AppErrorCode.PERMISSION_DENIED, "Camera permission required to take photos", logger);
      return;
    }

    const requestId = await userSession.photoManager.requestPhoto(message);
    logger.info({ requestId, packageName: message.packageName }, "Photo request processed");
  } catch (e) {
    logger.error({ e, packageName: message.packageName }, "Error requesting photo");
    sendError(appWebsocket, AppErrorCode.INTERNAL_ERROR, (e as Error).message || "Failed to request photo", logger);
  }
}

/**
 * Handle audio play request
 */
async function handleAudioPlayRequest(
  appWebsocket: IWebSocket,
  userSession: UserSession,
  message: AudioPlayRequest,
  logger: Logger,
): Promise<void> {
  try {
    // Store the mapping of requestId -> packageName
    userSession.audioPlayRequestMapping.set(message.requestId, message.packageName);
    logger.debug(`🔊 Stored audio request mapping: ${message.requestId} -> ${message.packageName}`);

    const glassesAudioRequest = {
      type: CloudToGlassesMessageType.AUDIO_PLAY_REQUEST,
      sessionId: userSession.sessionId,
      requestId: message.requestId,
      packageName: message.packageName,
      audioUrl: message.audioUrl,
      volume: message.volume,
      stopOtherAudio: message.stopOtherAudio,
      timestamp: new Date(),
    };

    if (userSession.websocket && userSession.websocket.readyState === WebSocketReadyState.OPEN) {
      userSession.websocket.send(JSON.stringify(glassesAudioRequest));
      logger.debug(`🔊 Forwarded audio request ${message.requestId} to glasses`);
      // Disabled: Server-side playback via Go bridge/LiveKit - now handled client-side via expo-av
      // void userSession.speakerManager.start(message);
    } else {
      userSession.audioPlayRequestMapping.delete(message.requestId);
      sendError(appWebsocket, AppErrorCode.INTERNAL_ERROR, "Glasses not connected", logger);
    }
  } catch (e) {
    if (message?.requestId) {
      userSession.audioPlayRequestMapping.delete(message.requestId);
    }
    sendError(
      appWebsocket,
      AppErrorCode.INTERNAL_ERROR,
      (e as Error).message || "Failed to process audio request",
      logger,
    );
  }
}

/**
 * Handle audio stop request
 */
async function handleAudioStopRequest(
  appWebsocket: IWebSocket,
  userSession: UserSession,
  message: AudioStopRequest,
  logger: Logger,
): Promise<void> {
  try {
    const glassesAudioStopRequest = {
      type: CloudToGlassesMessageType.AUDIO_STOP_REQUEST,
      sessionId: userSession.sessionId,
      appId: message.packageName,
      timestamp: new Date(),
    };

    if (userSession.websocket && userSession.websocket.readyState === WebSocketReadyState.OPEN) {
      userSession.websocket.send(JSON.stringify(glassesAudioStopRequest));
      logger.debug(`🔇 Forwarded audio stop request from ${message.packageName} to glasses`);
      // Disabled: Server-side stop via Go bridge/LiveKit - now handled client-side via expo-av
      // void userSession.speakerManager.stop(message);
    } else {
      sendError(appWebsocket, AppErrorCode.INTERNAL_ERROR, "Glasses not connected", logger);
    }
  } catch (e) {
    sendError(
      appWebsocket,
      AppErrorCode.INTERNAL_ERROR,
      (e as Error).message || "Failed to process audio stop request",
      logger,
    );
  }
}

/**
 * Handle managed stream request
 */
async function handleManagedStreamRequest(
  appWebsocket: IWebSocket,
  userSession: UserSession,
  message: ManagedStreamRequest,
  logger: Logger,
): Promise<void> {
  try {
    const hasCameraPermission = await checkCameraPermission(message.packageName, userSession, logger);
    if (!hasCameraPermission) {
      logger.warn({ packageName: message.packageName }, "Managed stream request denied: no CAMERA permission");
      sendError(appWebsocket, AppErrorCode.PERMISSION_DENIED, "Camera permission required for managed streams", logger);
      return;
    }

    const streamId = await userSession.managedStreamingExtension.startManagedStream(userSession, message);
    logger.info({ streamId, packageName: message.packageName }, "Managed stream request processed");
  } catch (e) {
    logger.error({ e, packageName: message.packageName }, "Error starting managed stream");
    sendError(
      appWebsocket,
      AppErrorCode.INTERNAL_ERROR,
      (e as Error).message || "Failed to start managed stream",
      logger,
    );
  }
}

/**
 * Handle managed stream stop
 */
async function handleManagedStreamStop(
  appWebsocket: IWebSocket,
  userSession: UserSession,
  message: ManagedStreamStopRequest,
  logger: Logger,
): Promise<void> {
  try {
    await userSession.managedStreamingExtension.stopManagedStream(userSession, message);
    logger.info({ packageName: message.packageName }, "Managed stream stop processed");
  } catch (e) {
    logger.error({ e, packageName: message.packageName }, "Error stopping managed stream");
    sendError(
      appWebsocket,
      AppErrorCode.INTERNAL_ERROR,
      (e as Error).message || "Failed to stop managed stream",
      logger,
    );
  }
}

/**
 * Handle stream status check
 */
async function handleStreamStatusCheck(
  appWebsocket: IWebSocket,
  userSession: UserSession,
  message: StreamStatusCheckRequest,
  logger: Logger,
): Promise<void> {
  try {
    // Check for managed streams
    const managedStreamState = userSession.managedStreamingExtension.getUserStreamState(userSession.userId);

    // Check for unmanaged streams
    const unmanagedStreamInfo = userSession.unmanagedStreamingExtension.getActiveStreamInfo();

    // Build response
    const response: StreamStatusCheckResponse = {
      type: CloudToAppMessageType.STREAM_STATUS_CHECK_RESPONSE,
      hasActiveStream: !!(managedStreamState || unmanagedStreamInfo),
    };

    if (managedStreamState) {
      if (managedStreamState.type === "managed") {
        const previewUrl = `https://iframe.videodelivery.net/${managedStreamState.cfLiveInputId}?autoplay=true&muted=true&controls=true`;
        const thumbnailUrl = `https://videodelivery.net/${managedStreamState.cfLiveInputId}/thumbnails/thumbnail.jpg`;

        response.streamInfo = {
          type: "managed",
          streamId: managedStreamState.streamId,
          status: "active",
          createdAt: managedStreamState.createdAt,
          hlsUrl: managedStreamState.hlsUrl,
          dashUrl: managedStreamState.dashUrl,
          webrtcUrl: managedStreamState.webrtcUrl,
          previewUrl: previewUrl,
          thumbnailUrl: thumbnailUrl,
          activeViewers: managedStreamState.activeViewers.size,
        };
      } else {
        response.streamInfo = {
          type: "unmanaged",
          streamId: managedStreamState.streamId,
          status: "active",
          createdAt: managedStreamState.createdAt,
          rtmpUrl: managedStreamState.rtmpUrl,
          requestingAppId: managedStreamState.requestingAppId,
        };
      }
    } else if (unmanagedStreamInfo) {
      response.streamInfo = {
        type: "unmanaged",
        streamId: unmanagedStreamInfo.streamId,
        status: unmanagedStreamInfo.status,
        createdAt: unmanagedStreamInfo.startTime,
        rtmpUrl: unmanagedStreamInfo.rtmpUrl,
        requestingAppId: unmanagedStreamInfo.packageName,
      };
    }

    appWebsocket.send(JSON.stringify(response));

    logger.info(
      {
        packageName: message.packageName,
        hasActiveStream: response.hasActiveStream,
        streamType: response.streamInfo?.type,
      },
      "Stream status check processed",
    );
  } catch (e) {
    logger.error({ e, packageName: message.packageName }, "Error checking stream status");
    sendError(
      appWebsocket,
      AppErrorCode.INTERNAL_ERROR,
      (e as Error).message || "Failed to check stream status",
      logger,
    );
  }
}

/**
 * Handle WiFi setup request
 */
async function handleWifiSetupRequest(userSession: UserSession, message: any, logger: Logger): Promise<void> {
  try {
    const showWifiSetup = {
      type: CloudToGlassesMessageType.SHOW_WIFI_SETUP,
      reason: message.reason,
      appPackageName: message.packageName,
      timestamp: new Date(),
    };

    if (userSession.websocket && userSession.websocket.readyState === WebSocketReadyState.OPEN) {
      userSession.websocket.send(JSON.stringify(showWifiSetup));
      logger.info({ packageName: message.packageName, reason: message.reason }, "WiFi setup request forwarded");
    } else {
      logger.error({ packageName: message.packageName }, "Cannot send WiFi setup request - mobile not connected");
    }
  } catch (e) {
    logger.error({ e, packageName: message.packageName }, "Error processing WiFi setup request");
  }
}

/**
 * Handle ownership release message
 */
function handleOwnershipRelease(userSession: UserSession, message: OwnershipReleaseMessage, logger: Logger): void {
  logger.info(
    { packageName: message.packageName, reason: message.reason, sessionId: message.sessionId },
    `📤 Received OWNERSHIP_RELEASE from ${message.packageName}: ${message.reason}`,
  );

  // Mark in AppManager that this app has released ownership
  userSession.appManager.markOwnershipReleased(message.packageName, message.reason);
}

/**
 * Check if an app has the CAMERA permission
 */
async function checkCameraPermission(packageName: string, userSession: UserSession, logger: Logger): Promise<boolean> {
  try {
    const app = await App.findOne({ packageName });
    if (!app) {
      logger.warn({ packageName, userId: userSession.userId }, "App not found when checking camera permissions");
      return false;
    }
    return SimplePermissionChecker.hasPermission(app, PermissionType.CAMERA);
  } catch (error) {
    logger.error({ error, packageName, userId: userSession.userId }, "Error checking camera permission");
    return false;
  }
}

/**
 * Send an error response to the App client
 */
function sendError(ws: IWebSocket, code: AppErrorCode, message: string, logger: Logger): void {
  try {
    const errorResponse = {
      type: CloudToAppMessageType.CONNECTION_ERROR,
      code: code,
      message: message,
      timestamp: new Date(),
    };
    ws.send(JSON.stringify(errorResponse));
    ws.close(1008, message);
  } catch (error) {
    logger.error(error, "Failed to send error response");
    try {
      ws.close(1011, "Internal server error");
    } catch (closeError) {
      logger.error(closeError, "Failed to close WebSocket connection");
    }
  }
}

export default handleAppMessage;
