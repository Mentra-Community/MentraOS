// augmentos_cloud/packages/cloud/core/websocket.service.ts.

/**
 * @fileoverview WebSocket service that handles both glasses client and TPA connections.
 * This service is responsible for:
 * - Managing WebSocket connection lifecycles
 * - Handling real-time message routing
 * - Managing TPA session states
 * - Coordinating audio streaming and transcription
 * 
 * Typical usage:
 * const wsService = createWebSocketService(sessionService, subscriptionService, 
 *                                        transcriptionService, appService);
 * wsService.setupWebSocketServers(httpServer);
 */

// import { WebSocketServer, WebSocket } from 'ws';
import WebSocket from 'ws';
import { IncomingMessage, Server } from 'http';
import { ExtendedUserSession, IS_LC3, SequencedAudioChunk } from './session.service';
import subscriptionService from './subscription.service';
import transcriptionService from '../processing/transcription.service';
import appService from './app.service';
import {
  AppStateChange,
  AuthError,
  CalendarEvent,
  CloudToGlassesMessage,
  CloudToGlassesMessageType,
  CloudToTpaMessage,
  CloudToTpaMessageType,
  ConnectionAck,
  ConnectionError,
  ConnectionInit,
  DataStream,
  DisplayRequest,
  ExtendedStreamType,
  GlassesConnectionState,
  GlassesToCloudMessage,
  GlassesToCloudMessageType,
  LocationUpdate,
  MicrophoneStateChange,
  PhotoRequest,
  PhotoRequestToGlasses,
  PhotoResponse,
  StartApp,
  StopApp,
  StreamType,
  TpaConnectionAck,
  TpaConnectionError,
  TpaConnectionInit,
  TpaSubscriptionUpdate,
  TpaToCloudMessage,
  TpaToCloudMessageType,
  TpaType,
  UserSession,
  Vad,
  WebhookRequestType,
  AugmentosSettingsUpdateRequest,
  SettingsUpdate,
  RequestSettings,
  CoreStatusUpdate,
  VideoStreamRequest,
  VideoStreamRequestToGlasses
} from '@augmentos/sdk';

import jwt, { JwtPayload } from 'jsonwebtoken';
import { PosthogService } from '../logging/posthog.service';
import { systemApps } from './system-apps';
import { User } from '../../models/user.model';
// import { logger } from '@augmentos/utils';
import { logger as rootLogger } from '../logging/pino-logger';
import photoRequestService from './photo-request.service';
import axios from 'axios';
import { SessionService } from './session.service';
import { getSessionService } from './session.service';
import { DisconnectInfo } from './HeartbeatManager';

const logger = rootLogger.child({ service: 'websocket.service' });

export const CLOUD_PUBLIC_HOST_NAME = process.env.CLOUD_PUBLIC_HOST_NAME; // e.g., "prod.augmentos.cloud"
export const CLOUD_LOCAL_HOST_NAME = process.env.CLOUD_LOCAL_HOST_NAME; // e.g., "localhost:8002" | "cloud" | "cloud-debug-cloud.default.svc.cluster.local:80"
export const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET || "";

if (!CLOUD_PUBLIC_HOST_NAME) {
  logger.error("CLOUD_PUBLIC_HOST_NAME is not set. Please set it in your environment variables.");
}

if (!CLOUD_LOCAL_HOST_NAME) {
  logger.error("CLOUD_LOCAL_HOST_NAME is not set. Please set it in your environment variables.");
}

if (!AUGMENTOS_AUTH_JWT_SECRET) {
  logger.error("AUGMENTOS_AUTH_JWT_SECRET is not set. Please set it in your environment variables.");
}

logger.info(`🔥🔥🔥 [websocket.service]: CLOUD_PUBLIC_HOST_NAME: ${CLOUD_PUBLIC_HOST_NAME}`);
logger.info(`🔥🔥🔥 [websocket.service]: CLOUD_LOCAL_HOST_NAME: ${CLOUD_LOCAL_HOST_NAME}`);

const WebSocketServer = WebSocket.Server || WebSocket.WebSocketServer;

// Constants
const TPA_SESSION_TIMEOUT_MS = 5000;  // 5 seconds
const LOG_AUDIO = false;               // Whether to log audio processing details
const AUTO_RESTART_APPS = true;        // Whether to automatically try to restart apps after disconnection
const AUTO_RESTART_DELAY_MS = 500;     // Delay before attempting auto-restart
type MicrophoneStateChangeDebouncer = { timer: ReturnType<typeof setTimeout> | null; lastState: boolean; lastSentState: boolean };

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

// Utility function to get changed keys between two objects
function getChangedKeys<T extends Record<string, any>>(before: T, after: T): string[] {
  return Object.keys(after).filter(
    key => before[key] !== after[key] ||
      (typeof before[key] !== typeof after[key] && before[key] != after[key])
  );
}

/**
 * ⚡️🕸️🚀 Implementation of the WebSocket service.
 */
export class WebSocketService {
  private glassesWss: WebSocket.Server;
  private tpaWss: WebSocket.Server;
  private sessionService?: SessionService; // Make optional
  private static instance: WebSocketService;

  // Global counter for generating sequential audio chunk numbers
  private globalAudioSequence: number = 0;

  // We no longer track photo requests here - using photoRequestService instead

  private constructor() {
    this.glassesWss = new WebSocketServer({ noServer: true });
    this.tpaWss = new WebSocketServer({ noServer: true });
  }

  public static getInstance(): WebSocketService {
    if (!WebSocketService.instance) {
      WebSocketService.instance = new WebSocketService();
    }
    return WebSocketService.instance;
  }

  public initialize() {
    try {
      this.sessionService = getSessionService();
      logger.info('✅ WebSocket Service initialized');
    } catch (error) {
      logger.error('Failed to initialize WebSocket Service:', error);
      throw error;
    }
  }

  // Add a helper method to ensure session service exists
  private getSessionService(): SessionService {
    if (!this.sessionService) {
      throw new Error('WebSocket Service not initialized');
    }
    return this.sessionService;
  }

  /**
   * Add an audio chunk to the ordered buffer for a session
   * @param userSession User session to add the chunk to
   * @param chunk Audio chunk with sequence information
   */
  // private addToAudioBuffer(userSession: ExtendedUserSession, chunk: SequencedAudioChunk): void {
  //   // Ensure the audio buffer exists
  //   if (!userSession.audioBuffer) {
  //     userSession.logger.warn("Audio buffer not initialized, creating one now");
  //     userSession.audioBuffer = {
  //       chunks: [],
  //       lastProcessedSequence: -1,
  //       processingInProgress: false,
  //       expectedNextSequence: 0,
  //       bufferSizeLimit: 100,
  //       bufferTimeWindowMs: 500,
  //       bufferProcessingInterval: setInterval(() =>
  //         this.processAudioBuffer(userSession), 100)
  //     };
  //   }

  //   // Update expected next sequence
  //   userSession.audioBuffer.expectedNextSequence =
  //     Math.max(userSession.audioBuffer.expectedNextSequence, chunk.sequenceNumber + 1);

  //   // Insert chunk in correct position to maintain sorted order
  //   const index = userSession.audioBuffer.chunks.findIndex(
  //     c => c.sequenceNumber > chunk.sequenceNumber
  //   );

  //   if (index === -1) {
  //     userSession.audioBuffer.chunks.push(chunk);
  //   } else {
  //     userSession.audioBuffer.chunks.splice(index, 0, chunk);
  //   }

  //   // Enforce buffer size limit
  //   if (userSession.audioBuffer.chunks.length > userSession.audioBuffer.bufferSizeLimit) {
  //     const droppedCount = userSession.audioBuffer.chunks.length - userSession.audioBuffer.bufferSizeLimit;

  //     // Remove oldest chunks beyond the limit
  //     userSession.audioBuffer.chunks = userSession.audioBuffer.chunks.slice(
  //       userSession.audioBuffer.chunks.length - userSession.audioBuffer.bufferSizeLimit
  //     );

  //     userSession.logger.warn(
  //       `Audio buffer exceeded limit. Dropped ${droppedCount} oldest chunks. Buffer now has ${userSession.audioBuffer.chunks.length} chunks.`
  //     );
  //   }
  // }

  /**
   * Process audio chunks in sequence from the buffer
   * @param userSession User session whose audio buffer to process
   */
  // private async processAudioBuffer(userSession: ExtendedUserSession): Promise<void> {
  //   // Skip if no buffer, no chunks, or already processing
  //   if (!userSession.audioBuffer ||
  //     userSession.audioBuffer.chunks.length === 0 ||
  //     userSession.audioBuffer.processingInProgress) {
  //     return;
  //   }

  //   // Set processing flag to prevent concurrent processing
  //   userSession.audioBuffer.processingInProgress = true;

  //   try {
  //     const now = Date.now();
  //     const chunks = userSession.audioBuffer.chunks;

  //     // Only proceed if we have chunks to process
  //     if (chunks.length > 0) {
  //       const oldestChunkTime = chunks[0].receivedAt;
  //       const bufferTimeElapsed = now - oldestChunkTime > userSession.audioBuffer.bufferTimeWindowMs;

  //       // Only process if we have accumulated enough time or have enough chunks
  //       if (bufferTimeElapsed || chunks.length >= 5) {
  //         // Sort by sequence number (should already be mostly sorted)
  //         chunks.sort((a, b) => a.sequenceNumber - b.sequenceNumber);

  //         // Process chunks in sequence until we find a gap or reach the end
  //         while (chunks.length > 0) {
  //           const nextChunk = chunks[0];

  //           // Check if this is the next expected chunk or we've waited long enough
  //           const isNextInSequence = nextChunk.sequenceNumber ===
  //             userSession.audioBuffer.lastProcessedSequence + 1;
  //           const hasWaitedLongEnough = now - nextChunk.receivedAt >
  //             userSession.audioBuffer.bufferTimeWindowMs;

  //           if (isNextInSequence || hasWaitedLongEnough) {
  //             // Remove from buffer
  //             chunks.shift();

  //             // Process the chunk with sequence number
  //             const processedData = await sessionService.handleAudioData(
  //               userSession,
  //               nextChunk.data,
  //               nextChunk.isLC3,
  //               nextChunk.sequenceNumber  // Pass sequence to track continuity
  //             );

  //             // Update last processed sequence
  //             userSession.audioBuffer.lastProcessedSequence = nextChunk.sequenceNumber;

  //             // If we have processed audio data, broadcast it to TPAs
  //             if (processedData) {
  //               this.broadcastToTpaAudio(userSession, processedData);
  //             }
  //           } else {
  //             // Wait for the next chunk in sequence
  //             if (LOG_AUDIO) {
  //               userSession.logger.debug(
  //                 `Waiting for audio chunk ${userSession.audioBuffer.lastProcessedSequence + 1}, ` +
  //                 `but next available is ${nextChunk.sequenceNumber}`
  //               );
  //             }
  //             break;
  //           }
  //         }

  //         // Log buffer status if chunks remain
  //         if (chunks.length > 0 && LOG_AUDIO) {
  //           userSession.logger.debug(
  //             `Audio buffer has ${chunks.length} chunks remaining after processing.`
  //           );
  //         }
  //       }
  //     }
  //   } catch (error) {
  //     userSession.logger.error('Error processing audio buffer:', error);
  //   } finally {
  //     // Clear processing flag
  //     userSession.audioBuffer.processingInProgress = false;
  //   }
  // }

  /**
   * 🚀⚡️ Initializes WebSocket servers and sets up connection handling.
   * @param server - HTTP/HTTPS server instance to attach WebSocket servers to
   */
  setupWebSocketServers(server: Server): void {
    server.on('upgrade', (request, socket, head) => {
      try {
        const url = new URL(request.url || '', `http://${request.headers.host}`);

        // Log detailed information about the upgrade request
        logger.debug({
          msg: 'WebSocket upgrade request received',
          path: url.pathname,
          headers: {
            host: request.headers.host,
            origin: request.headers.origin,
            upgrade: request.headers.upgrade,
            connection: request.headers.connection,
            secWebSocketKey: request.headers['sec-websocket-key']?.substring(0, 10) + '...',
            secWebSocketVersion: request.headers['sec-websocket-version']
          },
          remoteAddress: request.socket.remoteAddress
        });

        if (url.pathname === '/glasses-ws') {
          logger.debug({ msg: 'Processing glasses-ws upgrade request' });

          try {
            this.glassesWss.handleUpgrade(request, socket, head, ws => {
              logger.debug({ msg: 'Glasses WebSocket upgrade successful' });
              this.glassesWss.emit('connection', ws, request);
            });
          } catch (upgradeError) {
            logger.error({
              msg: 'Failed to upgrade glasses WebSocket connection',
              error: upgradeError
            });
            socket.destroy();
          }

        } else if (url.pathname === '/tpa-ws') {
          logger.debug({ msg: 'Processing tpa-ws upgrade request' });

          try {
            this.tpaWss.handleUpgrade(request, socket, head, ws => {
              logger.debug({ msg: 'TPA WebSocket upgrade successful' });
              this.tpaWss.emit('connection', ws, request);
            });
          } catch (upgradeError) {
            logger.error({
              msg: 'Failed to upgrade TPA WebSocket connection',
              error: upgradeError
            });
            socket.destroy();
          }

        } else {
          logger.debug({
            msg: 'Unknown WebSocket path, destroying socket',
            path: url.pathname
          });
          socket.destroy();
        }
      } catch (error) {
        logger.error({
          msg: 'Error in WebSocket upgrade handler',
          error,
          url: request.url
        });
        socket.destroy();
      }
    });

    // Glasses connection handler with enhanced error logging
    this.glassesWss.on('connection', (ws, request) => {
      logger.info({ msg: 'New glasses WebSocket connection established' });

      this.handleGlassesConnection(ws, request).catch(error => {
        logger.error({
          msg: 'Error handling glasses connection',
          error: {
            name: error.name,
            message: error.message,
            stack: error.stack
          }
        });
      });
    });

    // TPA connection handler with enhanced error logging
    this.tpaWss.on('connection', (ws, request) => {
      logger.info({ msg: 'New TPA WebSocket connection established' });

      this.handleTpaConnection(ws, request).catch(error => {
        logger.error({
          msg: 'Error handling TPA connection',
          error: {
            name: error.name,
            message: error.message,
            stack: error.stack
          }
        });
      });
    });
  }

  private microphoneStateChangeDebouncers = new Map<string, MicrophoneStateChangeDebouncer>();

  /**
   * Sends a debounced microphone state change message.
   * The first call sends the message immediately.
   * Subsequent calls are debounced and only the final state is sent if it differs
   * from the last sent state. After the delay, the debouncer is removed.
   *
   * @param ws - WebSocket connection to send the update on
   * @param userSession - The current user session
   * @param isEnabled - Desired microphone enabled state
   * @param delay - Debounce delay in milliseconds (default: 1000ms)
   */
  private sendDebouncedMicrophoneStateChange(
    ws: WebSocket,
    userSession: UserSession,
    isEnabled: boolean,
    delay = 1000
  ): void {
    const sessionId = userSession.sessionId;
    let debouncer = this.microphoneStateChangeDebouncers.get(sessionId);

    if (!debouncer) {
      // First call: send immediately.
      const message: MicrophoneStateChange = {
        type: CloudToGlassesMessageType.MICROPHONE_STATE_CHANGE,
        sessionId: userSession.sessionId,
        userSession: {
          sessionId: userSession.sessionId,
          userId: userSession.userId,
          startTime: userSession.startTime,
          activeAppSessions: userSession.activeAppSessions,
          loadingApps: userSession.loadingApps,
          isTranscribing: userSession.isTranscribing,
        },
        isMicrophoneEnabled: isEnabled,
        timestamp: new Date(),
      };
      ws.send(JSON.stringify(message));

      // Create a debouncer inline to track subsequent calls.
      debouncer = {
        timer: null,
        lastState: isEnabled,
        lastSentState: isEnabled,
      };
      this.microphoneStateChangeDebouncers.set(sessionId, debouncer);
    } else {
      // For subsequent calls, update the desired state.
      debouncer.lastState = isEnabled;
      if (debouncer.timer) {
        clearTimeout(debouncer.timer);
      }
    }

    // Set or reset the debounce timer.
    debouncer.timer = setTimeout(() => {
      // Only send if the final state differs from the last sent state.
      if (debouncer!.lastState !== debouncer!.lastSentState) {
        userSession.logger.info('[websocket.service]: Sending microphone state change message');
        const message: MicrophoneStateChange = {
          type: CloudToGlassesMessageType.MICROPHONE_STATE_CHANGE,
          sessionId: userSession.sessionId,
          userSession: {
            sessionId: userSession.sessionId,
            userId: userSession.userId,
            startTime: userSession.startTime,
            activeAppSessions: userSession.activeAppSessions,
            loadingApps: userSession.loadingApps,
            isTranscribing: userSession.isTranscribing,
          },
          isMicrophoneEnabled: debouncer!.lastState,
          timestamp: new Date(),
        };
        ws.send(JSON.stringify(message));
        debouncer!.lastSentState = debouncer!.lastState;
      }

      if (debouncer!.lastSentState) {
        transcriptionService.startTranscription(userSession);
      } else {
        transcriptionService.stopTranscription(userSession);
      }

      // Cleanup: remove the debouncer after processing.
      this.microphoneStateChangeDebouncers.delete(sessionId);
    }, delay);
  }

  /**
    * 📊 Generates the current app status for a user session
    * @param userSession - User session to generate status for
    * @returns Promise resolving to App State Change object ready to be sent to glasses or API
    */
  async generateAppStateStatus(userSession: UserSession): Promise<AppStateChange> {
    // Get the list of active apps
    const activeAppPackageNames = Array.from(new Set(userSession.activeAppSessions));

    // Create a map of active apps and what stream types they are subscribed to
    const appSubscriptions = new Map<string, ExtendedStreamType[]>(); // packageName -> streamTypes
    const whatToStream: Set<ExtendedStreamType> = new Set(); // packageName -> streamTypes

    for (const packageName of activeAppPackageNames) {
      const subscriptions = subscriptionService.getAppSubscriptions(userSession.sessionId, packageName);
      appSubscriptions.set(packageName, subscriptions);
      for (const subscription of subscriptions) {
        whatToStream.add(subscription);
      }
    }

    // Dashboard subscriptions
    const dashboardSubscriptions = subscriptionService.getAppSubscriptions(
      userSession.sessionId,
      systemApps.dashboard.packageName
    );
    appSubscriptions.set(systemApps.dashboard.packageName, dashboardSubscriptions);
    for (const subscription of dashboardSubscriptions) {
      whatToStream.add(subscription);
    }

    const userSessionData = {
      sessionId: userSession.sessionId,
      userId: userSession.userId,
      startTime: userSession.startTime,
      installedApps: await appService.getAllApps(userSession.userId),
      appSubscriptions: Object.fromEntries(appSubscriptions),
      activeAppPackageNames,
      whatToStream: Array.from(new Set(whatToStream)),
    };

    const appStateChange: AppStateChange = {
      type: CloudToGlassesMessageType.APP_STATE_CHANGE,
      sessionId: userSession.sessionId,
      userSession: userSessionData,
      timestamp: new Date()
    };

    return appStateChange;
  }

  /**
   * 🚀🪝 Initiates a new TPA session and triggers the TPA's webhook.
   * @param userSession - userSession object for the user initiating the TPA session
   * @param packageName - TPA identifier
   * @returns Promise resolving to the TPA session ID
   * @throws Error if app not found or webhook fails
   */
  async startAppSession(userSession: UserSession, packageName: string): Promise<string> {
    // check if it's already loading or running, if so return the session id.
    if (userSession.loadingApps.has(packageName) || userSession.activeAppSessions.includes(packageName)) {
      userSession.logger.info(`[websocket.service]: 🚀🚀🚀 App ${packageName} already loading or running\n `);
      return userSession.sessionId + '-' + packageName;
    }

    const app = await appService.getApp(packageName);
    if (!app) {
      userSession.logger.error(`[websocket.service]: 🚀🚀🚀 App ${packageName} not found\n `);
      throw new Error(`App ${packageName} not found`);
    }

    userSession.logger.info(`[websocket.service]: ⚡️ Loading app ${packageName} for user ${userSession.userId}\n`);

    // If this is a STANDARD app, we need to stop any other STANDARD apps that are running
    // if (app.tpaType === TpaType.STANDARD) {
    //   userSession.logger.info(`[websocket.service]: 🚦 Starting STANDARD app, checking for other STANDARD apps to stop`);

    //   // Find all active STANDARD apps
    //   const runningStandardApps = [];

    //   for (const activeAppName of userSession.activeAppSessions) {
    //     // Skip if this is the app we're trying to start
    //     if (activeAppName === packageName) continue;

    //     // Get the app details to check its type
    //     try {
    //       const activeApp = await appService.getApp(activeAppName);
    //       if (activeApp && activeApp.tpaType === TpaType.STANDARD) {
    //         runningStandardApps.push(activeAppName);
    //       }
    //     } catch (error) {
    //       userSession.logger.error(`[websocket.service]: Error checking app type for ${activeAppName}:`, error);
    //       // Continue with the next app even if there's an error
    //     }
    //   }

    //   // Stop any running STANDARD apps
    //   for (const standardAppToStop of runningStandardApps) {
    //     userSession.logger.info(`[websocket.service]: 🛑 Stopping STANDARD app ${standardAppToStop} before starting ${packageName}`);
    //     try {
    //       await this.stopAppSession(userSession, standardAppToStop);
    //     } catch (error) {
    //       userSession.logger.error(`[websocket.service]: Error stopping STANDARD app ${standardAppToStop}:`, error);
    //       // Continue with the next app even if there's an error
    //     }
    //   }
    // }

    // Store pending session.
    userSession.loadingApps.add(packageName);
    userSession.logger.debug({ loadingApps: userSession.loadingApps }, `[websocket.service]: Current Loading Apps:`,);

    try {
      // Trigger TPA webhook 
      const { packageName, name, publicUrl } = app;
      userSession.logger.debug({ packageName, name, publicUrl }, "[websocket.service]: ⚡️Triggering webhook for app⚡️");

      // Set up the websocket URL for the TPA connection
      let augmentOSWebsocketUrl = '';

      // Determine the appropriate WebSocket URL based on the environment and app type
      if (app.isSystemApp) {
        // For system apps in container environments, use internal service name
        if (process.env.CONTAINER_ENVIRONMENT === 'true' ||
          process.env.CLOUD_HOST_NAME === 'cloud' ||
          process.env.PORTER_APP_NAME) {

          // Porter environment (Kubernetes)
          if (process.env.PORTER_APP_NAME) {
            augmentOSWebsocketUrl = `ws://${process.env.PORTER_APP_NAME}-cloud.default.svc.cluster.local:80/tpa-ws`;
            userSession.logger.info(`Using Porter internal URL for system app ${packageName}`);
          } else {
            // Docker Compose environment
            augmentOSWebsocketUrl = 'ws://cloud/tpa-ws';
            userSession.logger.info(`Using Docker internal URL for system app ${packageName}`);
          }
        } else {
          // Local development for system apps
          augmentOSWebsocketUrl = 'ws://localhost:8002/tpa-ws';
          userSession.logger.info(`Using local URL for system app ${packageName}`);
        }
      } else {
        // For non-system apps, use the public host
        augmentOSWebsocketUrl = `wss://${CLOUD_PUBLIC_HOST_NAME}/tpa-ws`;
        userSession.logger.info({augmentOSWebsocketUrl, packageName, name}, `Using public URL for app ${packageName}`);
      }

      userSession.logger.info(`🔥🔥🔥 [websocket.service]: Server WebSocket URL: ${augmentOSWebsocketUrl}`);
      // Construct the webhook URL from the app's public URL
      const webhookURL = `${app.publicUrl}/webhook`;
      userSession.logger.info(`🔥🔥🔥 [websocket.service]: Start Session webhook URL: ${webhookURL}`);
      await appService.triggerWebhook(webhookURL, {
        type: WebhookRequestType.SESSION_REQUEST,
        sessionId: userSession.sessionId + '-' + packageName,
        userId: userSession.userId,
        timestamp: new Date().toISOString(),
        augmentOSWebsocketUrl,
      });

      // Trigger boot screen.
      userSession.displayManager.handleAppStart(app.packageName, userSession);

      // Set timeout to clean up pending session
      setTimeout(() => {
        if (userSession.loadingApps.has(packageName)) {
          userSession.loadingApps.delete(packageName);
          userSession.logger.info(`[websocket.service]: 👴🏻 TPA ${packageName} expired without connection`);

          // Clean up boot screen.
          userSession.displayManager.handleAppStop(app.packageName, userSession);
        }
      }, TPA_SESSION_TIMEOUT_MS);

      // Add the app to active sessions after successfully starting it
      if (!userSession.activeAppSessions.includes(packageName)) {
        userSession.activeAppSessions.push(packageName);
      }

      // Remove from loading apps after successfully starting
      userSession.loadingApps.delete(packageName);
      userSession.logger.info(`[websocket.service]: Successfully started app ${packageName}`);

      // Update database
      try {
        const user = await User.findByEmail(userSession.userId);
        if (user) {
          await user.addRunningApp(packageName);
        }
      } catch (error) {
        userSession.logger.error(`Error updating user's running apps:`, error);
      }

      // Check if we need to update microphone state for media subscriptions
      if (userSession.websocket && userSession.websocket.readyState === 1) {
        // Send explicit app_started message
        const appStartedMessage = {
          type: 'app_started',
          packageName,
          timestamp: new Date(),
        };
        userSession.websocket.send(JSON.stringify(appStartedMessage));

        const mediaSubscriptions = subscriptionService.hasMediaSubscriptions(userSession.sessionId);
        if (mediaSubscriptions) {
          userSession.logger.info('Media subscriptions detected after starting app, updating microphone state');
          this.sendDebouncedMicrophoneStateChange(userSession.websocket, userSession, true);
        }
      }

      return userSession.sessionId + '-' + packageName;
    } catch (error) {
      userSession.logger.error(`[websocket.service]: Error starting app ${packageName}:`, error);
      userSession.loadingApps.delete(packageName);
      throw error;
    }
  }

  /**
  * 🛑 Stops an app session and handles cleanup.
  * @param userSession - userSession object for the user stopping the app
  * @param packageName - Package name of the app to stop
  * @returns Promise resolving to boolean indicating success
  * @throws Error if app not found or stop fails
  */
  async stopAppSession(userSession: UserSession, packageName: string): Promise<boolean> {
    userSession.logger.info(`\n[websocket.service]\n🛑 Stopping app ${packageName} for user ${userSession.userId}\n`);

    const app = await appService.getApp(packageName);
    if (!app) {
      userSession.logger.error(`\n[websocket.service]\n🛑 App ${packageName} not found\n `);
      throw new Error(`App ${packageName} not found`);
    }

    try {
      // Remove subscriptions
      subscriptionService.removeSubscriptions(userSession, packageName);

      // Remove app from active list
      userSession.activeAppSessions = userSession.activeAppSessions.filter(
        (appName) => appName !== packageName
      );

      try {
        const tpaSessionId = `${userSession.sessionId}-${packageName}`;

        // console.log("🔥🔥🔥: Triggering stop webhook for", app.publicUrl);
        // console.log("🔥🔥🔥: TPA Session ID:", tpaSessionId);
        await appService.triggerStopWebhook(
          app.publicUrl,
          {
            type: WebhookRequestType.STOP_REQUEST,
            sessionId: tpaSessionId,
            userId: userSession.userId,
            reason: 'user_disabled',
            timestamp: new Date().toISOString()
          }
        );
      } catch (error) {
        userSession.logger.error(`Error calling stop webhook for ${packageName}:`, error);
        // Continue with cleanup even if webhook fails
      }

      // End the websocket connection for the app
      try {
        const websocket = userSession.appConnections.get(packageName);
        if (websocket && websocket.readyState === WebSocket.OPEN) {
          websocket.close();
          userSession.appConnections.delete(packageName);
        }
      } catch (error) {
        userSession.logger.error(`Error ending websocket for TPA ${packageName}:`, error);
        // Continue with cleanup even if webhook fails
      }

      // Update user's running apps in database
      try {
        const user = await User.findByEmail(userSession.userId);
        if (user) {
          await user.removeRunningApp(packageName);
        }
      } catch (error) {
        userSession.logger.error(`Error updating user's running apps:`, error);
      }

      // Update the display
      userSession.displayManager.handleAppStop(packageName, userSession);

      // Check if we need to update microphone state based on remaining apps
      if (userSession.websocket && userSession.websocket.readyState === 1) {
        // Send explicit app_stopped message
        const appStoppedMessage = {
          type: 'app_stopped',
          packageName,
          timestamp: new Date(),
        };
        userSession.websocket.send(JSON.stringify(appStoppedMessage));

        const mediaSubscriptions = subscriptionService.hasMediaSubscriptions(userSession.sessionId);
        if (!mediaSubscriptions) {
          userSession.logger.info('No media subscriptions after stopping app, updating microphone state');
          this.sendDebouncedMicrophoneStateChange(userSession.websocket, userSession, false);
        }
      }

      userSession.logger.info(`Successfully stopped app ${packageName}`);
      return true;
    } catch (error) {
      userSession.logger.error(`Error stopping app ${packageName}:`, error);
      // Ensure app is removed from active sessions even if an error occurs
      userSession.activeAppSessions = userSession.activeAppSessions.filter(
        (appName) => appName !== packageName
      );
      throw error;
    }
  }

  /**
   * 🗣️📣 Broadcasts data to all TPAs subscribed to a specific stream type.
   * @param userSessionId - ID of the user's glasses session
   * @param streamType - Type of data stream
   * @param data - Data to broadcast
   */
  broadcastToTpa(userSessionId: string, streamType: StreamType, data: CloudToTpaMessage): void {
    const userSession = this.getSessionService().getSession(userSessionId);
    if (!userSession) {
      logger.error(`[websocket.service]: User session not found for ${userSessionId}`);
      return;
    }

    // If the stream is transcription or translation and data has language info,
    // construct an effective subscription string.
    let effectiveSubscription: ExtendedStreamType = streamType;
    // For translation, you might also include target language if available.
    if (streamType === StreamType.TRANSLATION) {
      effectiveSubscription = `${streamType}:${(data as any).transcribeLanguage}-to-${(data as any).translateLanguage}`;
    } else if (streamType === StreamType.TRANSCRIPTION && !(data as any).transcribeLanguage) {
      effectiveSubscription = `${streamType}:en-US`;
    } else if (streamType === StreamType.TRANSCRIPTION) {
      effectiveSubscription = `${streamType}:${(data as any).transcribeLanguage}`;
    }

    const subscribedApps = subscriptionService.getSubscribedApps(userSession, effectiveSubscription);

    subscribedApps.forEach(packageName => {
      const tpaSessionId = `${userSession.sessionId}-${packageName}`;
      const websocket = userSession.appConnections.get(packageName);
      if (websocket && websocket.readyState === 1) {
        // CloudDataStreamMessage
        const dataStream: DataStream = {
          type: CloudToTpaMessageType.DATA_STREAM,
          sessionId: tpaSessionId,
          streamType, // Base type remains the same in the message.
          data,      // The data now may contain language info.
          timestamp: new Date()
        };

        websocket.send(JSON.stringify(dataStream));
      } else {
        userSession.logger.error(`[websocket.service]: TPA ${packageName} not connected`);
      }
    });
  }

  broadcastToTpaAudio(userSession: UserSession, arrayBuffer: ArrayBufferLike): void {
    const subscribedApps = subscriptionService.getSubscribedApps(userSession, StreamType.AUDIO_CHUNK);

    for (const packageName of subscribedApps) {
      const websocket = userSession.appConnections.get(packageName);

      if (websocket && websocket.readyState === 1) {
        websocket.send(arrayBuffer);
      } else {
        userSession.logger.error(`[websocket.service]: TPA ${packageName} not connected`);
      }
    }
  }

  /**
   * Forward a photo response to the requesting TPA
   * @param requestId The ID of the photo request
   * @param photoUrl The URL of the uploaded photo
   * @returns True if the response was forwarded, false if no pending request was found
   * @deprecated Use photoRequestService.processPhotoResponse instead
   */
  forwardPhotoResponse(requestId: string, photoUrl: string): boolean {
    // Forward to the new service
    return photoRequestService.processPhotoResponse(requestId, photoUrl);
  }

  /**
   * Forward a video stream response to the requesting TPA
   * @param appId The ID of the app requesting the stream
   * @param streamUrl The URL of the video stream
   * @param userSession The user session
   * @returns True if the response was forwarded, false if TPA not found or connection closed
   */
  forwardVideoStreamResponse(appId: string, streamUrl: string, userSession: UserSession): boolean {
    // Find the TPA connection
    const tpaWebSocket = userSession.appConnections.get(appId);

    if (!tpaWebSocket || tpaWebSocket.readyState !== WebSocket.OPEN) {
      logger.warn(`[websocket.service]: Cannot forward video stream response, TPA ${appId} not connected`);
      return false;
    }

    // Send the video stream response to the TPA
    const videoStreamResponse = {
      type: CloudToTpaMessageType.VIDEO_STREAM_RESPONSE,
      streamUrl,
      appId,
      timestamp: new Date()
    };

    tpaWebSocket.send(JSON.stringify(videoStreamResponse));
    logger.info(`[websocket.service]: Video stream response sent to TPA ${appId}`);

    return true;
  }
  /**
   * 🥳🤓 Handles new glasses client connections.
   * @param ws - WebSocket connection
   * @param request - Incoming message
   * @private
   */
  private async handleGlassesConnection(ws: WebSocket, request: IncomingMessage): Promise<void> {
    // Get the headers from the request and log them with lots of fire emojis. 🔥🔥🔥 🔥🔥 🔥 🔥🔥🔥.
    logger.info(`[websocket.service]: Glasses WebSocket connection request headers:`, request.headers);
    logger.info('[websocket.service]: New glasses client attempting to connect...');
    // get the coreToken from the request headers authorization: Bearer <coreToken>
    const coreToken = request.headers.authorization?.split(' ')[1];
    if (!coreToken) {
      logger.error('[websocket.service]: No core token provided in request headers');
      const errorMessage: ConnectionError = {
        type: CloudToGlassesMessageType.CONNECTION_ERROR,
        message: 'No core token provided',
        timestamp: new Date()
      };
      ws.send(JSON.stringify(errorMessage));
      return;
    }
    // Verify the core token
    let userId = '';
    try {
      const userData = jwt.verify(coreToken, AUGMENTOS_AUTH_JWT_SECRET);
      userId = (userData as JwtPayload).email;
      if (!userId) {
        throw new Error('User ID is required');
      }
    } catch (error) {
      logger.error('[websocket.service]: Error verifying core token:', error);
      const errorMessage: ConnectionError = {
        type: CloudToGlassesMessageType.CONNECTION_ERROR,
        message: 'Invalid core token',
        timestamp: new Date()
      };
      ws.send(JSON.stringify(errorMessage));
      return;
    }
    // Set up the user session
    logger.info('[websocket.service]: Glasses client connected successfully');
    // Set up the user session
    const startTimestamp = new Date();


    // Create the user session
    const userSession = await this.getSessionService().createSession(ws, userId);

    // Register this connection with the HeartbeatManager
    userSession.heartbeatManager.registerGlassesConnection(ws);

    // Set up the audio buffer processing interval
    // if (userSession.audioBuffer) {
    //   // Clear any existing interval first
    //   if (userSession.audioBuffer.bufferProcessingInterval) {
    //     clearInterval(userSession.audioBuffer.bufferProcessingInterval);
    //   }

    //   // Create new interval that calls our processAudioBuffer method
    //   userSession.audioBuffer.bufferProcessingInterval = setInterval(() => {
    //     this.processAudioBuffer(userSession);
    //   }, 100); // Process every 100ms

    //   userSession.logger.info(`✅ Audio buffer processing interval set up for session ${userSession.sessionId}`);
    // }
    ws.on('message', async (message: Buffer | string, isBinary: boolean) => {
      try {

        // console.log("@@@@@: Received message from glasses:", message);
        // console.log("🔥🔥🔥: isBinary:", isBinary);

        // Handle binary messages (typically audio)
        if (Buffer.isBuffer(message) && isBinary) {
          const _buffer = message as Buffer;
          // Convert Node.js Buffer to ArrayBuffer
          const arrayBuf: ArrayBufferLike = _buffer.buffer.slice(
            _buffer.byteOffset,
            _buffer.byteOffset + _buffer.byteLength
          );
          // Process the audio data
          const _arrayBuffer = await this.getSessionService().handleAudioData(userSession, arrayBuf);
          // Send audio chunk to TPAs subscribed to audio_chunk
          if (_arrayBuffer) {
            this.broadcastToTpaAudio(userSession, _arrayBuffer);
          }
          return;
        }

        // Update the last activity timestamp for this connection
        userSession.heartbeatManager.updateGlassesActivity(ws);
        // console.log("🔥🔥🔥: Received message from glasses:", message);

        // Handle JSON messages
        const parsedMessage = JSON.parse(message.toString()) as GlassesToCloudMessage;
        await this.handleGlassesMessage(userSession, ws, parsedMessage);
      } catch (error) {
        userSession.logger.error(`[websocket.service]: Error handling glasses message:`, error);
        this.sendError(ws, {
          type: CloudToGlassesMessageType.CONNECTION_ERROR,
          message: 'Error processing message'
        });
      }
    });

    // Set up ping handler to track connection health
    ws.on('ping', () => {
      // Update activity whenever a ping is received
      userSession.heartbeatManager.updateGlassesActivity(ws);
      // Send pong response
      try {
        ws.pong();
      } catch (error) {
        userSession.logger.error('[websocket.service]: Error sending pong:', error);
      }
    });

    const RECONNECT_GRACE_PERIOD_MS = 1000 * 60 * 1; // 1 minute
    ws.on('close', (code: number, reason: string) => {
      // Capture detailed disconnect information
      const disconnectInfo = userSession.heartbeatManager.captureDisconnect(ws, code, reason);

      userSession.logger.info(`[websocket.service]: Glasses WebSocket disconnected: ${userSession.sessionId}, reason: ${disconnectInfo?.reason || 'unknown'}`);

      // Mark the session as disconnected but do not remove it immediately
      this.getSessionService().markSessionDisconnected(userSession);

      // Set a timeout to eventually clean up the session if not reconnected
      setTimeout(() => {
        userSession.logger.info(`[websocket.service]: Grace period expired, checking if we should cleanup session: ${userSession.sessionId}`);
        if (userSession.websocket.readyState === WebSocket.CLOSED || userSession.websocket.readyState === WebSocket.CLOSING) {
          userSession.logger.info(`[websocket.service]: User disconnected: ${userSession.sessionId}`);
          this.getSessionService().endSession(userSession);
        }
      }, RECONNECT_GRACE_PERIOD_MS);

      // Track disconnection event in posthog with more detailed information
      const endTimestamp = new Date();
      const connectionDuration = endTimestamp.getTime() - startTimestamp.getTime();
      PosthogService.trackEvent('disconnected', userSession.userId, {
        userId: userSession.userId,
        sessionId: userSession.sessionId,
        timestamp: new Date().toISOString(),
        duration: connectionDuration,
        disconnectReason: disconnectInfo?.reason || 'unknown',
        disconnectCode: disconnectInfo?.code || 0
      });
    });

    // TODO(isaiahb): Investigate if we really need to destroy the session on an error.
    ws.on('error', (error) => {
      userSession.logger.error(`[websocket.service]: Glasses WebSocket error:`, error);

      // Unregister from heartbeat manager
      userSession.heartbeatManager.unregisterConnection(ws);

      this.getSessionService().endSession(userSession);
      ws.close();
    });
  }

  /**
   * 🤓 Handles messages from glasses clients.
   * @param userSession - User Session identifier
   * @param ws - WebSocket connection
   * @param message - Parsed message from client
   * @private
   */
  private async handleGlassesMessage(
    userSession: UserSession,
    ws: WebSocket,
    message: GlassesToCloudMessage
  ): Promise<void> {
    try {
      // Track the incoming message event
      PosthogService.trackEvent(message.type, userSession.userId, {
        sessionId: userSession.sessionId,
        eventType: message.type,
        timestamp: new Date().toISOString()
      });

      switch (message.type) {
        // 'connection_init'
        case GlassesToCloudMessageType.CONNECTION_INIT: {
          // const initMessage = message as ConnectionInit;
          // we refactored this logic to happen when the websocket is created, so the client doesn't need to send this message anymore.

          // Start all the apps that the user has running.
          try {
            // Start the dashboard app, but let's not add to the user's running apps since it's a system app.
            // honestly there should be no annyomous users so if it's an anonymous user we should just not start the dashboard
            await this.startAppSession(userSession, systemApps.dashboard.packageName);
          }
          catch (error) {
            userSession.logger.error(`[websocket.service]: Error starting dashboard app:`, error);
          }

          // Start all the apps that the user has running.
          try {
            const user = await User.findOrCreateUser(userSession.userId);
            userSession.logger.debug(`[websocket.service]: Trying to start ${user.runningApps.length} apps\n[${userSession.userId}]: [${user.runningApps.join(", ")}]`);
            for (const packageName of user.runningApps) {
              try {
                await this.startAppSession(userSession, packageName);
                userSession.activeAppSessions.push(packageName);
                userSession.logger.info(`[websocket.service]: ✅ Starting app ${packageName}`);
              }
              catch (error) {
                userSession.logger.error(`[websocket.service]: Error starting user apps:`, error);
                // Remove the app from the user's running apps if it fails to start. and save the user.
                try {
                  await user.removeRunningApp(packageName);
                  userSession.logger.info(`[websocket.service]: Removed app ${packageName} from user running apps because it failed to start`);
                }
                catch (error) {
                  userSession.logger.error(`[websocket.service]: Error Removing app ${packageName} from user running apps:`, error);
                }
              }
            }
            userSession.logger.info(`[websocket.service]: 🗿🗿✅🗿🗿 Starting app ${systemApps.dashboard.packageName}`);
          }
          catch (error) {
            userSession.logger.error(`[websocket.service] Error starting user apps:`, error);
          }

          // Start transcription
          transcriptionService.startTranscription(userSession);

          // const ackMessage: CloudConnectionAckMessage = {
          const ackMessage: ConnectionAck = {
            type: CloudToGlassesMessageType.CONNECTION_ACK,
            sessionId: userSession.sessionId,
            userSession: await this.getSessionService().transformUserSessionForClient(userSession as ExtendedUserSession),
            timestamp: new Date()
          };

          ws.send(JSON.stringify(ackMessage));
          // userSession.logger.info(`[websocket.service]\nSENDING connection_ack` + JSON.stringify(ackMessage));

          // Track connection event.
          PosthogService.trackEvent('connected', userSession.userId, {
            sessionId: userSession.sessionId,
            timestamp: new Date().toISOString()
          });
          break;
        }

        case "request_settings": {
          userSession.logger.info('Received settings request');

          try {
            const user = await User.findByEmail(userSession.userId);
            const userSettings = user?.augmentosSettings || DEFAULT_AUGMENTOS_SETTINGS;

            const settingsMessage: CloudToGlassesMessage = {
              type: CloudToGlassesMessageType.SETTINGS_UPDATE,
              sessionId: userSession.sessionId,
              settings: userSettings,
              timestamp: new Date()
            };

            console.log("🔥🔥🔥: Sending settings update:", JSON.stringify(settingsMessage));

            ws.send(JSON.stringify(settingsMessage));
            userSession.logger.info('Sent settings update');
          } catch (error) {
            userSession.logger.error('Error sending settings:', error);
            const errorMessage: ConnectionError = {
              type: CloudToGlassesMessageType.CONNECTION_ERROR,
              message: 'Error retrieving settings',
              timestamp: new Date()
            };
            ws.send(JSON.stringify(errorMessage));
          }
          break;
        }

        case 'start_app': {
          const startMessage = message as StartApp;
          userSession.logger.info(`🚀🚀🚀[START_APP]: Starting app ${startMessage.packageName}`);

          try {
            // Start the app using our service method
            await this.startAppSession(userSession, startMessage.packageName);

            // Generate and send app state to the glasses
            const appStateChange = await this.generateAppStateStatus(userSession);

            // console.log("🔥🔥🔥: Sending app state change:", appStateChange);
            ws.send(JSON.stringify(appStateChange));

            // Track event
            PosthogService.trackEvent(`start_app:${startMessage.packageName}`, userSession.userId, {
              sessionId: userSession.sessionId,
              eventType: message.type,
              timestamp: new Date().toISOString()
            });
          } catch (error) {
            userSession.logger.error(`Error starting app ${startMessage.packageName}:`, error);
          }
          break;
        }

        case 'stop_app': {
          const stopMessage = message as StopApp;
          userSession.logger.info(`Stopping app ${stopMessage.packageName}`);

          try {
            // Track event before stopping
            PosthogService.trackEvent(`stop_app:${stopMessage.packageName}`, userSession.userId, {
              sessionId: userSession.sessionId,
              eventType: message.type,
              timestamp: new Date().toISOString()
            });

            const appConnection = userSession.appConnections.get(stopMessage.packageName);
            // console.log("fds", userSession.appConnections);
            if (appConnection && appConnection.readyState === WebSocket.OPEN) {
              userSession.logger.info(`[websocket.service]: Closing app connection for ${stopMessage.packageName}`);
              appConnection.close(1000, 'App stopped by user');
            }
            userSession.appConnections.delete(stopMessage.packageName);
            // Stop the app using our service method
            await this.stopAppSession(userSession, stopMessage.packageName);

            // Generate and send updated app state to the glasses
            const appStateChange = await this.generateAppStateStatus(userSession);
            ws.send(JSON.stringify(appStateChange));
          } catch (error) {
            userSession.logger.error(`Error stopping app ${stopMessage.packageName}:`, error);
            // Ensure app is removed from active sessions even if an error occurs
            userSession.activeAppSessions = userSession.activeAppSessions.filter(
              (packageName) => packageName !== stopMessage.packageName
            );
          }
          break;
        }

        case GlassesToCloudMessageType.GLASSES_CONNECTION_STATE: {
          const glassesConnectionStateMessage = message as GlassesConnectionState;

          userSession.logger.info('Glasses connection state:', glassesConnectionStateMessage);

          if (glassesConnectionStateMessage.status === 'CONNECTED') {
            const mediaSubscriptions = subscriptionService.hasMediaSubscriptions(userSession.sessionId);
            userSession.logger.info('Init Media subscriptions:', mediaSubscriptions);
            this.sendDebouncedMicrophoneStateChange(ws, userSession, mediaSubscriptions);
          }

          // Track the connection state event
          PosthogService.trackEvent(GlassesToCloudMessageType.GLASSES_CONNECTION_STATE, userSession.userId, {
            sessionId: userSession.sessionId,
            eventType: message.type,
            timestamp: new Date().toISOString(),
            connectionState: glassesConnectionStateMessage,
          });

          // Track modelName. if status is connected.
          if (glassesConnectionStateMessage.status === 'CONNECTED') {
            PosthogService.trackEvent("modelName", userSession.userId, {
              sessionId: userSession.sessionId,
              eventType: message.type,
              timestamp: new Date().toISOString(),
              modelName: glassesConnectionStateMessage.modelName,
            });
          }
          break;
        }

        case GlassesToCloudMessageType.VAD: {
          const vadMessage = message as Vad;
          const isSpeaking = vadMessage.status === true || vadMessage.status === 'true';

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
            userSession.logger.error('❌ Error handling VAD state change:', error);
            userSession.isTranscribing = false;
            transcriptionService.stopTranscription(userSession);
          }
          this.broadcastToTpa(userSession.sessionId, message.type as any, message as any);
          break;
        }

        // Cache location for dashboard.
        case GlassesToCloudMessageType.LOCATION_UPDATE: {
          const locationUpdate = message as LocationUpdate;
          try {
            console.log("🔥🔥🔥: Received location update from glasses:", locationUpdate);
            // Cache the location update in subscription service
            subscriptionService.cacheLocation(userSession.sessionId, {
              latitude: locationUpdate.lat,
              longitude: locationUpdate.lng,
              timestamp: new Date()
            });

            const user = await User.findByEmail(userSession.userId);
            if (user) {
              await user.setLocation(locationUpdate);
            }
          }
          catch (error) {
            userSession.logger.error(`[websocket.service]: Error updating user location:`, error);
          }
          this.broadcastToTpa(userSession.sessionId, message.type as any, message as any);
          console.warn(`[Session ${userSession.sessionId}] Catching and Sending message type:`, message.type);
          // userSession.location = locationUpdate.location;
          break;
        }

        case GlassesToCloudMessageType.CALENDAR_EVENT: {
          const calendarEvent = message as CalendarEvent;
          userSession.logger.info('Calendar event:', calendarEvent);

          // Cache the event for future subscribers
          subscriptionService.cacheCalendarEvent(userSession.sessionId, calendarEvent);

          this.broadcastToTpa(userSession.sessionId, message.type as any, message);
          break;
        }

        // case 'photo_response': {
        case GlassesToCloudMessageType.PHOTO_RESPONSE: {
          const photoUploadMessage = message as any;
          userSession.logger.info(`[websocket.service]: Received photo response from glasses, requestId: ${photoUploadMessage.requestId}`);

          // Process the photo response
          const success = photoRequestService.processPhotoResponse(
            photoUploadMessage.requestId,
            photoUploadMessage.photoUrl
          );

          if (!success) {
            userSession.logger.warn(`[websocket.service]: Failed to process photo response, no pending request found for requestId: ${photoUploadMessage.requestId}`);
          }
          break;
        }

        // case 'video_stream_response': {
        case 'video_stream_response': {
          const videoStreamResponse = message as any;
          userSession.logger.info(`[websocket.service]: Received video stream response from glasses, appId: ${videoStreamResponse.appId}`);

          // Get the appId from the response
          const appId = videoStreamResponse.appId;
          const streamUrl = videoStreamResponse.streamUrl;

          if (!appId || !streamUrl) {
            userSession.logger.warn(`[websocket.service]: Invalid video stream response, missing appId or streamUrl`);
            return;
          }

          // Forward the video stream response to the requesting TPA
          const success = this.forwardVideoStreamResponse(appId, streamUrl, userSession);

          if (!success) {
            userSession.logger.warn(`[websocket.service]: Failed to forward video stream response to TPA ${appId}`);
          }
          break;
        }

        case "settings_update_request": {
          const settingsUpdate = message as AugmentosSettingsUpdateRequest;
          userSession.logger.info('Received AugmentOS settings update request via WebSocket');

          try {
            // Find or create the user
            const user = await User.findOrCreateUser(userSession.userId);

            // Get current settings from database
            const currentSettings = user.augmentosSettings || DEFAULT_AUGMENTOS_SETTINGS;
            userSession.logger.info('Current settings from database:', currentSettings.brightness);

            // Send current settings back to the client
            const responseMessage = {
              type: 'settings_update',
              success: true,
              message: 'Current settings retrieved successfully',
              settings: currentSettings,
              timestamp: new Date()
            };

            ws.send(JSON.stringify(responseMessage));
          } catch (error) {
            userSession.logger.error('Error retrieving AugmentOS settings:', error);

            // Send error back to client
            const errorMessage = {
              type: 'augmentos_settings_update_error',
              success: false,
              message: error instanceof Error ? error.message : 'Error retrieving settings',
              timestamp: new Date()
            };
            ws.send(JSON.stringify(errorMessage));
          }
          break;
        }

        case "core_status_update": {
          const coreStatusUpdate = message as CoreStatusUpdate;
          // userSession.logger.info('Received core status update:', coreStatusUpdate);

          try {
            // The status is already an object, no need to parse
            const statusObj = coreStatusUpdate.status as any;
            const coreInfo = statusObj.status.core_info;
            const connectedGlasses = statusObj.status.connected_glasses;

            if (!coreInfo || !connectedGlasses) {
              userSession.logger.error('Invalid core status update format - missing required fields');
              break;
            }

            // Map core status fields to augmentos settings
            const newSettings = {
              useOnboardMic: coreInfo.force_core_onboard_mic,
              contextualDashboard: coreInfo.contextual_dashboard_enabled,
              metricSystemEnabled: coreInfo.metric_system_enabled,
              headUpAngle: connectedGlasses.head_up_angle,
              brightness: parseInt(connectedGlasses.brightness),
              autoBrightness: connectedGlasses.auto_brightness,
              sensingEnabled: coreInfo.sensing_enabled,
              alwaysOnStatusBar: coreInfo.always_on_status_bar_enabled,
              bypassVad: coreInfo.bypass_vad_for_debugging,
              bypassAudioEncoding: coreInfo.bypass_audio_encoding_for_debugging,
            };

            console.log("🔥🔥🔥: newSettings:", newSettings);

            // Find or create the user
            const user = await User.findOrCreateUser(userSession.userId);

            // Get current settings before update
            const currentSettingsBeforeUpdate = JSON.parse(JSON.stringify(user.augmentosSettings));
            userSession.logger.info('Current settings before update:', currentSettingsBeforeUpdate);

            console.log("🔥🔥🔥: currentSettingsBeforeUpdate:", currentSettingsBeforeUpdate);
            console.log("🔥🔥🔥: newSettings:", newSettings);

            // Check if anything actually changed
            const changedKeys = getChangedKeys(currentSettingsBeforeUpdate, newSettings);
            console.log("🔥🔥🔥: changedKeys:", changedKeys);
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
                userSession.logger.error('Failed to update AugmentOS settings in the database:', dbError);
                return; // Do not broadcast if DB update fails
              }
              // Only notify for changed keys
              const notifiedApps = new Set<string>();
              for (const key of changedKeys) {
                const subscribedApps = subscriptionService.getSubscribedAppsForAugmentosSetting(userSession, key);
                // userSession.logger.info('Subscribed apps for key:', key, subscribedApps);
                console.log("fgdsgfdgfd", key)
                console.log("fgdsgfdgfd", subscribedApps)
                for (const packageName of subscribedApps) {
                  if (notifiedApps.has(packageName)) continue;
                  console.log("fgdsgfdgfd", packageName)
                  const tpaWs = userSession.appConnections.get(packageName);
                  console.log("fgdsgfdgfd", tpaWs)
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
            userSession.logger.error('Error updating settings from core status:', error);
          }
          break;
        }

        // All other message types are broadcast to TPAs.
        default: {
          userSession.logger.info(`[Session ${userSession.sessionId}] Catching and Sending message type:`, message.type);
          this.broadcastToTpa(userSession.sessionId, message.type as any, message as any);
          break;
        }
      }
    } catch (error) {
      userSession.logger.error(`[Session ${userSession.sessionId}] Error handling message:`, error);
      // Optionally send error to client
      const errorMessage: ConnectionError = {
        type: CloudToGlassesMessageType.CONNECTION_ERROR,
        message: error instanceof Error ? error.message : 'Error processing message',
        timestamp: new Date()
      };

      PosthogService.trackEvent("error-handleGlassesMessage", userSession.userId, {
        sessionId: userSession.sessionId,
        eventType: message.type,
        timestamp: new Date().toISOString(),
        error: error,
      });
      ws.send(JSON.stringify(errorMessage));
    }
  }

  /**
   * 🥳 Handles new TPA connections.
   * @param ws - WebSocket connection
   * @param request - Incoming message
   * @private
   */
  private async handleTpaConnection(ws: WebSocket, request: IncomingMessage): Promise<void> {
    logger.info({
      msg: 'New TPA attempting to connect...',
      headers: {
        origin: request.headers.origin,
        host: request.headers.host,
        userAgent: request.headers['user-agent']
      },
      remoteAddress: request.socket.remoteAddress
    });

    let currentAppSession: string | null = null;
    const setCurrentSessionId = (appSessionId: string) => {
      currentAppSession = appSessionId;
      logger.debug({ msg: 'TPA session ID set', sessionId: appSessionId });
    }
    let userSessionId = '';
    let userSession: ExtendedUserSession | null = null;

    // Add error handler to catch WebSocket errors
    ws.on('error', (wsError) => {
      logger.error({
        msg: 'WebSocket error in TPA connection',
        error: {
          name: wsError.name,
          message: wsError.message,
          stack: wsError.stack
        },
        sessionId: currentAppSession,
        userSessionId
      });
    });

    // Add close handler to track connection closures
    ws.on('close', (code, reason) => {
      logger.info({
        msg: 'TPA WebSocket connection closed',
        code,
        reason: reason.toString(),
        sessionId: currentAppSession,
        userSessionId
      });
    });

    // Note: Will register with HeartbeatManager after we know which session/TPA this belongs to

    ws.on('message', async (data: Buffer | string, isBinary: boolean) => {
      // Update activity timestamp if we have a user session
      if (userSession) {
        userSession.heartbeatManager.updateTpaActivity(ws);
      }

      if (isBinary) {
        logger.warn({
          msg: 'Received unexpected binary message from TPA',
          binaryLength: data instanceof Buffer ? data.length : 'unknown',
          userSessionId,
          currentAppSession
        });
        return;
      }

      try {
        // Log the raw message for debugging (truncated for safety)
        const messageStr = data.toString();
        logger.debug({
          msg: 'Received TPA message data',
          dataLength: messageStr.length,
          dataSample: messageStr.length > 100 ? messageStr.substring(0, 100) + '...' : messageStr,
          userSessionId,
          currentAppSession
        });

        const message = JSON.parse(messageStr) as TpaToCloudMessage;

        logger.debug({
          msg: 'Parsed TPA message',
          messageType: message.type,
          packageName: message.packageName,
          sessionId: message.sessionId
        });

        if (message.sessionId) {
          userSessionId = message.sessionId.split('-')[0];
          logger.debug({ msg: 'Extracted user session ID', userSessionId });

          userSession = this.getSessionService().getSession(userSessionId);

          if (userSession) {
            logger.debug({
              msg: 'Retrieved user session',
              userId: userSession.userId,
              sessionId: userSession.sessionId
            });
          } else {
            logger.warn({
              msg: 'User session not found',
              userSessionId,
              messageSessionId: message.sessionId
            });
          }
        }

        // Handle TPA messages here.
        try {
          switch (message.type) {
            case 'tpa_connection_init': {
              const initMessage = message as TpaConnectionInit;
              logger.info({
                msg: 'TPA connection initialization received',
                packageName: initMessage.packageName,
                sessionId: initMessage.sessionId
              });

              try {
                await this.handleTpaInit(ws, initMessage, setCurrentSessionId);
                logger.info({
                  msg: 'TPA connection initialized successfully',
                  packageName: initMessage.packageName,
                  sessionId: initMessage.sessionId
                });
              } catch (initError) {
                logger.error({
                  msg: 'Failed to initialize TPA connection',
                  error: initError,
                  packageName: initMessage.packageName,
                  sessionId: initMessage.sessionId
                });
                throw initError; // Re-throw to propagate to client
              }
              break;
            }

            case 'subscription_update': {
              if (!userSession || !userSessionId) {
                logger.error(`[websocket.service]: User session not found for ${userSessionId}`);
                ws.close(1008, 'No active session');
                return;
              }

              const subMessage = message as TpaSubscriptionUpdate;

              // Get the minimal language subscriptions before update
              const previousLanguageSubscriptions = subscriptionService.getMinimalLanguageSubscriptions(userSessionId);

              // Check if the app is newly subscribing to calendar events
              const isNewCalendarSubscription =
                !subscriptionService.hasSubscription(userSessionId, message.packageName, StreamType.CALENDAR_EVENT) &&
                subMessage.subscriptions.includes(StreamType.CALENDAR_EVENT);

              // Check if the app is newly subscribing to location updates
              const isNewLocationSubscription =
                !subscriptionService.hasSubscription(userSessionId, message.packageName, StreamType.LOCATION_UPDATE) &&
                subMessage.subscriptions.includes(StreamType.LOCATION_UPDATE);

              // Update subscriptions (async)
              await subscriptionService.updateSubscriptions(
                userSessionId,
                message.packageName,
                userSession.userId,
                subMessage.subscriptions
              );

              // Get the new minimal language subscriptions after update
              const newLanguageSubscriptions = subscriptionService.getMinimalLanguageSubscriptions(userSessionId);

              // Check if language subscriptions have changed
              const languageSubscriptionsChanged =
                previousLanguageSubscriptions.length !== newLanguageSubscriptions.length ||
                !previousLanguageSubscriptions.every(sub => newLanguageSubscriptions.includes(sub));

              if (languageSubscriptionsChanged) {
                userSession.logger.info(
                  `🎤 Language subscriptions changed. Updating transcription streams.`,
                  `🎤 Previous: `, previousLanguageSubscriptions,
                  `🎤 New: `, newLanguageSubscriptions
                );
                // console.log("🔥🔥🔥: newLanguageSubscriptions:", newLanguageSubscriptions);
                // Update transcription streams with new language subscriptions
                transcriptionService.updateTranscriptionStreams(
                  userSession as any, // Cast to ExtendedUserSession
                  newLanguageSubscriptions
                );

                // Check if we need to update microphone state based on media subscriptions
                const mediaSubscriptions = subscriptionService.hasMediaSubscriptions(userSessionId);
                userSession.logger.info('Media subscriptions after update:', mediaSubscriptions);

                if (mediaSubscriptions) {
                  userSession.logger.info('Media subscriptions exist, ensuring microphone is enabled');
                  this.sendDebouncedMicrophoneStateChange(userSession.websocket, userSession, true);
                } else {
                  userSession.logger.info('No media subscriptions, ensuring microphone is disabled');
                  this.sendDebouncedMicrophoneStateChange(userSession.websocket, userSession, false);
                }
              }

              // Send cached calendar event if app just subscribed to calendar events
              if (isNewCalendarSubscription) {
                console.log("🔥🔥🔥: isNewCalendarSubscription:", isNewCalendarSubscription);
                const allCalendarEvents = subscriptionService.getAllCalendarEvents(userSessionId);
                if (allCalendarEvents.length > 0) {
                  userSession.logger.info(`Sending ${allCalendarEvents.length} cached calendar events to newly subscribed app ${message.packageName}`);
                  const tpaSessionId = `${userSessionId}-${message.packageName}`;
                  const tpaWs = userSession.appConnections.get(message.packageName);

                  if (tpaWs && tpaWs.readyState === WebSocket.OPEN) {
                    for (const event of allCalendarEvents) {
                      const dataStream: DataStream = {
                        type: CloudToTpaMessageType.DATA_STREAM,
                        sessionId: tpaSessionId,
                        streamType: StreamType.CALENDAR_EVENT,
                        data: event,
                        timestamp: new Date()
                      };
                      tpaWs.send(JSON.stringify(dataStream));
                    }
                  }
                }
              }

              // Send cached location if app just subscribed to location updates
              if (isNewLocationSubscription) {
                console.log("🔥🔥🔥: isNewLocationSubscription:", isNewLocationSubscription);
                const lastLocation = subscriptionService.getLastLocation(userSessionId);
                if (lastLocation) {
                  userSession.logger.info(`Sending cached location to newly subscribed app ${message.packageName}`);
                  const tpaSessionId = `${userSessionId}-${message.packageName}`;
                  const tpaWs = userSession.appConnections.get(message.packageName);

                  if (tpaWs && tpaWs.readyState === WebSocket.OPEN) {
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
                    tpaWs.send(JSON.stringify(dataStream));
                  }
                }
              }

              // Send cached userDatetime if app just subscribed to custom_message
              const isNewCustomMessageSubscription = subMessage.subscriptions.includes(StreamType.CUSTOM_MESSAGE);

              // console.log('🔥🔥🔥: userSession:', message.packageName);
              // console.log('🔥🔥🔥: subMessage:', subMessage.subscriptions);

              // console.log('🔥🔥🔥: isNewCustomMessageSubscription:', isNewCustomMessageSubscription);
              if (isNewCustomMessageSubscription && (userSession as ExtendedUserSession).userDatetime) {
                userSession.logger.info(`Sending cached userDatetime to app ${message.packageName} on custom_message subscription`);
                const tpaSessionId = `${userSessionId}-${message.packageName}`;
                const tpaWs = userSession.appConnections.get(message.packageName);
                if (tpaWs && tpaWs.readyState === WebSocket.OPEN) {
                  const customMessage = {
                    type: CloudToTpaMessageType.CUSTOM_MESSAGE,
                    action: 'update_datetime',
                    payload: {
                      datetime: (userSession as ExtendedUserSession).userDatetime,
                      section: 'topLeft'
                    },
                    timestamp: new Date()
                  };
                  tpaWs.send(JSON.stringify(customMessage));
                }
              }

              const clientResponse: AppStateChange = {
                type: CloudToGlassesMessageType.APP_STATE_CHANGE,
                sessionId: userSession.sessionId,
                userSession: await this.getSessionService().transformUserSessionForClient(userSession as ExtendedUserSession),
                timestamp: new Date()
              };
              userSession?.websocket.send(JSON.stringify(clientResponse));
              break;
            }

            case 'display_event': {
              if (!userSession) {
                ws.close(1008, 'No active session');
                return;
              }

              const displayMessage = message as DisplayRequest;
              this.getSessionService().updateDisplay(userSession.sessionId, displayMessage);
              break;
            }

            // Dashboard message handling
            case TpaToCloudMessageType.DASHBOARD_CONTENT_UPDATE:
            case TpaToCloudMessageType.DASHBOARD_MODE_CHANGE:
            case TpaToCloudMessageType.DASHBOARD_SYSTEM_UPDATE: {
              if (!userSession) {
                ws.close(1008, 'No active session');
                return;
              }

              try {
                // Import dashboard service functions dynamically to avoid circular dependencies
                const dashboardService = require('../dashboard');

                // Handle the dashboard message, passing both message and userSession
                const handled = dashboardService.handleTpaMessage(message, userSession);

                if (!handled) {
                  userSession.logger.warn(`Dashboard message ${message.type} not handled`, message);
                }
              } catch (error) {
                userSession.logger.error(`Error handling dashboard message ${message.type}:`, error);
              }
              break;
            }

            case 'photo_request': {
              if (!userSession) {
                ws.close(1008, 'No active session');
                return;
              }

              // Check if app has permission to request photos
              const photoRequestMessage = message as PhotoRequest;
              const appId = photoRequestMessage.packageName;
              const saveToGallery = photoRequestMessage.saveToGallery || false;

              // Check if the app is currently running
              if (!userSession.activeAppSessions) {
                this.sendError(ws, {
                  type: CloudToTpaMessageType.CONNECTION_ERROR,
                  message: 'No active app sessions available'
                });
                return;
              }

              // Check if app is in the active sessions array (it's an array, not an object)
              const isAppActive = userSession.activeAppSessions.includes(appId);
              if (!isAppActive) {
                userSession.logger.warn(`[websocket.service]: App ${appId} tried to request photo but is not in active sessions: ${JSON.stringify(userSession.activeAppSessions)}`);
                this.sendError(ws, {
                  type: CloudToTpaMessageType.CONNECTION_ERROR,
                  message: 'App not currently running'
                });
                return;
              }

              // Create a TPA photo request using PhotoRequestService
              const requestId = photoRequestService.createTpaPhotoRequest(
                appId,
                userSession.userId,
                ws,
                { saveToGallery }
              );

              // // Build request to glasses
              // const photoRequestToGlasses = photoRequestService.buildPhotoRequestMessage(
              //   requestId,
              //   userSession.userId,
              //   userSession.sessionId,
              //   appId,
              //   saveToGallery
              // );
              // photoRequestMessage
              // Send request to glasses
              // userSession.websocket.send(JSON.stringify(photoRequestToGlasses));
              userSession.websocket.send(JSON.stringify({
                type: CloudToGlassesMessageType.PHOTO_REQUEST,
                requestId,
                appId,
                timestamp: new Date()
              }));
              userSession.logger.info(`[websocket.service]: Photo request sent to glasses, requestId: ${requestId}`);

              break;
            }

            case 'video_stream_request': {
              if (!userSession) {
                ws.close(1008, 'No active session');
                return;
              }

              // Check if app has permission to request video stream
              const videoStreamRequestMessage = message as VideoStreamRequest;
              const appId = videoStreamRequestMessage.packageName;

              // Check if the app is currently running
              if (!userSession.activeAppSessions) {
                this.sendError(ws, {
                  type: CloudToTpaMessageType.CONNECTION_ERROR,
                  message: 'No active app sessions available'
                });
                return;
              }

              // Check if app is in the active sessions array (it's an array, not an object)
              const isAppActive = userSession.activeAppSessions.includes(appId);
              if (!isAppActive) {
                userSession.logger.warn(`[websocket.service]: App ${appId} tried to request photo but is not in active sessions: ${JSON.stringify(userSession.activeAppSessions)}`);
                this.sendError(ws, {
                  type: CloudToTpaMessageType.CONNECTION_ERROR,
                  message: 'App not currently running'
                });
                return;
              }

              // Build request to glasses
              const videoStreamRequestToGlasses: VideoStreamRequestToGlasses = {
                type: CloudToGlassesMessageType.VIDEO_STREAM_REQUEST,
                userSession: {
                  sessionId: userSession.sessionId,
                  userId: userSession.userId
                },
                appId,
                timestamp: new Date()
              };

              // Send request to glasses
              userSession.websocket.send(JSON.stringify(videoStreamRequestToGlasses));
              userSession.logger.info(`[websocket.service]: Video stream request sent to glasses for app: ${appId}`);

              break;
            }
          }
        }
        catch (error) {
          // Enhanced error logging with structured data
          logger.error({
            error: error,
            messageType: message.type,
            packageName: message.packageName,
            sessionId: message.sessionId,
            userSessionId
          }, "Error handling TPA message");

          // Send error back to client
          this.sendError(ws, {
            type: CloudToTpaMessageType.CONNECTION_ERROR,
            message: `Error processing message: ${(error as any)?.message}`
          });

          // Track error for analytics
          PosthogService.trackEvent("error-handleTpaMessage", "anonymous", {
            eventType: message.type,
            timestamp: new Date().toISOString(),
            error: error,
          });
        }
      } catch (error) {
        // This catch handles JSON parsing errors or other issues
        logger.error({
          error: error,
          rawDataLength: typeof data === 'string' ? data.length : (data instanceof Buffer ? data.length : 'unknown'),
          userSessionId,
          currentAppSession
        }, 'Error parsing or pre-processing TPA message');

        this.sendError(ws, {
          type: CloudToTpaMessageType.CONNECTION_ERROR,
          message: `Error processing message`
        });
      }
    });

    // Set up ping handler to track connection health
    ws.on('ping', () => {
      // Update activity whenever a ping is received
      if (userSession) {
        userSession.heartbeatManager.updateTpaActivity(ws);
      }
      // Send pong response
      try {
        ws.pong();
      } catch (error) {
        logger.error('[websocket.service]: Error sending pong to TPA:', error);
      }
    });

    ws.on('close', async (code: number, reason: string) => {
      if (currentAppSession) {
        const userSessionId = currentAppSession.split('-')[0];
        const packageName = currentAppSession.split('-')[1];
        const userSession = this.getSessionService().getSession(userSessionId);

        if (!userSession) {
          logger.error(`[websocket.service]: User session not found for ${currentAppSession}`);
          return;
        }

        // Capture detailed disconnect information
        const disconnectInfo = userSession.heartbeatManager.captureDisconnect(ws, code, reason);

        // Clean up the connection 
        if (userSession.appConnections.has(packageName)) {
          userSession.appConnections.delete(packageName);
          subscriptionService.removeSubscriptions(userSession, packageName);
        }

        // Log the disconnection with reason
        userSession.logger.info(
          `[websocket.service]: TPA session ${currentAppSession} disconnected: ` +
          `reason=${disconnectInfo?.reason || 'unknown'}, code=${code}`
        );

        // [IMPROVED APP STATE CONSISTENCY WITH RECONNECTION GRACE PERIOD]
        // Check if the app is still in the active sessions list and handle potential reconnection
        if (userSession.activeAppSessions.includes(packageName)) {
          const wasExplicitStop = disconnectInfo?.reason === 'explicit_stop';

          if (!wasExplicitStop) {
            // Store reconnection timer in a map if it doesn't already exist there
            if (!userSession._reconnectionTimers) {
              userSession._reconnectionTimers = new Map();
            }

            // Clear any existing timer for this package
            if (userSession._reconnectionTimers.has(packageName)) {
              clearTimeout(userSession._reconnectionTimers.get(packageName));
            }

            userSession.logger.info(
              `[websocket.service]: Starting 5-second reconnection grace period for ${packageName}. ` +
              `Disconnect reason: ${disconnectInfo?.reason || 'unknown'}, code: ${code}`
            );

            // Set a 5-second timer before removing from active sessions
            const timerId = setTimeout(async () => {
              // Check if the app is still in active sessions and not reconnected
              if (userSession.activeAppSessions.includes(packageName) &&
                !userSession.appConnections.has(packageName)) {

                userSession.logger.warn(
                  `[websocket.service]: Reconnection grace period expired for ${packageName}. ` +
                  `Removing from active app sessions to prevent zombie app state.`
                );

                // Remove the app from active sessions after grace period
                userSession.activeAppSessions = userSession.activeAppSessions.filter(
                  (appName) => appName !== packageName
                );

                // Try to update database if possible
                try {
                  const user = await User.findByEmail(userSession.userId);
                  if (user) {
                    await user.removeRunningApp(packageName);
                  }
                } catch (dbError) {
                  userSession.logger.error(`Error updating user's running apps:`, dbError);
                }

                // Update the glasses client with new app state to ensure UI correctness
                try {
                  if (userSession.websocket && userSession.websocket.readyState === WebSocket.OPEN) {
                    const appStateChange = await this.generateAppStateStatus(userSession);
                    userSession.websocket.send(JSON.stringify(appStateChange));
                    userSession.logger.info(`Sent updated app state to glasses after grace period for ${packageName}`);
                  }
                } catch (updateError) {
                  userSession.logger.error(`Error updating glasses client app state:`, updateError);
                }

                // Update the display to reflect the app's removal
                try {
                  userSession.displayManager.handleAppStop(packageName, userSession);
                } catch (displayError) {
                  userSession.logger.error(`Error updating display after grace period:`, displayError);
                }

                // Clean up the timer reference
                userSession._reconnectionTimers?.delete(packageName);

                // Auto-restart the app if enabled
                if (AUTO_RESTART_APPS) {
                  userSession.logger.info(
                    `[websocket.service]: Will attempt auto-restart of ${packageName} in ${AUTO_RESTART_DELAY_MS}ms`
                  );

                  // Add a small delay before attempting restart
                  setTimeout(async () => {
                    try {
                      userSession.logger.info(`[websocket.service]: Auto-restarting ${packageName} after disconnect`);
                      await this.startAppSession(userSession, packageName);
                      userSession.logger.info(`[websocket.service]: Successfully auto-restarted ${packageName}`);
                    } catch (restartError) {
                      userSession.logger.error(
                        `[websocket.service]: Failed to auto-restart ${packageName}: ${restartError instanceof Error ? restartError.message : String(restartError)}`
                      );
                    }
                  }, AUTO_RESTART_DELAY_MS);
                }
              } else {
                userSession.logger.info(
                  `[websocket.service]: App ${packageName} reconnected during grace period or was already removed`
                );
                userSession._reconnectionTimers?.delete(packageName);
              }
            }, 5000); // 5 second grace period

            // Store the timer ID for potential cancellation
            userSession._reconnectionTimers.set(packageName, timerId);
          }
        }

        // Clean up dashboard content for the disconnected TPA
        try {
          // Import dashboard service dynamically to avoid circular dependencies
          const dashboardService = require('../dashboard');
          // Pass both the packageName and the userSession
          dashboardService.handleTpaDisconnected(packageName, userSession);
        } catch (error) {
          userSession.logger.error(`Error cleaning up dashboard content for TPA ${packageName}:`, error);
        }
      }
    });

    ws.on('error', async (error) => {
      logger.error('[websocket.service]: TPA WebSocket error:', error);
      if (currentAppSession) {
        const userSessionId = currentAppSession.split('-')[0];
        const packageName = currentAppSession.split('-')[1];
        const userSession = this.getSessionService().getSession(userSessionId);
        if (!userSession) {
          logger.error(`[websocket.service]: User session not found for ${currentAppSession}`);
          return;
        }

        // Unregister from heartbeat manager
        userSession.heartbeatManager.unregisterConnection(ws);

        if (userSession.appConnections.has(packageName)) {
          userSession.appConnections.delete(packageName);
          subscriptionService.removeSubscriptions(userSession, packageName);
        }

        // [IMPROVED APP STATE CONSISTENCY WITH RECONNECTION GRACE PERIOD]
        // Give app a chance to reconnect before removing from active sessions
        if (userSession.activeAppSessions.includes(packageName)) {
          // Initialize reconnection timers map if needed
          if (!userSession._reconnectionTimers) {
            userSession._reconnectionTimers = new Map();
          }

          // Clear any existing timer for this package
          if (userSession._reconnectionTimers.has(packageName)) {
            clearTimeout(userSession._reconnectionTimers.get(packageName));
          }

          userSession.logger.info(
            `[websocket.service]: Starting 5-second reconnection grace period for ${packageName} after error. ` +
            `Error: ${error.message || 'unknown error'}`
          );

          // Set a 5-second timer before removing from active sessions
          const timerId = setTimeout(async () => {
            // Check if the app is still in active sessions and not reconnected
            if (userSession.activeAppSessions.includes(packageName) &&
              !userSession.appConnections.has(packageName)) {

              userSession.logger.warn(
                `[websocket.service]: Reconnection grace period expired for ${packageName} after error. ` +
                `Removing from active app sessions to prevent zombie app state.`
              );

              // Remove the app from active sessions after grace period
              userSession.activeAppSessions = userSession.activeAppSessions.filter(
                (appName) => appName !== packageName
              );

              // Update database
              try {
                const user = await User.findByEmail(userSession.userId);
                if (user) {
                  await user.removeRunningApp(packageName);
                }
              } catch (dbError) {
                userSession.logger.error(`Error updating user's running apps:`, dbError);
              }

              // Update glasses client with new app state
              try {
                if (userSession.websocket && userSession.websocket.readyState === WebSocket.OPEN) {
                  const appStateChange = await this.generateAppStateStatus(userSession);
                  userSession.websocket.send(JSON.stringify(appStateChange));
                  userSession.logger.info(`Sent updated app state to glasses after grace period for ${packageName}`);
                }
              } catch (updateError) {
                userSession.logger.error(`Error updating glasses client app state:`, updateError);
              }

              // Update display
              try {
                userSession.displayManager.handleAppStop(packageName, userSession);
              } catch (displayError) {
                userSession.logger.error(`Error updating display after grace period:`, displayError);
              }

              // Clean up the timer reference
              userSession._reconnectionTimers?.delete(packageName);

              // Auto-restart the app if enabled
              if (AUTO_RESTART_APPS) {
                userSession.logger.info(
                  `[websocket.service]: Will attempt auto-restart of ${packageName} in ${AUTO_RESTART_DELAY_MS}ms`
                );

                // Add a small delay before attempting restart
                setTimeout(async () => {
                  try {
                    userSession.logger.info(`[websocket.service]: Auto-restarting ${packageName} after error`);
                    await this.startAppSession(userSession, packageName);
                    userSession.logger.info(`[websocket.service]: Successfully auto-restarted ${packageName}`);
                  } catch (restartError) {
                    userSession.logger.error(
                      `[websocket.service]: Failed to auto-restart ${packageName}: ${restartError instanceof Error ? restartError.message : String(restartError)}`
                    );
                  }
                }, AUTO_RESTART_DELAY_MS);
              }
            } else {
              userSession.logger.info(
                `[websocket.service]: App ${packageName} reconnected during error grace period or was already removed`
              );
              userSession._reconnectionTimers?.delete(packageName);
            }
          }, 5000); // 5 second grace period

          // Store the timer ID for potential cancellation
          userSession._reconnectionTimers.set(packageName, timerId);
        }

        // Clean up dashboard content for the disconnected TPA
        try {
          // Import dashboard service dynamically to avoid circular dependencies
          const dashboardService = require('../dashboard');
          // Pass both the packageName and the userSession
          dashboardService.handleTpaDisconnected(packageName, userSession);
        } catch (dashboardError) {
          userSession.logger.error(`Error cleaning up dashboard content for TPA ${packageName}:`, dashboardError);
        }

        userSession.logger.error(`[websocket.service]: TPA session ${currentAppSession} disconnected due to error: ${error.message || 'unknown error'}`);
      }
      ws.close();
    });
  }

  /**
   * 🤝 Handles TPA connection initialization.
   * @param ws - WebSocket connection
   * @param initMessage - Connection initialization message
   * @param setCurrentSessionId - Function to set the current TPA session ID
   * @private
   */
  private async handleTpaInit(
    ws: WebSocket,
    initMessage: TpaConnectionInit,
    setCurrentSessionId: (sessionId: string) => void
  ): Promise<void> {
    const userSessionId = initMessage.sessionId.split('-')[0];
    const userSession = this.getSessionService().getSession(userSessionId);

    if (!userSession) {
      logger.error(`[websocket.service] User session not found for ${userSessionId}`);
      ws.close(1008, 'No active session');
      return;
    }

    // Get client IP address for system app validation
    const clientIp = (ws as any)._socket?.remoteAddress || '';
    userSession.logger.info(`[websocket.service] TPA connection from IP: ${clientIp}`);

    // Validate API key with IP check for system apps
    const isValidKey = await appService.validateApiKey(
      initMessage.packageName,
      initMessage.apiKey,
      clientIp
    );

    if (!isValidKey) {
      userSession.logger.error(`[websocket.service] Invalid API key for package: ${initMessage.packageName}`);
      ws.close(1008, 'Invalid API key');
      return;
    }


    // Check if this is a system app
    const isSystemApp = Object.values(systemApps).some(
      app => app.packageName === initMessage.packageName
    );

    // For regular apps, check if they're in the loading apps list or already active
    const isLoading = userSession.loadingApps.has(initMessage.packageName);
    const isActive = userSession.activeAppSessions.includes(initMessage.packageName);

    if (!isSystemApp && !isLoading && !isActive) {
      userSession.logger.warn(`[websocket.service] TPA not in loading or active state: ${initMessage.packageName}`);
      // In production, we would reject TPAs that aren't properly initialized
      // ws.close(1008, 'TPA not initialized properly');
      // return;
    }

    // Store the connection
    userSession.appConnections.set(initMessage.packageName, ws);
    setCurrentSessionId(initMessage.sessionId);

    // Register the connection with the heartbeat manager
    userSession.heartbeatManager.registerTpaConnection(ws, initMessage.packageName);

    // Check if there's a pending reconnection timer and clear it
    if (userSession._reconnectionTimers && userSession._reconnectionTimers.has(initMessage.packageName)) {
      userSession.logger.info(
        `[websocket.service]: Clearing reconnection timer for ${initMessage.packageName} - app successfully reconnected`
      );
      clearTimeout(userSession._reconnectionTimers.get(initMessage.packageName));
      userSession._reconnectionTimers.delete(initMessage.packageName);
    }

    // If the app was in loading state, move it to active
    if (isLoading) {
      userSession.loadingApps.delete(initMessage.packageName);
      if (!userSession.activeAppSessions.includes(initMessage.packageName)) {
        userSession.activeAppSessions.push(initMessage.packageName);
      }
    }

    // Get user settings for this TPA
    let userSettings = [];
    try {
      const user = await User.findOrCreateUser(userSession.userId);
      userSettings = user.getAppSettings(initMessage.packageName) || [];

      // If no settings found, try to fetch and create default settings
      if (!userSettings || userSettings.length === 0) {
        try {
          // Try to fetch TPA config to get default settings
          const app = await appService.getApp(initMessage.packageName);
          if (app && app.publicUrl) {
            const tpaConfigResponse = await axios.get(`${app.publicUrl}/tpa_config.json`);
            const tpaConfig = tpaConfigResponse.data;

            if (tpaConfig && tpaConfig.settings) {
              const defaultSettings = tpaConfig.settings
                .filter((setting: any) => setting.type !== 'group')
                .map((setting: any) => ({
                  key: setting.key,
                  value: setting.defaultValue,
                  defaultValue: setting.defaultValue,
                  type: setting.type,
                  label: setting.label,
                  options: setting.options || []
                }));

              await user.updateAppSettings(initMessage.packageName, defaultSettings);
              userSettings = defaultSettings;
              userSession.logger.info(`Created default settings for ${initMessage.packageName}`);
            }
          }
        } catch (error) {
          userSession.logger.error(`Error fetching TPA config for default settings: ${error}`);
        }
      }
    } catch (error) {
      userSession.logger.error(`Error retrieving settings for ${initMessage.packageName}: ${error}`);
    }

    // Send acknowledgment with settings
    const ackMessage: TpaConnectionAck = {
      type: CloudToTpaMessageType.CONNECTION_ACK,
      sessionId: initMessage.sessionId,
      settings: userSettings, // Include user settings in the response
      timestamp: new Date()
    };
    ws.send(JSON.stringify(ackMessage));
    userSession.logger.info(`TPA ${initMessage.packageName} connected for session ${initMessage.sessionId}`);

    // If this is the dashboard app, send the current location if it's cached
    try {
      const user = await User.findByEmail(userSession.userId);
      if (user && initMessage.packageName === systemApps.dashboard.packageName) {
        const location = user.location;
        if (location) {
          const locationUpdate: LocationUpdate = {
            type: GlassesToCloudMessageType.LOCATION_UPDATE,
            sessionId: userSessionId,
            lat: location.lat,
            lng: location.lng,
            timestamp: new Date()
          };
          this.broadcastToTpa(userSessionId, StreamType.LOCATION_UPDATE, locationUpdate);
        }
      }

      // Send cached location to any app that subscribes to location updates
      if (subscriptionService.hasSubscription(userSessionId, initMessage.packageName, StreamType.LOCATION_UPDATE)) {
        const lastLocation = subscriptionService.getLastLocation(userSessionId);
        if (lastLocation) {
          userSession.logger.info(`Sending cached location to app ${initMessage.packageName} on connect`);
          const locationUpdate: LocationUpdate = {
            type: GlassesToCloudMessageType.LOCATION_UPDATE,
            sessionId: initMessage.sessionId,
            lat: lastLocation.latitude,
            lng: lastLocation.longitude,
            timestamp: new Date()
          };

          const dataStream: DataStream = {
            type: CloudToTpaMessageType.DATA_STREAM,
            sessionId: initMessage.sessionId,
            streamType: StreamType.LOCATION_UPDATE,
            data: locationUpdate,
            timestamp: new Date()
          };
          ws.send(JSON.stringify(dataStream));
        }
      }
    } catch (error) {
      userSession.logger.error(`[websocket.service] Error sending location to dashboard:`, error);
    }
  }

  /**
   * 😬 Sends an error message to a WebSocket client.
   * @param ws - WebSocket connection
   * @param errorDetails - Object containing the error type and message
   * @private
   */
  private sendError(ws: WebSocket, errorDetails: { type: CloudToGlassesMessageType | CloudToTpaMessageType; message: string }): void {
    const errorMessageToSend = {
      type: errorDetails.type,
      message: errorDetails.message,
      timestamp: new Date()
    };
    ws.send(JSON.stringify(errorMessageToSend));
  }
}

export const webSocketService = WebSocketService.getInstance();
export default webSocketService;
