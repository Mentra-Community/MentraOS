/**
 * @fileoverview AppManager manages app lifecycle and TPA connections within a user session.
 * It encapsulates all app-related functionality that was previously
 * scattered throughout the session and WebSocket services.
 * 
 * This follows the pattern used by other managers like MicrophoneManager and DisplayManager.
 */

import WebSocket from 'ws';
import {
  CloudToTpaMessageType,
  CloudToGlassesMessageType,
  TpaConnectionInit,
  AppStateChange,
  AppI,
  WebhookRequestType,
  SessionWebhookRequest
} from '@augmentos/sdk';
import { Logger } from 'pino';
import subscriptionService from './subscription.service';
import appService from '../core/app.service';
import * as developerService from '../core/developer.service';
import { PosthogService } from '../logging/posthog.service';
import UserSession, { LOG_PING_PONG } from './UserSession';
import { User } from '../../models/user.model';
import { logger as rootLogger } from '../logging/pino-logger';
import sessionService from './session.service';
import { locationService } from '../core/location.service';
import axios, { AxiosError } from 'axios';
const logger = rootLogger.child({ service: 'AppManager' });

const CLOUD_PUBLIC_HOST_NAME = process.env.CLOUD_PUBLIC_HOST_NAME; // e.g., "prod.augmentos.cloud"
const CLOUD_LOCAL_HOST_NAME = process.env.CLOUD_LOCAL_HOST_NAME; // e.g., "localhost:8002" | "cloud" | "cloud-debug-cloud.default.svc.cluster.local:80"
const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET;

const TPA_SESSION_TIMEOUT_MS = 5000;  // 5 seconds

/**
 * Enum for tracking TPA connection states
 */
enum AppConnectionState {
  RUNNING = 'running',           // Active WebSocket connection
  GRACE_PERIOD = 'grace_period', // Waiting for natural reconnection (5s)
  RESURRECTING = 'resurrecting', // System actively restarting app
  STOPPING = 'stopping',         // User/system initiated stop in progress
  DISCONNECTED = 'disconnected'  // Available for resurrection
}

if (!CLOUD_PUBLIC_HOST_NAME) {
  logger.error("CLOUD_PUBLIC_HOST_NAME is not set. Please set it in your environment variables.");
}

if (!CLOUD_LOCAL_HOST_NAME) {
  logger.error("CLOUD_LOCAL_HOST_NAME is not set. Please set it in your environment variables.");
}

if (!AUGMENTOS_AUTH_JWT_SECRET) {
  logger.error("AUGMENTOS_AUTH_JWT_SECRET is not set. Please set it in your environment variables.");
}


/**
 * Manages app lifecycle and TPA connections for a user session
 */
interface AppStartResult {
  success: boolean;
  error?: {
    stage: 'WEBHOOK' | 'CONNECTION' | 'AUTHENTICATION' | 'TIMEOUT';
    message: string;
    details?: any;
  };
}

interface PendingConnection {
  packageName: string;
  resolve: (result: AppStartResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  startTime: number;
}

interface TpaMessageResult {
  sent: boolean;
  resurrectionTriggered: boolean;
  error?: string;
}

export class AppManager {
  private userSession: UserSession;
  private logger: Logger;

  // Track pending app start operations
  private pendingConnections = new Map<string, PendingConnection>();

  // Track connection states for TPAs
  private connectionStates = new Map<string, AppConnectionState>();

  // Track heartbeat intervals for TPA connections
  private heartbeatIntervals = new Map<string, NodeJS.Timeout>();

  // Cache of installed apps
  // private installedApps: AppI[] = [];

  constructor(userSession: UserSession) {
    this.userSession = userSession;
    this.logger = userSession.logger.child({ service: 'AppManager' });
    this.logger.info('AppManager initialized');
  }

  /**
   * Set up heartbeat for TPA WebSocket connection
   */
  private setupTpaHeartbeat(packageName: string, ws: WebSocket): void {
    const HEARTBEAT_INTERVAL = 10000; // 10 seconds

    // Clear any existing heartbeat for this package
    this.clearTpaHeartbeat(packageName);

    // Set up new heartbeat
    const heartbeatInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
        if (LOG_PING_PONG) {
          // Log ping if enabled
          this.logger.debug({ packageName, ping: true }, `[AppManager:heartbeat:ping] Sent ping to TPA ${packageName}`);
        }
      } else {
        // WebSocket is not open, clear the interval
        this.logger.warn({ packageName }, `[WARNING][AppManager:heartbeat] WebSocket for TPA ${packageName} is not open, clearing heartbeat`);
        this.clearTpaHeartbeat(packageName);
      }
    }, HEARTBEAT_INTERVAL);

    // Store the interval for cleanup
    this.heartbeatIntervals.set(packageName, heartbeatInterval);

    // Set up pong handler
    ws.on('pong', () => {
      if (LOG_PING_PONG) {
        // Log pong if enabled
        this.logger.debug({ packageName, pong: true }, `[AppManager:heartbeat:pong] Received pong from TPA ${packageName}`);
      }
    });

    this.logger.debug({ packageName, HEARTBEAT_INTERVAL }, `[AppManager:setupTpaHeartbeat] Heartbeat established for TPA ${packageName}`);
  }

  /**
   * Clear heartbeat for TPA connection
   */
  private clearTpaHeartbeat(packageName: string): void {
    const existingInterval = this.heartbeatIntervals.get(packageName);
    if (existingInterval) {
      clearInterval(existingInterval);
      this.heartbeatIntervals.delete(packageName);
      this.logger.debug({ packageName }, `[AppManager:clearTpaHeartbeat] Heartbeat cleared for TPA ${packageName}`);
    }
  }

  /**
   * Helper methods for connection state management
   */
  private setAppConnectionState(packageName: string, state: AppConnectionState): void {
    this.connectionStates.set(packageName, state);
    this.logger.debug({ packageName, state }, `App connection state changed: ${packageName} -> ${state}`);
  }

  private getAppConnectionState(packageName: string): AppConnectionState | undefined {
    return this.connectionStates.get(packageName);
  }

  private removeAppConnectionState(packageName: string): void {
    this.connectionStates.delete(packageName);
    this.logger.debug({ packageName }, `App connection state removed: ${packageName}`);
  }

  /**
   * 🚀🪝 Initiates a new TPA session and triggers the TPA's webhook.
   * Waits for TPA to connect and complete authentication before resolving.
   * @param packageName - TPA identifier
   * @returns Promise that resolves when TPA successfully connects and authenticates
   */
  async startApp(packageName: string): Promise<AppStartResult> {
    // Check if already running
    if (this.userSession.runningApps.has(packageName)) {
      this.logger.info({ userId: this.userSession.userId, packageName, service: 'AppManager' },
        `App ${packageName} already running`);
      return { success: true };
    }

    // TODO(isaiah): instead of polling, we can optionally store list of other promises, or maybe just fail gracefully.
    // Check if already loading - return existing pending promise
    if (this.userSession.loadingApps.has(packageName)) {
      const existing = this.pendingConnections.get(packageName);
      if (existing) {
        this.logger.info({ userId: this.userSession.userId, packageName, service: 'AppManager' },
          `App ${packageName} already loading, waiting for existing attempt`);

        // Create a new promise that waits for the existing attempt to complete
        return new Promise<AppStartResult>((resolve) => {
          // Set up a listener for when the existing attempt completes
          const checkCompletion = () => {
            if (!this.pendingConnections.has(packageName)) {
              // Existing attempt completed, check final state
              if (this.userSession.runningApps.has(packageName)) {
                resolve({ success: true });
              } else {
                resolve({
                  success: false,
                  error: { stage: 'CONNECTION', message: 'Existing connection attempt failed' }
                });
              }
            } else {
              // Still pending, check again in 100ms
              setTimeout(checkCompletion, 100);
            }
          };

          checkCompletion();
        });
      }
    }

    // TODO(isaiah): Test if we can use the installedApps cache instead of fetching from DB
    const app = await appService.getApp(packageName);
    if (!app) {
      this.logger.error({ userId: this.userSession.userId, packageName, service: 'AppManager' },
        `App ${packageName} not found`);
      return {
        success: false,
        error: { stage: 'WEBHOOK', message: `App ${packageName} not found` }
      };
    }

    // Create Promise for tracking this connection attempt
    return new Promise<AppStartResult>((resolve, reject) => {
      const startTime = Date.now();

      // Set up timeout
      const timeout = setTimeout(async () => {
        this.logger.error({
          userId: this.userSession.userId,
          packageName,
          service: 'AppManager',
          duration: Date.now() - startTime
        }, `App ${packageName} connection timeout after ${TPA_SESSION_TIMEOUT_MS}ms`);

        // Check if connection is still pending (race condition protection)
        if (!this.pendingConnections.has(packageName)) {
          // Connection already succeeded, don't clean up
          this.logger.debug({ packageName }, `Timeout fired but connection already succeeded, skipping cleanup`);
          return;
        }

        // Safe to clean up - connection truly timed out
        this.pendingConnections.delete(packageName);
        this.userSession.loadingApps.delete(packageName);

        // Reset connection state to prevent apps from being stuck in RESURRECTING
        this.setAppConnectionState(packageName, AppConnectionState.DISCONNECTED);
        // remove from user.runningApps.
        try {
          // TODO(isaiah): See if we can speed this up by using the cached user in UserSession instead of fetching from DB.
          const user = await User.findByEmail(this.userSession.userId);
          if (user) {
            this.logger.info({ userId: this.userSession.userId, packageName, service: 'AppManager' },
              `Removing app ${packageName} from user's running apps due to timeout`);
            user.removeRunningApp(packageName).catch(err => {
              this.logger.error({ error: err }, `Error removing app ${packageName} from user's running apps`);
            });
          }
        } catch (error) {
          this.logger.error({ error }, `Error finding user ${this.userSession.userId} to remove running app ${packageName}`);
        }

        resolve({
          success: false,
          error: { stage: 'TIMEOUT', message: `Connection timeout after ${TPA_SESSION_TIMEOUT_MS}ms` }
        });
      }, TPA_SESSION_TIMEOUT_MS);

      // Store pending connection
      this.pendingConnections.set(packageName, {
        packageName,
        resolve,
        reject,
        timeout,
        startTime
      });

      this.logger.info({ userId: this.userSession.userId, packageName, service: 'AppManager' },
        `⚡️ Starting app ${packageName} - creating pending connection`);
      this.userSession.loadingApps.add(packageName);

      // Set connection state to RESURRECTING
      this.setAppConnectionState(packageName, AppConnectionState.RESURRECTING);

      // Continue with webhook trigger
      this.triggerAppWebhookInternal(app, resolve, reject, startTime);
    });
  }

  /**
   * Internal method to handle webhook triggering and error handling
   */
  private async triggerAppWebhookInternal(
    app: AppI,
    resolve: (result: AppStartResult) => void,
    reject: (error: Error) => void,
    startTime: number
  ): Promise<void> {
    try {
      // Trigger TPA webhook 
      const { packageName, name, publicUrl } = app;
      this.logger.debug({ packageName, name, publicUrl }, `Triggering TPA webhook for ${packageName} for user ${this.userSession.userId}`);

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
            this.logger.info(`Using Porter internal URL for system app ${packageName}`);
          } else {
            // Docker Compose environment
            augmentOSWebsocketUrl = 'ws://cloud/tpa-ws';
            this.logger.info(`Using Docker internal URL for system app ${packageName}`);
          }
        } else {
          // Local development for system apps
          augmentOSWebsocketUrl = 'ws://localhost:8002/tpa-ws';
          this.logger.info(`Using local URL for system app ${packageName}`);
        }
      } else {
        // For non-system apps, use the public host
        augmentOSWebsocketUrl = `wss://${CLOUD_PUBLIC_HOST_NAME}/tpa-ws`;
        this.logger.info({ augmentOSWebsocketUrl, packageName, name }, `Using public URL for app ${packageName}`);
      }

      this.logger.info(`Server WebSocket URL: ${augmentOSWebsocketUrl}`);
      // Construct the webhook URL from the app's public URL
      const webhookURL = `${app.publicUrl}/webhook`;
      this.logger.info({ userId: this.userSession.userId, packageName, service: 'AppManager' },
        `Triggering webhook for ${packageName}: ${webhookURL}`);

      // Trigger boot screen.
      this.userSession.displayManager.handleAppStart(app.packageName);

      await this.triggerWebhook(webhookURL, {
        type: WebhookRequestType.SESSION_REQUEST,
        sessionId: this.userSession.userId + '-' + packageName,
        userId: this.userSession.userId,
        timestamp: new Date().toISOString(),
        augmentOSWebsocketUrl,
      });


      this.logger.info({
        userId: this.userSession.userId,
        packageName,
        service: 'AppManager',
        duration: Date.now() - startTime
      }, `Webhook sent successfully for app ${packageName}, waiting for TPA connection`);

      // Note: Database will be updated when TPA actually connects in handleTpaInit()
      // Note: App start message to glasses will be sent when TPA connects

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error({
        userId: this.userSession.userId,
        packageName: app.packageName,
        service: 'AppManager',
        error: errorMessage,
        duration: Date.now() - startTime
      }, `Error triggering webhook for app ${app.packageName}`);

      // Clean up pending connection
      const pending = this.pendingConnections.get(app.packageName);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingConnections.delete(app.packageName);
      }

      this.userSession.loadingApps.delete(app.packageName);
      this.userSession.displayManager.handleAppStop(app.packageName);

      // Reset connection state to prevent apps from being stuck in RESURRECTING
      this.setAppConnectionState(app.packageName, AppConnectionState.DISCONNECTED);

      // Resolve with error instead of throwing
      resolve({
        success: false,
        error: {
          stage: 'WEBHOOK',
          message: `Webhook failed: ${errorMessage}`,
          details: error
        }
      });
    }
  }

  /**
   * Helper method to resolve pending connections with errors
   */
  private resolvePendingConnectionWithError(
    packageName: string,
    stage: 'WEBHOOK' | 'CONNECTION' | 'AUTHENTICATION' | 'TIMEOUT',
    message: string
  ): void {
    const pending = this.pendingConnections.get(packageName);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingConnections.delete(packageName);

      const duration = Date.now() - pending.startTime;
      this.logger.error({
        userId: this.userSession.userId,
        packageName,
        service: 'AppManager',
        duration,
        stage
      }, `TPA ${packageName} connection failed at ${stage} stage after ${duration}ms: ${message}`);

      pending.resolve({
        success: false,
        error: { stage, message }
      });
    }
  }

  /**
   * Triggers a webhook for a TPA.
   * @param url - Webhook URL
   * @param payload - Data to send
   * @throws If webhook fails after retries
   */
  private async triggerWebhook(url: string, payload: SessionWebhookRequest): Promise<void> {
    const maxRetries = 2;
    const baseDelay = 1000; // 1 second

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await axios.post(url, payload, {
          headers: {
            'Content-Type': 'application/json',
          },
          timeout: 10000 // Increase timeout to 10 seconds
        });
        return;
      } catch (error: unknown) {
        if (attempt === maxRetries - 1) {
          if (axios.isAxiosError(error)) {
            // Enrich the error with context for better debugging
            const enrichedError = Object.assign(error, {
              packageName: payload.sessionId.split('-')[1],
              webhookUrl: url,
              attempts: maxRetries,
              timeout: 10000,
              operation: 'triggerWebhook',
              userId: payload.userId,
              payloadType: payload.type
            });
            this.logger.error(enrichedError, `Webhook failed after ${maxRetries} attempts`);
          }
          throw new Error(`Webhook failed after ${maxRetries} attempts: ${(error as AxiosError).message || 'Unknown error'}`);
        }
        // Exponential backoff
        await new Promise(resolve =>
          setTimeout(resolve, baseDelay * Math.pow(2, attempt))
        );
      }
    }
  }

  /**
   * Stop an app by package name
   * 
   * @param packageName Package name of the app to stop
   */
  async stopApp(packageName: string, restart?: boolean): Promise<void> {
    try {
      if (
        !this.userSession.runningApps.has(packageName)
        && !this.userSession.loadingApps.has(packageName)
        && !restart // If restarting, we allow stopping even if not running
      ) {
        this.logger.info(`App ${packageName} not running, ignoring stop request`);
        return;
      }

      this.logger.info(`Stopping app ${packageName}`);

      // Set to STOPPING state before closing WebSocket
      this.setAppConnectionState(packageName, restart ? AppConnectionState.RESURRECTING : AppConnectionState.STOPPING);

      // Remove from active app sessions
      this.userSession.runningApps.delete(packageName);

      // Remove from loading apps if present
      this.userSession.loadingApps.delete(packageName);

      // Trigger app stop webhook
      try {
        // TODO(isaiah): Move logic to stop app out of appService and into this class.
        await appService.triggerStopByPackageName(packageName, this.userSession.userId);
      } catch (webhookError) {
        this.logger.error(`Error triggering stop webhook for ${packageName}:`, webhookError);
      }

      // Remove subscriptions.
      try {
        subscriptionService.removeSubscriptions(this.userSession, packageName);
      } catch (error) {
        this.logger.error(`Error removing subscriptions for ${packageName}:`, error);
      }

      // Broadcast app state change
      await this.broadcastAppState();

      // Close WebSocket connection if exists
      const appWebsocket = this.userSession.appWebsockets.get(packageName);
      if (appWebsocket && appWebsocket.readyState === WebSocket.OPEN) {
        try {
          // Send app stopped message
          const message = {
            type: CloudToTpaMessageType.APP_STOPPED,
            timestamp: new Date()
          };
          appWebsocket.send(JSON.stringify(message));

          // Close the connection
          appWebsocket.close(1000, 'App stopped');
        } catch (error) {
          this.logger.error({ error }, `Error closing connection for ${packageName}`);
        }
      }

      // Update user's running apps in database
      try {
        const user = await User.findByEmail(this.userSession.userId);
        if (user) {
          await user.removeRunningApp(packageName);
        }
      } catch (error) {
        this.userSession.logger.error({ error }, `Error updating user's running apps`);
      }

      // Remove from app connections
      this.userSession.appWebsockets.delete(packageName);

      // Clean up display state for stopped app
      this.userSession.displayManager.handleAppStop(packageName);

    } catch (error) {
      this.logger.error(`Error stopping app ${packageName}:`, error);
    }
  }

  /**
   * Check if an app is currently running
   * 
   * @param packageName Package name to check
   * @returns Whether the app is running
   */
  isAppRunning(packageName: string): boolean {
    return this.userSession.runningApps.has(packageName);
  }

  /**
   * Handle TPA initialization
   * 
   * @param ws WebSocket connection
   * @param initMessage TPA initialization message
   */
  async handleTpaInit(ws: WebSocket, initMessage: TpaConnectionInit): Promise<void> {
    try {
      const { packageName, apiKey, sessionId } = initMessage;

      // Validate the API key
      const isValidApiKey = await developerService.validateApiKey(packageName, apiKey, this.userSession);

      if (!isValidApiKey) {
        this.logger.error({ userId: this.userSession.userId, packageName, service: 'AppManager' },
          `Invalid API key for TPA ${packageName}`);

        // Resolve pending connection with auth error
        this.resolvePendingConnectionWithError(packageName, 'AUTHENTICATION', 'Invalid API key');

        try {
          ws.send(JSON.stringify({
            type: CloudToTpaMessageType.CONNECTION_ERROR,
            code: 'INVALID_API_KEY',
            message: 'Invalid API key',
            timestamp: new Date()
          }));

          ws.close(1008, 'Invalid API key');
        } catch (sendError) {
          this.logger.error(`Error sending auth error to TPA ${packageName}:`, sendError);
        }

        return;
      }

      // Check if app is in loading state
      if (!this.userSession.loadingApps.has(packageName) && !this.userSession.runningApps.has(packageName)) {
        this.logger.error({ userId: this.userSession.userId, packageName, service: 'AppManager' },
          `App ${packageName} not in loading or active state for session ${this.userSession.userId}`);

        // Resolve pending connection with connection error
        this.resolvePendingConnectionWithError(packageName, 'CONNECTION', 'App not started for this session');

        try {
          ws.send(JSON.stringify({
            type: CloudToTpaMessageType.CONNECTION_ERROR,
            code: 'APP_NOT_STARTED',
            message: 'App not started for this session',
            timestamp: new Date()
          }));
        } catch (sendError) {
          this.logger.error(`Error sending app not started error to TPA ${packageName}:`, sendError);
        }
        ws.close(1008, 'App not started for this session');
        return;
      }

      // Store the WebSocket connection
      this.userSession.appWebsockets.set(packageName, ws);

      // Set up close event handler for proper grace period handling
      ws.on('close', (code: number, reason: Buffer) => {
        this.handleAppConnectionClosed(packageName, code, reason.toString());
      });

      // Set up heartbeat to prevent proxy timeouts
      this.setupTpaHeartbeat(packageName, ws);

      // Set connection state to RUNNING
      this.setAppConnectionState(packageName, AppConnectionState.RUNNING);

      // Add to active app sessions if not already present
      this.userSession.runningApps.add(packageName);

      // Remove from loading apps if present. // TODO(isaiah): make sure this is the right place to do this.
      this.userSession.loadingApps.delete(packageName);

      // Get app settings with proper fallback hierarchy
      const app = this.userSession.installedApps.get(packageName);

      // Get user's settings with fallback to app defaults
      const user = await User.findOrCreateUser(this.userSession.userId);
      const userSettings = user.getAppSettings(packageName) || app?.settings || [];

      // Send connection acknowledgment
      const ackMessage = {
        type: CloudToTpaMessageType.CONNECTION_ACK,
        sessionId: sessionId,
        settings: userSettings,
        timestamp: new Date()
      };

      ws.send(JSON.stringify(ackMessage));

      // update user.runningApps in database.
      try {
        if (user) {
          await user.addRunningApp(packageName);
        }
      } catch (error) {
        this.logger.error(error, `Error updating user's running apps for ${this.userSession.userId} for app ${packageName}`);
        this.logger.debug({ packageName, userId: this.userSession.userId }, `Failed to update user's running apps for ${this.userSession.userId}`);
      }

      // Resolve pending connection if it exists
      const pending = this.pendingConnections.get(packageName);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingConnections.delete(packageName);

        const duration = Date.now() - pending.startTime;
        this.logger.info({
          userId: this.userSession.userId,
          packageName,
          sessionId: this.userSession.sessionId,
          service: 'AppManager',
          duration
        }, `TPA ${packageName} successfully connected and authenticated in ${duration}ms`);

        this.setAppConnectionState(packageName, AppConnectionState.RUNNING);
        pending.resolve({ success: true });
      } else {
        // Log for existing connection (not from startApp)
        this.logger.info({
          userId: this.userSession.userId,
          packageName,
          sessionId: this.userSession.sessionId,
          service: 'AppManager'
        }, `TPA ${packageName} connected (not from startApp) - moved to runningApps`);
      }

      // Track connection in analytics
      PosthogService.trackEvent('tpa_connection', this.userSession.userId, {
        packageName,
        sessionId: this.userSession.sessionId,
        timestamp: new Date().toISOString()
      });

      // Broadcast app state change
      await this.broadcastAppState();

      // Hook into our new location service
      await locationService.onAppStarted(this.userSession.userId, packageName);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error({
        userId: this.userSession.userId,
        packageName: initMessage.packageName,
        service: 'AppManager',
        error: errorMessage
      }, `Error handling TPA init for ${initMessage.packageName}`);

      // Resolve pending connection with general error
      this.resolvePendingConnectionWithError(initMessage.packageName, 'CONNECTION', `Internal error: ${errorMessage}`);

      try {
        ws.send(JSON.stringify({
          type: CloudToTpaMessageType.CONNECTION_ERROR,
          code: 'INTERNAL_ERROR',
          message: 'Internal server error',
          timestamp: new Date()
        }));

        ws.close(1011, 'Internal server error');
      } catch (sendError) {
        this.logger.error(`Error sending internal error to TPA:`, sendError);
      }
    }
  }

  /**
   * Broadcast app state to connected clients
   */
  async broadcastAppState(): Promise<AppStateChange | null> {
    this.logger.debug({ function: "broadcastAppState" }, `Broadcasting app state for user ${this.userSession.userId}`);
    try {
      // Refresh installed apps
      await this.refreshInstalledApps();

      // Transform session for client
      const clientSessionData = await sessionService.transformUserSessionForClient(this.userSession);
      this.logger.debug({ clientSessionData }, `Transformed user session data for ${this.userSession.userId}`);
      // Create app state change message
      const appStateChange: AppStateChange = {
        type: CloudToGlassesMessageType.APP_STATE_CHANGE,
        sessionId: this.userSession.sessionId,
        userSession: clientSessionData,
        timestamp: new Date()
      };

      // Send to client
      if (!this.userSession.websocket || this.userSession.websocket.readyState !== WebSocket.OPEN) {
        this.logger.warn(`WebSocket is not open for client app state change`);
        return appStateChange;
      }

      this.userSession.websocket.send(JSON.stringify(appStateChange));
      this.logger.debug({ appStateChange }, `Sent APP_STATE_CHANGE to ${this.userSession.userId}`);
      return appStateChange;
    } catch (error) {
      this.logger.error(error , `Error broadcasting app state for ${this.userSession.userId}`);
      return null;
    }
  }

  /**
   * Refresh the installed apps list
   */
  async refreshInstalledApps(): Promise<void> {
    try {
      // Fetch installed apps
      const installedAppsList = await appService.getAllApps(this.userSession.userId);
      const installedApps = new Map<string, AppI>();
      for (const app of installedAppsList) {
        installedApps.set(app.packageName, app);
      }
      this.logger.info({ installedAppsList: installedAppsList.map((app) => app.packageName) }, `Fetched ${installedApps.size} installed apps for ${this.userSession.userId}`);

      // Update session's installed apps
      this.userSession.installedApps = installedApps;

      this.logger.info(`Updated installed apps for ${this.userSession.userId}`);
    } catch (error) {
      this.logger.error(`Error refreshing installed apps:`, error);
    }
  }

  /**
   * Start all previously running apps
   */
  async startPreviouslyRunningApps(): Promise<void> {
    const logger = this.logger.child({ function: 'startPreviouslyRunningApps' });
    logger.debug(`Starting previously running apps for user ${this.userSession.userId}`);
    try {
      // Fetch previously running apps from database
      const user = await User.findOrCreateUser(this.userSession.userId);
      const previouslyRunningApps = user.runningApps;

      if (previouslyRunningApps.length === 0) {
        logger.debug(`No previously running apps for ${this.userSession.userId}`);
        return;
      }

      logger.debug(`Starting ${previouslyRunningApps.length} previously running apps for ${this.userSession.userId}`);

      // Start each app
      // Use Promise.all to start all apps concurrently
      const startedApps: string[] = [];

      await Promise.all(previouslyRunningApps.map(async (packageName) => {
        try {
          const appStartResult: AppStartResult = await this.startApp(packageName);
          if (!appStartResult.success) {
            logger.warn({ packageName, userId: this.userSession.userId }, `Failed to start previously running app ${packageName}: ${appStartResult.error?.message}`);
            return; // Skip to next app
          }
          startedApps.push(packageName);
        }
        catch (error) {
          logger.error(`Error starting previously running app ${packageName}:`, error);
          // Continue with other apps
        }
      }));
      logger.info({ previouslyRunningApps, startedApps }, `Started ${startedApps.length}/${previouslyRunningApps.length} previously running apps for ${this.userSession.userId}`);

    } catch (error) {
      logger.error(`Error starting previously running apps:`, error);
    }
  }

  /**
   * Handle app connection close
   * 
   * @param packageName Package name
   * @param code Close code
   * @param reason Close reason
   */
  async handleAppConnectionClosed(packageName: string, code: number, reason: string): Promise<void> {
    try {
      this.logger.info({ packageName, code, reason }, `[AppManager:handleAppConnectionClosed]: (${packageName}, ${code}, ${reason})`);

      // Hook into our new location service
      await locationService.onAppStopped(this.userSession.userId, packageName);

      // Remove from app connections
      this.userSession.appWebsockets.delete(packageName);

      // Clear heartbeat for this TPA connection
      this.clearTpaHeartbeat(packageName);

      // Check current connection state
      const currentState = this.getAppConnectionState(packageName);

      if (currentState === AppConnectionState.STOPPING) {
        this.logger.debug({ packageName }, `[AppManager:handleAppConnectionClosed]: (currentState === AppConnectionState.STOPPING) - App ${packageName} stopped as expected, removing from tracking`);
        return;
      }

      // Check for normal close codes (intentional shutdown)
      if (code === 1000 || code === 1001) {
        this.logger.debug({ packageName, code }, `[AppManager:handleAppConnectionClosed]: (code === 1000 || code === 1001) - App ${packageName} closed normally`);

        // Let's call stopApp to remove the app from runningApps and loadingApps.
        await this.stopApp(packageName, false);
        this.logger.debug(`App ${packageName} stopped cleanly after normal close`);
        return;
      }

      // Unexpected close - start grace period
      this.logger.warn(`App ${packageName} unexpectedly disconnected (code: ${code}) (reason: ${reason}), starting grace period`);
      this.setAppConnectionState(packageName, AppConnectionState.GRACE_PERIOD);

      // Clear any existing timer
      const existingTimer = this.userSession._reconnectionTimers.get(packageName);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      // Set new timer for grace period
      const reconnectionTimer = setTimeout(async () => {
        this.logger.warn(`Reconnection Grace period expired for ${packageName}, checking connection state`);

        // If not reconnected, move to disconnected state and attempt resurrection.
        if (!this.userSession.appWebsockets.has(packageName)) {
          this.logger.debug(`App ${packageName} not reconnected, moving to DISCONNECTED state`);
          // Let's let stopApp remove the app from runningApps and loadingApps.
          // this.userSession.runningApps.delete(packageName);
          // this.userSession.loadingApps.delete(packageName);
          this.setAppConnectionState(packageName, AppConnectionState.RESURRECTING);

          // Broadcast app state change
          try {
            // Try to resurrect the app.
            await this.stopApp(packageName, true);
            await this.startApp(packageName);
            // this.broadcastAppState(); // should already be called from both stopApp and startApp.
          }
          catch (error) {
            this.logger.error({
              userId: this.userSession.userId,
              packageName,
              service: 'AppManager',
              error: error instanceof Error ? error.message : String(error)
            }, `Error starting resurrection for TPA ${packageName}`);
          }

        }

        // Remove the timer from the map
        this.userSession._reconnectionTimers?.delete(packageName);
      }, 5000); // 5 second reconnection grace period for TPAs

      // Store the timer
      this.userSession._reconnectionTimers.set(packageName, reconnectionTimer);

    } catch (error) {
      this.logger.error(error, `Error handling app connection close for ${packageName}:`);
    }
  }

  /**
   * Send a message to a TPA with automatic resurrection if connection is dead
   * @param packageName - TPA package name
   * @param message - Message to send (will be JSON.stringify'd)
   * @returns Promise with send result and resurrection info
   */
  async sendMessageToTpa(packageName: string, message: any): Promise<TpaMessageResult> {
    try {
      // Check connection state first
      const appState = this.getAppConnectionState(packageName);

      if (appState === AppConnectionState.STOPPING) {
        return { sent: false, resurrectionTriggered: false, error: 'App is being stopped' };
      }

      if (appState === AppConnectionState.GRACE_PERIOD) {
        return { sent: false, resurrectionTriggered: false, error: 'Connection lost, waiting for reconnection' };
      }

      if (appState === AppConnectionState.RESURRECTING) {
        return { sent: false, resurrectionTriggered: false, error: 'App is restarting' };
      }

      const websocket = this.userSession.appWebsockets.get(packageName);

      // If connection is connecting, then we can't send messages yet.
      if (websocket && websocket.readyState === WebSocket.CONNECTING) {
        this.logger.warn({
          userId: this.userSession.userId,
          packageName,
          service: 'AppManager'
        }, `TPA ${packageName} is still connecting, cannot send message yet`);
        return { sent: false, resurrectionTriggered: false, error: 'TPA is still connecting' };
      }

      // Check if websocket exists and is ready
      if (websocket && websocket.readyState === WebSocket.OPEN) {
        try {
          // Send message successfully
          websocket.send(JSON.stringify(message));
          this.logger.debug({
            packageName,
            messageType: message.type || 'unknown'
          }, `[AppManager:sendMessageToTpa]: Message sent to TPA ${packageName} for user ${this.userSession.userId}`);

          return { sent: true, resurrectionTriggered: false };
        } catch (sendError) {
          const logger = this.logger.child({ packageName });
          const errorMessage = sendError instanceof Error ? sendError.message : String(sendError);
          logger.error(sendError, `[AppManager:sendMessageToTpa]: Failed to send message to TPA ${packageName}: ${errorMessage}`);

          // Fall through to resurrection logic below
        }
      }

      // If we reach here, it means the connection is not available, let's call handleAppConnectionClosed
      // to handle the grace period and resurrection logic.
      this.logger.warn(
        { packageName },
        `[AppManager:sendMessageToTpa]: Triggering handleAppConnectionClosed for ${packageName}`
      );

      // manually trigger handleAppConnectionClosed, which will handle the grace period and resurrection logic.
      await this.handleAppConnectionClosed(packageName, 1069, 'Connection not available for messaging');
      return { sent: false, resurrectionTriggered: true, error: 'Connection not available for messaging' };

    } catch (error) {
      const logger = this.logger.child({ packageName });
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(error, `[AppManager:sendMessageToTpa]: Internal Server Error in sendMessageToTpa: ${errorMessage} - ${this.userSession.userId} ${packageName}`);

      return {
        sent: false,
        resurrectionTriggered: false,
        error: errorMessage
      };
    }
  }


  /**
   * Clean up all resources
   */
  dispose(): void {
    try {
      this.logger.debug({ userId: this.userSession.userId, service: 'AppManager' }, `[AppManager:dispose]: Disposing AppManager for user ${this.userSession.userId}`);

      // Clear pending connections
      for (const [, pending] of this.pendingConnections.entries()) {
        clearTimeout(pending.timeout);
        pending.resolve({
          success: false,
          error: { stage: 'CONNECTION', message: 'Session ended' }
        });
      }
      this.pendingConnections.clear();

      // Clear reconnection timers
      if (this.userSession._reconnectionTimers) {
        for (const [, timer] of this.userSession._reconnectionTimers.entries()) {
          clearTimeout(timer);
        }
        this.userSession._reconnectionTimers.clear();
      }

      // Clear all heartbeat intervals
      for (const [packageName, interval] of this.heartbeatIntervals.entries()) {
        clearInterval(interval);
        this.logger.debug({ packageName }, `[AppManager:dispose] Cleared heartbeat for ${packageName}`);
      }
      this.heartbeatIntervals.clear();

      // Close all app connections
      for (const [packageName, connection] of this.userSession.appWebsockets.entries()) {
        if (connection && connection.readyState === WebSocket.OPEN) {
          try {
            // Send app stopped message using direct connection (no resurrection needed during dispose)
            const message = {
              type: CloudToTpaMessageType.APP_STOPPED,
              timestamp: new Date()
            };
            connection.send(JSON.stringify(message));

            // Close the connection
            connection.close(1000, 'User session ended');
            this.logger.debug({ userId: this.userSession.userId, packageName, service: 'AppManager' },
              `Closed connection for ${packageName} during dispose`);
          } catch (error) {
            this.logger.error({
              userId: this.userSession.userId,
              packageName,
              service: 'AppManager',
              error: error instanceof Error ? error.message : String(error)
            }, `Error closing connection for ${packageName}`);
          }
        }
      }

      // Clear connections
      this.userSession.appWebsockets.clear();

      // Clear active app sessions
      this.userSession.runningApps.clear();

      // Clear loading apps
      this.userSession.loadingApps.clear();

    } catch (error) {
      this.logger.error({ error }, `Error disposing AppManager for ${this.userSession.userId}`);
    }
  }
}

export default AppManager;