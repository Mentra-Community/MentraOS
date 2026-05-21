/**
 * @fileoverview Glasses Message Handler
 *
 * Routes incoming glasses messages to the appropriate managers.
 * This module extracts message handling logic from websocket-glasses.service.ts
 * to make it testable and keep the WebSocket service focused on connection lifecycle.
 *
 * Part of Issue 009-001: Extract Message Routing
 * Updated in Issue 009-005: Dead Code Cleanup (removed handlers for messages
 * that mobile no longer sends after core→mantle migration)
 */

import type { Logger } from "pino";

import {
  GlassesToCloudMessage,
  GlassesToCloudMessageType,
  AppToCloudMessageType,
  Vad,
  HeadPosition,
  GlassesConnectionState,
  LocalTranscription,
  LocationUpdate,
  CalendarEvent,
  StreamStatus,
  KeepAliveAck,
  TouchEvent,
  StreamType,
  CloudToAppMessageType,
  UdpRegister,
  UdpUnregister,
  PhoneSubscriptionUpdate,
  StreamRequest,
  StreamStopRequest,
  ManagedStreamRequest,
  ManagedStreamStopRequest,
} from "@mentra/sdk";

import { PosthogService } from "../../logging/posthog.service";
import { WebSocketReadyState } from "../../websocket/types";
import { metricsService } from "../../metrics/MetricsService";
import { PHONE_PACKAGE_NAME } from "../PhoneSession";
import type UserSession from "../UserSession";

const SERVICE_NAME = "GlassesMessageHandler";

/**
 * Handle incoming glasses message by routing to appropriate managers
 *
 * @param userSession The user session
 * @param message The glasses message to handle
 */
export async function handleGlassesMessage(userSession: UserSession, message: GlassesToCloudMessage): Promise<void> {
  const logger = userSession.logger.child({ service: SERVICE_NAME });

  try {
    logger.debug({ type: message.type }, `Handling glasses message for user: ${userSession.userId}`);

    switch (message.type) {
      // App lifecycle - already delegates to AppManager
      case GlassesToCloudMessageType.START_APP:
        await userSession.appManager.startApp(message.packageName);
        break;

      case GlassesToCloudMessageType.STOP_APP:
        await userSession.appManager.stopApp(message.packageName);
        break;

      // Device state
      case GlassesToCloudMessageType.GLASSES_CONNECTION_STATE:
        await handleGlassesConnectionState(userSession, message as GlassesConnectionState, logger);
        userSession.relayMessageToApps(message);
        break;

      // Audio/VAD - route to AudioManager
      case GlassesToCloudMessageType.VAD:
        await handleVad(userSession, message as Vad, logger);
        userSession.relayMessageToApps(message);
        break;

      // Transcription
      case GlassesToCloudMessageType.LOCAL_TRANSCRIPTION:
        await userSession.transcriptionManager.handleLocalTranscription(message as LocalTranscription);
        userSession.relayMessageToApps(message);
        break;

      // Location
      case GlassesToCloudMessageType.LOCATION_UPDATE:
        userSession.locationManager.updateFromWebsocket(message as LocationUpdate);
        break;

      // Calendar
      case GlassesToCloudMessageType.CALENDAR_EVENT:
        logger.debug({ message }, "Calendar event received from glasses");
        userSession.calendarManager.updateEventFromWebsocket(message as CalendarEvent);
        break;

      // NOTE: The following message types were removed in 009-005 (dead code cleanup)
      // because mobile no longer sends them after core→mantle migration:
      // - REQUEST_SETTINGS (mobile uses REST /api/client/user/settings now)
      // - MENTRAOS_SETTINGS_UPDATE_REQUEST (mobile uses REST now)
      // - CORE_STATUS_UPDATE (mobile uses REST for settings, device state via GLASSES_CONNECTION_STATE)

      // Streaming
      case GlassesToCloudMessageType.STREAM_STATUS: {
        const status = message as StreamStatus;
        // First check if managed streaming extension handles it
        const managedHandled = await userSession.managedStreamingExtension.handleStreamStatus(userSession, status);
        // If not handled by managed streaming, delegate to the unmanaged extension
        if (!managedHandled) {
          userSession.unmanagedStreamingExtension.handleStreamStatus(status);
        }
        break;
      }

      case GlassesToCloudMessageType.KEEP_ALIVE_ACK: {
        const ack = message as KeepAliveAck;
        // Send to both managers - they'll handle their own streams
        userSession.managedStreamingExtension.handleKeepAliveAck(userSession.userId, ack);
        userSession.unmanagedStreamingExtension.handleKeepAliveAck(ack);
        break;
      }

      // Photo — PHOTO_RESPONSE is handled via REST at POST /api/client/photo/response
      // See: cloud/issues/038-photo-error-rest-endpoint/spec.md

      // Audio playback
      case GlassesToCloudMessageType.AUDIO_PLAY_RESPONSE:
        logger.debug({ message }, "Audio play response received from glasses");
        userSession.relayAudioPlayResponseToApp(message);
        break;

      // LED control
      case GlassesToCloudMessageType.RGB_LED_CONTROL_RESPONSE:
        logger.debug({ message }, "💡 RGB LED control response received from glasses");
        userSession.relayMessageToApps(message);
        break;

      // Head position
      case GlassesToCloudMessageType.HEAD_POSITION:
        await handleHeadPosition(userSession, message as HeadPosition, logger);
        userSession.relayMessageToApps(message);
        break;

      // Touch events
      case GlassesToCloudMessageType.TOUCH_EVENT:
        await handleTouchEvent(userSession, message as TouchEvent, logger);
        break;

      // UDP audio registration
      case GlassesToCloudMessageType.UDP_REGISTER:
        handleUdpRegister(userSession, message as UdpRegister);
        break;

      case GlassesToCloudMessageType.UDP_UNREGISTER:
        handleUdpUnregister(userSession, message as UdpUnregister);
        break;

      // Local miniapp support — phone subscribes on behalf of local miniapps
      case GlassesToCloudMessageType.PHONE_SUBSCRIPTION_UPDATE:
        handlePhoneSubscriptionUpdate(userSession, message as PhoneSubscriptionUpdate, logger);
        break;

      // Default - handle phone-originated streaming messages, then relay to apps
      default:
        // Phone client sends streaming messages on behalf of local miniapps using
        // AppToCloudMessageType values that aren't in GlassesToCloudMessageType.
        // Cast to string because TS sees disjoint enum types at compile time.
        if ((message.type as string) === AppToCloudMessageType.STREAM_REQUEST) {
          await handlePhoneStreamRequest(userSession, message as unknown as StreamRequest, logger);
          break;
        }
        if ((message.type as string) === AppToCloudMessageType.STREAM_STOP) {
          await handlePhoneStreamStop(userSession, message as unknown as StreamStopRequest, logger);
          break;
        }
        if ((message.type as string) === AppToCloudMessageType.MANAGED_STREAM_REQUEST) {
          await handlePhoneManagedStreamRequest(userSession, message as unknown as ManagedStreamRequest, logger);
          break;
        }
        if ((message.type as string) === AppToCloudMessageType.MANAGED_STREAM_STOP) {
          await handlePhoneManagedStreamStop(userSession, message as unknown as ManagedStreamStopRequest, logger);
          break;
        }
        logger.debug(`Relaying message type ${message.type} to Apps for user: ${userSession.userId}`);
        userSession.relayMessageToApps(message);
        break;
    }
  } catch (error) {
    logger.error({ error, type: message.type }, "Error handling glasses message");
    throw error;
  }
}

/**
 * Handle VAD (Voice Activity Detection) message
 */
async function handleVad(userSession: UserSession, message: Vad, logger: Logger): Promise<void> {
  const isSpeaking = message.status === true || message.status === "true";

  try {
    if (isSpeaking) {
      logger.info("🎙️ VAD detected speech - ensuring streams exist");
      userSession.isTranscribing = true;

      // Ensure both transcription and translation streams exist
      await Promise.all([
        userSession.transcriptionManager.ensureStreamsExist(),
        userSession.translationManager.ensureStreamsExist(),
      ]);
    } else {
      logger.info("🤫 VAD detected silence - finalizing and cleaning up streams");
      userSession.isTranscribing = false;

      // For transcription: finalize pending tokens first, then cleanup
      userSession.transcriptionManager.finalizePendingTokens();
      await userSession.transcriptionManager.cleanupIdleStreams();

      // For translation: stop streams but preserve subscriptions for VAD resume
      await userSession.translationManager.stopAllStreams();
    }
  } catch (error) {
    logger.error({ error }, "❌ Error handling VAD state change");
    userSession.isTranscribing = false;

    // On error, cleanup both managers
    try {
      userSession.transcriptionManager.finalizePendingTokens();
      await userSession.transcriptionManager.cleanupIdleStreams();
      await userSession.translationManager.stopAllStreams();
    } catch (finalizeError) {
      logger.error({ error: finalizeError }, "❌ Error cleaning up streams on VAD error");
    }
  }
}

/**
 * Handle head position event message
 */
async function handleHeadPosition(userSession: UserSession, message: HeadPosition, logger: Logger): Promise<void> {
  logger.debug({ position: message.position }, `Head position event received: ${message.position}`);

  try {
    // If head position is 'up', trigger dashboard content cycling
    if (message.position === "up") {
      logger.info({ sessionId: userSession.sessionId }, "Head up detected - triggering dashboard content cycling");
      userSession.dashboardManager.onHeadsUp();
    }

    // Track the head position event
    PosthogService.trackEvent(GlassesToCloudMessageType.HEAD_POSITION, userSession.userId, {
      sessionId: userSession.sessionId,
      position: message.position,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error({ error, position: message.position }, "Error handling head position event");
  }
}

/**
 * Handle glasses connection state message
 */
async function handleGlassesConnectionState(
  userSession: UserSession,
  message: GlassesConnectionState,
  logger: Logger,
): Promise<void> {
  logger.info({ message }, `handleGlassesConnectionState for user ${userSession.userId}`);

  // Convert WebSocket message to partial device state update
  const isConnected = message.status === "CONNECTED" || message.status === "RECONNECTED";

  // Update via DeviceManager (single source of truth)
  await userSession.deviceManager.updateDeviceState({
    connected: isConnected,
    modelName: isConnected ? message.modelName || null : null,
    wifiConnected: message.wifi?.connected,
    wifiSsid: message.wifi?.ssid ?? undefined,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Handle touch event with gesture-specific routing
 */
async function handleTouchEvent(userSession: UserSession, touchEvent: TouchEvent, logger: Logger): Promise<void> {
  logger.debug({ gesture: touchEvent.gesture_name }, "Touch event received from glasses");

  // Check subscriptions for both gesture-specific (touch_event:triple_tap) and base (touch_event)
  const gestureSubscription = `${StreamType.TOUCH_EVENT}:${touchEvent.gesture_name}` as any;
  const baseSubscription = StreamType.TOUCH_EVENT;

  // Get all subscribed apps (gesture-specific + base)
  const gestureSubscribers = userSession.subscriptionManager.getSubscribedApps(gestureSubscription);
  const baseSubscribers = userSession.subscriptionManager.getSubscribedApps(baseSubscription);
  const allSubscribers = [...new Set([...gestureSubscribers, ...baseSubscribers])];

  if (allSubscribers.length === 0) {
    logger.debug({ gesture: touchEvent.gesture_name }, "No apps subscribed to touch event");
    return;
  }

  logger.debug(
    {
      gesture: touchEvent.gesture_name,
      gestureSubscribers,
      baseSubscribers,
      allSubscribers,
    },
    `Relaying touch event to ${allSubscribers.length} apps`,
  );

  // Send to each subscribed app
  for (const packageName of allSubscribers) {
    const connection = userSession.appWebsockets.get(packageName);
    if (connection && connection.readyState === WebSocketReadyState.OPEN) {
      const appSessionId = userSession.getAppSessionId(packageName);

      // Determine which subscription this app is using
      const appSubscription = gestureSubscribers.includes(packageName) ? gestureSubscription : baseSubscription;

      const dataStream = {
        type: CloudToAppMessageType.DATA_STREAM,
        sessionId: appSessionId,
        streamType: appSubscription,
        data: touchEvent,
        timestamp: new Date(),
      };

      logger.info(
        {
          packageName,
          appSubscription,
          gesture: touchEvent.gesture_name,
          sessionId: appSessionId,
        },
        `Sending touch event '${touchEvent.gesture_name}' to app '${packageName}'`,
      );

      try {
        connection.send(JSON.stringify(dataStream));
        metricsService.incrementMiniappMessagesOut();
      } catch (sendError) {
        logger.error({ error: sendError, packageName }, "Error sending touch event to app");
      }
    } else {
      logger.warn(
        {
          packageName,
          gesture: touchEvent.gesture_name,
          reason: !connection ? "No websocket connection found" : "Websocket not open",
        },
        `Skipping sending touch event to app '${packageName}'`,
      );
    }
  }
}

/**
 * Handle UDP audio registration - delegate to UdpAudioManager
 */
function handleUdpRegister(userSession: UserSession, message: UdpRegister): void {
  userSession.udpAudioManager.handleRegister(message);
}

/**
 * Handle UDP audio unregistration - delegate to UdpAudioManager
 */
function handleUdpUnregister(userSession: UserSession, message: UdpUnregister): void {
  userSession.udpAudioManager.handleUnregister(message);
}

/**
 * Handle phone subscription update for local miniapps.
 * The phone subscribes to cloud streams (transcription, translation) on behalf
 * of locally-running miniapps under the reserved packageName "__phone__".
 */
async function handlePhoneSubscriptionUpdate(
  userSession: UserSession,
  message: PhoneSubscriptionUpdate,
  logger: Logger,
): Promise<void> {
  try {
    // Ensure the phone session exists before processing subscriptions
    userSession.appManager.getOrCreatePhoneSession();
    logger.info(
      { subscriptions: message.subscriptions },
      "Processing phone subscription update for local miniapps",
    );
    // Use the public updateSubscriptions method — it has an internal __phone__
    // branch that skips DB permission checks and routes to PhoneSession.
    await userSession.subscriptionManager.updateSubscriptions(
      PHONE_PACKAGE_NAME,
      message.subscriptions,
    );
  } catch (error) {
    logger.error({ error }, "Error processing phone subscription update");
  }
}

// ---------------------------------------------------------------------------
// Phone-originated streaming handlers (local miniapp support, Phase 5)
// ---------------------------------------------------------------------------

/**
 * Phone sends stream_request on behalf of a local miniapp.
 * We override packageName to __phone__ so the cloud treats the phone as the
 * stream owner and routes status updates back over the phone WS.
 */
async function handlePhoneStreamRequest(
  userSession: UserSession,
  message: StreamRequest,
  logger: Logger,
): Promise<void> {
  try {
    const request: StreamRequest = { ...message, packageName: PHONE_PACKAGE_NAME };
    logger.info({ streamUrl: request.streamUrl }, "Phone stream_request received for local miniapp");
    await userSession.unmanagedStreamingExtension.startStream(request);
  } catch (error) {
    logger.error({ error }, "Error handling phone stream_request");
  }
}

async function handlePhoneStreamStop(
  userSession: UserSession,
  message: StreamStopRequest,
  logger: Logger,
): Promise<void> {
  try {
    const request: StreamStopRequest = { ...message, packageName: PHONE_PACKAGE_NAME };
    logger.info({ streamId: request.streamId }, "Phone stream_stop received for local miniapp");
    await userSession.unmanagedStreamingExtension.stopStream(request);
  } catch (error) {
    logger.error({ error }, "Error handling phone stream_stop");
  }
}

async function handlePhoneManagedStreamRequest(
  userSession: UserSession,
  message: ManagedStreamRequest,
  logger: Logger,
): Promise<void> {
  try {
    const request: ManagedStreamRequest = { ...message, packageName: PHONE_PACKAGE_NAME };
    logger.info("Phone managed_stream_request received for local miniapp");
    await userSession.managedStreamingExtension.startManagedStream(userSession, request);
  } catch (error) {
    logger.error({ error }, "Error handling phone managed_stream_request");
  }
}

async function handlePhoneManagedStreamStop(
  userSession: UserSession,
  message: ManagedStreamStopRequest,
  logger: Logger,
): Promise<void> {
  try {
    const request: ManagedStreamStopRequest = { ...message, packageName: PHONE_PACKAGE_NAME };
    logger.info("Phone managed_stream_stop received for local miniapp");
    await userSession.managedStreamingExtension.stopManagedStream(userSession, request);
  } catch (error) {
    logger.error({ error }, "Error handling phone managed_stream_stop");
  }
}

export default handleGlassesMessage;
