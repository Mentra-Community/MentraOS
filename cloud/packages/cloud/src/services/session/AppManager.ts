/**
 * @fileoverview AppManager manages app lifecycle and App connections within a user session.
 * It encapsulates all app-related functionality that was previously
 * scattered throughout the session and WebSocket services.
 *
 * This follows the pattern used by other managers like MicrophoneManager and DisplayManager.
 */

import axios, { AxiosError } from "axios";
import { Logger } from "pino";

import {
  CloudToAppMessageType,
  CloudToGlassesMessageType,
  AppConnectionInit,
  AppStateChange,
  AppI,
  WebhookRequestType,
  SessionWebhookRequest,
  AppType,
  ExtendedStreamType,
} from "@mentra/sdk";

// import subscriptionService from "./subscription.service";
import App from "../../models/app.model";
import { User } from "../../models/user.model";
import appService from "../core/app.service";
import * as developerService from "../core/developer.service";
import { logger as rootLogger } from "../logging/pino-logger";
import { PosthogService } from "../logging/posthog.service";
import { IWebSocket, WebSocketReadyState } from "../websocket/types";

import { AppSession, AppConnectionState as AppSessionState } from "./AppSession";
import { HardwareCompatibilityService } from "./HardwareCompatibilityService";
import UserSession from "./UserSession";

// session.service APIs are being consolidated into UserSession

const logger = rootLogger.child({ service: "AppManager" });

const CLOUD_PUBLIC_HOST_NAME = process.env.CLOUD_PUBLIC_HOST_NAME; // e.g., "prod.augmentos.cloud"
const CLOUD_LOCAL_HOST_NAME = process.env.CLOUD_LOCAL_HOST_NAME; // e.g., "localhost:8002" | "cloud" | "cloud-debug-cloud.default.svc.cluster.local:80"
const AUGMENTOS_AUTH_JWT_SECRET = process.env.AUGMENTOS_AUTH_JWT_SECRET;

const APP_SESSION_TIMEOUT_MS = 5000; // 5 seconds

// Note: Connection states are now managed by AppSession (AppSessionState)
// The old AppConnectionState enum has been removed in Phase 4b

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
 * Manages app lifecycle and App connections for a user session
 */
interface AppStartResult {
  success: boolean;
  error?: {
    stage: "WEBHOOK" | "CONNECTION" | "AUTHENTICATION" | "TIMEOUT" | "HARDWARE_CHECK";
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

interface AppMessageResult {
  sent: boolean;
  resurrectionTriggered: boolean;
  error?: string;
}

export class AppManager {
  private userSession: UserSession;
  private logger: Logger;

  // ===== Disposed flag =====
  // Prevents creating new AppSessions after UserSession disposal
  private disposed = false;

  // ===== Consolidated per-app state (Phase 4) =====
  // AppSession instances hold all per-app state in one place
  // This is the SINGLE SOURCE OF TRUTH for per-app state
  private apps: Map<string, AppSession> = new Map();

  // Track pending app start operations
  private pendingConnections = new Map<string, PendingConnection>();

  // Cache of installed apps
  // private installedApps: AppI[] = [];

  constructor(userSession: UserSession) {
    this.userSession = userSession;
    this.logger = userSession.logger.child({ service: "AppManager" });
    this.logger.info("AppManager initialized");
  }

  // ===== NEW: AppSession Management (Phase 4) =====

  /**
   * Get an existing AppSession for a package
   */
  getAppSession(packageName: string): AppSession | undefined {
    return this.apps.get(packageName);
  }

  /**
   * Get or create an AppSession for a package
   */
  getOrCreateAppSession(packageName: string): AppSession | undefined {
    // Don't create new AppSessions after disposal
    if (this.disposed) {
      this.logger.warn({ packageName }, `[AppManager] Ignoring getOrCreateAppSession after disposal`);
      return undefined;
    }

    let session = this.apps.get(packageName);

    // Check if existing session is disposed (e.g., after ownership release cleanup)
    // If so, we need to create a fresh AppSession to avoid "Cannot track resources on a disposed ResourceTracker" error
    // This can happen when:
    // 1. SDK sends OWNERSHIP_RELEASE (e.g., clean_shutdown)
    // 2. handleDisconnect() calls cleanup() which disposes the ResourceTracker
    // 3. App is marked DORMANT but stays in the apps map
    // 4. Later, resurrection tries to reuse this disposed session
    // See: cloud/issues/019-sdk-photo-request-architecture (related death spiral investigation)
    if (session?.isDisposed) {
      this.logger.info(
        { packageName },
        `[AppManager] Existing AppSession for ${packageName} is disposed, creating fresh session`,
      );
      // Remove the disposed session
      this.apps.delete(packageName);
      session = undefined;
    }

    if (!session) {
      session = new AppSession({
        packageName,
        logger: this.logger,
        onGracePeriodExpired: async (appSession) => {
          await this.handleAppSessionGracePeriodExpired(appSession);
        },
        onSubscriptionsChanged: (appSession, oldSubs, newSubs) => {
          this.handleAppSessionSubscriptionsChanged(appSession, oldSubs, newSubs);
        },
        // Handle WebSocket close events - this callback is called by AppSession
        // when its close handler fires. We call handleAppConnectionClosed for
        // full cleanup logic (ownership release, subscription cleanup, etc.)
        onDisconnect: (code: number, reason: string) => {
          // Don't process disconnects if we're already disposed
          if (this.disposed) {
            this.logger.debug(
              { packageName, code, reason },
              `[AppManager] Ignoring onDisconnect callback after disposal`,
            );
            return;
          }
          // Note: AppSession.handleDisconnect() is already called before this callback
          // We call handleAppConnectionClosed for ownership/subscription cleanup
          // but skip the parts that AppSession already handled
          this.handleAppConnectionClosedFromCallback(packageName, code, reason);
        },
      });
      this.apps.set(packageName, session);
      this.logger.debug({ packageName }, `[AppManager] Created new AppSession for ${packageName}`);
    }
    return session;
  }

  /**
   * Remove an AppSession
   */
  removeAppSession(packageName: string): void {
    const session = this.apps.get(packageName);
    if (session) {
      session.dispose();
      this.apps.delete(packageName);
      this.logger.debug({ packageName }, `[AppManager] Removed AppSession for ${packageName}`);
    }
  }

  /**
   * Get all running app package names (derived from AppSession state)
   */
  getRunningAppNames(): Set<string> {
    const running = new Set<string>();
    for (const [name, session] of this.apps) {
      if (session.isRunning) {
        running.add(name);
      }
    }
    return running;
  }

  /**
   * Get all connecting/loading app package names
   */
  getLoadingAppNames(): Set<string> {
    const loading = new Set<string>();
    for (const [name, session] of this.apps) {
      if (session.isConnecting) {
        loading.add(name);
      }
    }
    return loading;
  }

  /**
   * Get all AppSession entries for iteration
   * Used by SubscriptionManager to iterate through all app subscriptions
   */
  getAllAppSessions(): Map<string, AppSession> {
    return this.apps;
  }

  // ===== WebSocket Management (Phase 4d) =====

  /**
   * Get WebSocket for an app (from AppSession)
   */
  getAppWebSocket(packageName: string): IWebSocket | null {
    const appSession = this.apps.get(packageName);
    return appSession?.webSocket ?? null;
  }

  /**
   * Get all app WebSockets as a Map (for iteration)
   * Returns a new Map with packageName -> WebSocket entries
   */
  getAllAppWebSockets(): Map<string, IWebSocket> {
    const websockets = new Map<string, IWebSocket>();
    for (const [packageName, appSession] of this.apps) {
      const ws = appSession.webSocket;
      if (ws) {
        websockets.set(packageName, ws);
      }
    }
    return websockets;
  }

  /**
   * Check if an app has a WebSocket connection
   */
  hasAppWebSocket(packageName: string): boolean {
    const appSession = this.apps.get(packageName);
    return appSession?.webSocket !== null && appSession?.webSocket !== undefined;
  }

  /**
   * Get count of connected app WebSockets
   */
  getAppWebSocketCount(): number {
    let count = 0;
    for (const [, appSession] of this.apps) {
      if (appSession.webSocket) {
        count++;
      }
    }
    return count;
  }

  /**
   * Handle grace period expiration from AppSession
   */
  private async handleAppSessionGracePeriodExpired(appSession: AppSession): Promise<void> {
    const packageName = appSession.packageName;

    // Check if user is still connected to THIS cloud
    const userConnected =
      this.userSession.websocket && this.userSession.websocket.readyState === WebSocketReadyState.OPEN;

    if (!userConnected) {
      // User not connected - can't resurrect, go to DORMANT
      // App will be resurrected when user reconnects (see resurrectDormantApps)
      this.logger.info({ packageName }, `[AppManager] Grace period expired but user not connected - marking DORMANT`);
      appSession.markDormant();
      return;
    }

    // User is connected - attempt resurrection
    this.logger.info({ packageName }, `[AppManager] Grace period expired, attempting resurrection`);

    try {
      // Stop and restart the app (resurrection)
      await this.stopApp(packageName, true);
      const result = await this.startApp(packageName);

      // Check if resurrection succeeded - startApp returns { success: false } on failure, doesn't throw
      if (!result.success) {
        this.logger.error(
          { packageName, error: result.error },
          `[AppManager] Resurrection failed for ${packageName}: ${result.error?.message}`,
        );
        appSession.markStopped();
        // Notify mobile that app stopped
        if (this.userSession.websocket && this.userSession.websocket.readyState === WebSocketReadyState.OPEN) {
          const appStoppedMessage = {
            type: "app_stopped",
            packageName: packageName,
            timestamp: new Date(),
          };
          this.userSession.websocket.send(JSON.stringify(appStoppedMessage));
          this.logger.info({ packageName }, `[AppManager] Sent app_stopped to mobile after resurrection failure`);
        }
      }
    } catch (error) {
      const logger = this.logger.child({ packageName });
      logger.error(error, `[AppManager] Error during AppSession resurrection`);
      appSession.markStopped();
      // Notify mobile that app stopped
      if (this.userSession.websocket && this.userSession.websocket.readyState === WebSocketReadyState.OPEN) {
        const appStoppedMessage = {
          type: "app_stopped",
          packageName: packageName,
          timestamp: new Date(),
        };
        this.userSession.websocket.send(JSON.stringify(appStoppedMessage));
        this.logger.info({ packageName }, `[AppManager] Sent app_stopped to mobile after resurrection error`);
      }
    }
  }

  /**
   * Resurrect apps that became dormant while the user was disconnected from this cloud.
   *
   * ## Why This Method Exists
   *
   * When a mini app's WebSocket to the cloud breaks (e.g., mini app server crashes),
   * we enter a grace period to allow the SDK to reconnect. If the grace period expires
   * and the user isn't connected, we mark the app as DORMANT instead of resurrecting.
   *
   * When the user reconnects, we call this method to resurrect any DORMANT apps that
   * the SDK didn't manage to reconnect on its own.
   *
   * ## The Multi-Cloud Problem
   *
   * Users can be connected to multiple clouds (e.g., switching regions, failover).
   * If we resurrected apps immediately when grace period expires, we could "steal" an
   * app that the user intentionally moved to another cloud:
   *
   * 1. User connected to Cloud A, running AppX
   * 2. User switches to Cloud B, starts AppX there
   * 3. AppX on Cloud A loses its WS connection (mini app now talking to Cloud B)
   * 4. Cloud A's grace period expires
   * 5. BAD: Cloud A resurrects AppX, stealing it back from Cloud B
   *
   * ## The Solution
   *
   * - Grace period: Always wait 5s for SDK reconnect (works regardless of user connection)
   * - If SDK reconnects: Great, back to RUNNING
   * - If grace expires + user connected: Resurrect immediately
   * - If grace expires + user NOT connected: Mark DORMANT, wait for user
   * - When user reconnects: Call resurrectDormantApps() to revive any DORMANT apps
   *
   * This ensures we only trigger webhooks for users actively using THIS cloud.
   * If the user switched clouds, they'll never reconnect here, and the DORMANT apps
   * get cleaned up when the UserSession disposes.
   *
   * ## Note on SDK Late Reconnection
   *
   * The SDK has 3 reconnect attempts with exponential backoff (1s, 2s, 4s = ~7s total).
   * Our grace period is 5s. So the SDK's last attempt might arrive while we're DORMANT.
   * We accept these late reconnections! If the SDK is still trying, the mini app server
   * is still alive and knows about this session - let it reconnect.
   *
   * @returns Array of package names that were attempted to resurrect
   */
  async resurrectDormantApps(): Promise<string[]> {
    const resurrected: string[] = [];
    const dormantApps = this.getDormantApps();

    if (dormantApps.length === 0) {
      return resurrected;
    }

    this.logger.info(
      { dormantApps, count: dormantApps.length },
      "[AppManager] Resurrecting dormant apps after user reconnect",
    );

    // Sequential resurrection to avoid webhook spam
    for (const packageName of dormantApps) {
      const appSession = this.apps.get(packageName);

      // Double-check still dormant (SDK might have reconnected in the meantime)
      if (!appSession?.isDormant) {
        this.logger.debug({ packageName }, "[AppManager] App no longer dormant, skipping resurrection");
        continue;
      }

      try {
        this.logger.info({ packageName }, "[AppManager] Resurrecting dormant app");
        await this.stopApp(packageName, true); // restart=true marks as RESURRECTING
        const result = await this.startApp(packageName);

        // Check if resurrection succeeded - startApp returns { success: false } on failure, doesn't throw
        if (result.success) {
          resurrected.push(packageName);
        } else {
          this.logger.error(
            { packageName, error: result.error },
            `[AppManager] Failed to resurrect dormant app ${packageName}: ${result.error?.message}`,
          );
          appSession.markStopped();
          // Notify mobile that app stopped
          if (this.userSession.websocket && this.userSession.websocket.readyState === WebSocketReadyState.OPEN) {
            const appStoppedMessage = {
              type: "app_stopped",
              packageName: packageName,
              timestamp: new Date(),
            };
            this.userSession.websocket.send(JSON.stringify(appStoppedMessage));
            this.logger.info(
              { packageName },
              "[AppManager] Sent app_stopped to mobile after dormant resurrection failure",
            );
          }
        }
      } catch (error) {
        this.logger.error(error, `[AppManager] Failed to resurrect dormant app ${packageName}`);
        appSession.markStopped();
        // Notify mobile that app stopped
        if (this.userSession.websocket && this.userSession.websocket.readyState === WebSocketReadyState.OPEN) {
          const appStoppedMessage = {
            type: "app_stopped",
            packageName: packageName,
            timestamp: new Date(),
          };
          this.userSession.websocket.send(JSON.stringify(appStoppedMessage));
          this.logger.info({ packageName }, "[AppManager] Sent app_stopped to mobile after dormant resurrection error");
        }
      }
    }

    // Broadcast updated app state to mobile
    if (resurrected.length > 0) {
      await this.broadcastAppState();
    }

    return resurrected;
  }

  /**
   * Get list of apps in DORMANT state.
   * These are apps whose mini app WS died, grace period expired, and user wasn't connected.
   */
  private getDormantApps(): string[] {
    const dormant: string[] = [];

    for (const [packageName, session] of this.apps) {
      if (session.isDormant) {
        dormant.push(packageName);
      }
    }

    return dormant;
  }

  /**
   * Handle subscription changes from AppSession
   * This can be used to trigger downstream updates (mic, transcription, etc.)
   */
  private handleAppSessionSubscriptionsChanged(
    appSession: AppSession,
    oldSubs: Set<ExtendedStreamType>,
    newSubs: Set<ExtendedStreamType>,
  ): void {
    const packageName = appSession.packageName;
    this.logger.debug(
      {
        packageName,
        oldCount: oldSubs.size,
        newCount: newSubs.size,
      },
      `[AppManager] AppSession subscriptions changed`,
    );

    // Note: In Phase 4c, SubscriptionManager will use this callback
    // to update cross-app aggregates and sync downstream managers
  }

  // ===== Connection State Helpers (delegate to AppSession) =====

  /**
   * Get the connection state for an app (from AppSession)
   */
  private getAppConnectionState(packageName: string): AppSessionState | undefined {
    const appSession = this.apps.get(packageName);
    return appSession?.state;
  }

  /**
   * Mark an app as having released ownership
   * Delegates to AppSession - when the connection closes, we won't try to resurrect it
   */
  markOwnershipReleased(packageName: string, reason: string): void {
    const appSession = this.getOrCreateAppSession(packageName);
    if (!appSession) {
      this.logger.warn({ packageName, reason }, `[AppManager] Cannot mark ownership released - AppManager disposed`);
      return;
    }
    appSession.handleOwnershipRelease(reason);

    this.logger.info(
      { packageName, reason },
      `[AppManager] App ${packageName} released ownership: ${reason} - will not resurrect on disconnect`,
    );
  }

  /**
   * Check if an app has released ownership (delegates to AppSession)
   */
  hasReleasedOwnership(packageName: string): boolean {
    const appSession = this.apps.get(packageName);
    return appSession?.ownershipReleased ?? false;
  }

  /**
   * 🚀🪝 Initiates a new App session and triggers the App's webhook.
   * Waits for App to connect and complete authentication before resolving.
   * @param packageName - App identifier
   * @returns Promise that resolves when App successfully connects and authenticates
   */
  async startApp(packageName: string): Promise<AppStartResult> {
    const logger = this.logger.child({ packageName });
    logger.info(
      {
        packageName,
        runningApps: Array.from(this.userSession.runningApps.values()),
        installedApps: JSON.stringify(this.userSession.installedApps),
      },
      `🚀🚀 Starting App ${packageName} for user ${this.userSession.userId} 🚀🚀`,
    );

    // Check if already running
    if (this.userSession.runningApps.has(packageName)) {
      logger.info({}, `App ${packageName} already running`);
      return { success: true };
    }

    // Check if this app is a foreground app, and if so, check if the user is already running a foreground app.
    // If so, we should stop the currently running foreground app before starting a new one.

    // TODO(isaiah): Test if we can use the installedApps cache instead of fetching from DB
    const app = await appService.getApp(packageName);
    if (!app) {
      logger.error({ packageName }, `App ${packageName} not found`);
      return {
        success: false,
        error: { stage: "WEBHOOK", message: `App ${packageName} not found` },
      };
    }

    // Check hardware compatibility
    const compatibilityResult = HardwareCompatibilityService.checkCompatibility(
      app,
      this.userSession.deviceManager.getCapabilities(),
    );

    if (!compatibilityResult.isCompatible) {
      logger.error(
        {
          packageName,
          missingHardware: compatibilityResult.missingRequired,
          capabilities: this.userSession.deviceManager.getCapabilities(),
        },
        `App ${packageName} is incompatible with connected glasses hardware`,
      );
      return {
        success: false,
        error: {
          stage: "HARDWARE_CHECK",
          message: HardwareCompatibilityService.getCompatibilityMessage(compatibilityResult),
        },
      };
    }

    // Log optional hardware warnings
    if (compatibilityResult.missingOptional.length > 0) {
      logger.warn(
        {
          packageName,
          missingOptional: compatibilityResult.missingOptional,
        },
        `App ${packageName} has optional hardware requirements that are not available`,
      );
    }

    // If the app is a standard app, check if any other foreground app is running

    if (app.appType === AppType.STANDARD) {
      logger.debug(`App ${packageName} is a standard app, checking for running foreground apps`);
      // Check if any other foreground app is running
      const runningAppsPackageNames = Array.from(this.userSession.runningApps.keys());
      const runningForegroundApps = await App.find({
        packageName: { $in: runningAppsPackageNames },
        appType: AppType.STANDARD,
      });
      logger.debug(
        { runningAppsPackageNames, runningForegroundApps },
        `Running foreground apps: ${JSON.stringify(runningForegroundApps)}`,
      );
      if (runningForegroundApps.length > 0) {
        // Stop the currently running foreground app
        const currentlyRunningApp = runningForegroundApps[0];
        logger.info(
          { currentlyRunningApp },
          `Stopping currently running foreground app ${currentlyRunningApp.packageName} before starting ${packageName}`,
        );
        await this.stopApp(currentlyRunningApp.packageName); // Restarting, so allow stopping even if not running
      }
    }

    // TODO(isaiah): instead of polling, we can optionally store list of other promises, or maybe just fail gracefully.
    // Check if already loading - return existing pending promise
    if (this.userSession.loadingApps.has(packageName)) {
      const existing = this.pendingConnections.get(packageName);
      if (existing) {
        this.logger.info(
          {
            userId: this.userSession.userId,
            packageName,
            service: "AppManager",
          },
          `App ${packageName} already loading, waiting for existing attempt`,
        );

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
                  error: {
                    stage: "CONNECTION",
                    message: "Existing connection attempt failed",
                  },
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

    // Update last active timestamp when app starts or stops
    this.updateAppLastActive(packageName);

    // Create Promise for tracking this connection attempt
    return new Promise<AppStartResult>((resolve, reject) => {
      const startTime = Date.now();

      // Set up timeout
      const timeout = setTimeout(async () => {
        this.logger.error(
          {
            userId: this.userSession.userId,
            packageName,
            service: "AppManager",
            duration: Date.now() - startTime,
          },
          `App ${packageName} connection timeout after ${APP_SESSION_TIMEOUT_MS}ms`,
        );

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
        const appSession = this.apps.get(packageName);
        if (appSession) {
          appSession.markStopped();
        }
        // remove from user.runningApps.
        try {
          // TODO(isaiah): See if we can speed this up by using the cached user in UserSession instead of fetching from DB.
          const user = await User.findByEmail(this.userSession.userId);
          if (user) {
            this.logger.info(
              {
                userId: this.userSession.userId,
                packageName,
                service: "AppManager",
              },
              `Removing app ${packageName} from user's running apps due to timeout`,
            );
            user.removeRunningApp(packageName).catch((err) => {
              this.logger.error(err, `Error removing app ${packageName} from user's running apps`);
            });
          }
        } catch (error) {
          this.logger.error(
            error,
            `Error finding user ${this.userSession.userId} to remove running app ${packageName}`,
          );
        }

        resolve({
          success: false,
          error: {
            stage: "TIMEOUT",
            message: `Connection timeout after ${APP_SESSION_TIMEOUT_MS}ms`,
          },
        });
      }, APP_SESSION_TIMEOUT_MS);

      // Store pending connection
      this.pendingConnections.set(packageName, {
        packageName,
        resolve,
        reject,
        timeout,
        startTime,
      });

      this.logger.info(
        { userId: this.userSession.userId, packageName, service: "AppManager" },
        `⚡️ Starting app ${packageName} - creating pending connection`,
      );
      this.userSession.loadingApps.add(packageName);

      // Get or create AppSession and mark as connecting
      const appSession = this.getOrCreateAppSession(packageName);
      if (!appSession) {
        this.userSession.loadingApps.delete(packageName);
        reject({
          success: false,
          error: { stage: "CONNECTION", message: "AppManager disposed" },
        });
        return;
      }
      appSession.startConnecting();

      // Continue with webhook trigger
      this.triggerAppWebhookInternal(app, resolve, reject, startTime);
    });
  }

  private async updateAppLastActive(packageName: string): Promise<void> {
    // Update the last active timestamp for the app in the user's record
    try {
      const user = await User.findByEmail(this.userSession.userId);
      if (user) {
        await user.updateAppLastActive(packageName);
        return;
      }
      this.logger.error(
        { userId: this.userSession.userId, packageName, service: "AppManager" },
        `User ${this.userSession.userId} not found while updating last active for app ${packageName}`,
      );
      return;
    } catch (error) {
      // Log the error but don't crash the application
      this.logger.error(
        {
          userId: this.userSession.userId,
          packageName,
          service: "AppManager",
          error: error instanceof Error ? error.message : String(error),
          errorName: error instanceof Error ? error.name : "Unknown",
        },
        `Error updating last active for app ${packageName} - continuing without crash`,
      );

      // Don't throw the error - this is a non-critical operation
      return;
    }
  }

  /**
   * Internal method to handle webhook triggering and error handling
   */
  private async triggerAppWebhookInternal(
    app: AppI,
    resolve: (result: AppStartResult) => void,
    reject: (error: Error) => void,
    startTime: number,
  ): Promise<void> {
    try {
      // Trigger App webhook
      const { packageName, name, publicUrl } = app;
      this.logger.debug(
        { packageName, name, publicUrl },
        `Triggering App webhook for ${packageName} for user ${this.userSession.userId}`,
      );

      // Set up the websocket URL for the App connection
      const augmentOSWebsocketUrl = `wss://${CLOUD_PUBLIC_HOST_NAME}/app-ws`;

      // Construct the webhook URL from the app's public URL
      const webhookURL = `${app.publicUrl}/webhook`;
      this.logger.info({ augmentOSWebsocketUrl, packageName }, `Triggering webhook for ${packageName}: ${webhookURL}`);

      // Trigger boot screen.
      this.userSession.displayManager.handleAppStart(app.packageName);

      await this.triggerWebhook(webhookURL, {
        type: WebhookRequestType.SESSION_REQUEST,
        sessionId: this.userSession.userId + "-" + packageName,
        userId: this.userSession.userId,
        timestamp: new Date().toISOString(),
        augmentOSWebsocketUrl,
      });

      this.logger.info(
        {
          userId: this.userSession.userId,
          packageName,
          service: "AppManager",
          duration: Date.now() - startTime,
        },
        `Webhook sent successfully for app ${packageName}, waiting for App connection`,
      );

      // Note: Database will be updated when App actually connects in handleAppInit()
      // Note: App start message to glasses will be sent when App connects
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(
        {
          userId: this.userSession.userId,
          packageName: app.packageName,
          service: "AppManager",
          error: errorMessage,
          duration: Date.now() - startTime,
        },
        `Error triggering webhook for app ${app.packageName}`,
      );

      // Clean up pending connection
      const pending = this.pendingConnections.get(app.packageName);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingConnections.delete(app.packageName);
      }

      this.userSession.loadingApps.delete(app.packageName);
      this.userSession.displayManager.handleAppStop(app.packageName);

      // Clean up dashboard content for failed app
      this.userSession.dashboardManager.cleanupAppContent(app.packageName);

      // Reset connection state to prevent apps from being stuck in RESURRECTING
      const appSession = this.apps.get(app.packageName);
      if (appSession) {
        appSession.markStopped();
      }

      // Resolve with error instead of throwing
      resolve({
        success: false,
        error: {
          stage: "WEBHOOK",
          message: `Webhook failed: ${errorMessage}`,
          details: error,
        },
      });
    }
  }

  /**
   * Helper method to resolve pending connections with errors
   */
  private resolvePendingConnectionWithError(
    packageName: string,
    stage: "WEBHOOK" | "CONNECTION" | "AUTHENTICATION" | "TIMEOUT",
    message: string,
  ): void {
    const pending = this.pendingConnections.get(packageName);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingConnections.delete(packageName);

      const duration = Date.now() - pending.startTime;
      this.logger.error(
        {
          userId: this.userSession.userId,
          packageName,
          service: "AppManager",
          duration,
          stage,
        },
        `App ${packageName} connection failed at ${stage} stage after ${duration}ms: ${message}`,
      );

      pending.resolve({
        success: false,
        error: { stage, message },
      });
    }
  }

  /**
   * Triggers a webhook for a App.
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
            "Content-Type": "application/json",
          },
          timeout: 10000, // Increase timeout to 10 seconds
        });
        return;
      } catch (error: unknown) {
        if (attempt === maxRetries - 1) {
          if (axios.isAxiosError(error)) {
            // Enrich the error with context for better debugging
            const enrichedError = Object.assign(error, {
              packageName: payload.sessionId.split("-")[1],
              webhookUrl: url,
              attempts: maxRetries,
              timeout: 10000,
              operation: "triggerWebhook",
              userId: payload.userId,
              payloadType: payload.type,
            });
            this.logger.error(enrichedError, `Webhook failed after ${maxRetries} attempts`);
          }
          throw new Error(
            `Webhook failed after ${maxRetries} attempts: ${(error as AxiosError).message || "Unknown error"}`,
          );
        }
        // Exponential backoff
        await new Promise((resolve) => setTimeout(resolve, baseDelay * Math.pow(2, attempt)));
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
      // Check if app is running or loading via AppSession
      const appSession = this.apps.get(packageName);
      const isRunning = appSession?.isRunning ?? false;
      const isConnecting = appSession?.isConnecting ?? false;

      if (!isRunning && !isConnecting && !restart) {
        this.logger.info(`App ${packageName} not running, ignoring stop request`);
        return;
      }

      this.logger.info(`Stopping app ${packageName}`);

      // Set to STOPPING state before closing WebSocket (via AppSession)
      if (appSession) {
        if (restart) {
          appSession.markResurrecting();
        } else {
          appSession.markStopping();
        }
      }

      // Trigger app stop webhook
      try {
        // TODO(isaiah): Move logic to stop app out of appService and into this class.
        await appService.triggerStopByPackageName(packageName, this.userSession.userId);
      } catch (webhookError) {
        this.logger.error(webhookError, `Error triggering stop webhook for ${packageName}:`);
      }

      // Remove subscriptions.
      try {
        await this.userSession.subscriptionManager.removeSubscriptions(packageName);
        // Location tier is now computed in-memory by SubscriptionManager.syncManagers()
      } catch (error) {
        this.logger.error(error, `Error removing subscriptions for ${packageName}`);
      }

      // Broadcast app state change
      await this.broadcastAppState();

      // Close WebSocket connection via AppSession
      if (appSession) {
        const appWebsocket = appSession.webSocket;
        if (appWebsocket && appWebsocket.readyState === WebSocketReadyState.OPEN) {
          try {
            // Send app stopped message
            const message = {
              type: CloudToAppMessageType.APP_STOPPED,
              timestamp: new Date(),
            };
            appWebsocket.send(JSON.stringify(message));

            // Close the connection (AppSession will clean up internally)
            appWebsocket.close(1000, "App stopped");
          } catch (error) {
            this.logger.error(error, `Error closing connection for ${packageName}`);
          }
        }
      }

      // Update user's running apps in database
      try {
        const user = await User.findByEmail(this.userSession.userId);
        if (user) {
          await user.removeRunningApp(packageName);
        }
      } catch (error) {
        this.userSession.logger.error(error, `Error updating user's running apps`);
      }

      // Clean up display state for stopped app
      this.userSession.displayManager.handleAppStop(packageName);

      // Clean up dashboard content for stopped app
      this.userSession.dashboardManager.cleanupAppContent(packageName);

      // Track app_stop event with session duration (from AppSession)
      try {
        const startTime = appSession?.startTime;
        if (startTime) {
          const sessionDuration = Date.now() - startTime.getTime();

          // Track app_stop event in PostHog
          await PosthogService.trackEvent("app_stop", this.userSession.userId, {
            packageName,
            userId: this.userSession.userId,
            sessionId: this.userSession.sessionId,
            sessionDuration,
          });
        } else {
          // App stopped but no start time recorded (edge case)
          this.logger.debug({ packageName }, "App stopped but no start time recorded");
        }

        // Clean up AppSession
        if (appSession) {
          appSession.markStopped();
        }
      } catch (error) {
        const logger = this.logger.child({ packageName });
        logger.error(error, "Error tracking app_stop event in PostHog");
      }

      this.updateAppLastActive(packageName);
    } catch (error) {
      this.logger.error(error, `Error stopping app ${packageName}:`);
    }
  }

  /**
   * Check if an app is currently running (via AppSession)
   *
   * @param packageName Package name to check
   * @returns Whether the app is running
   */
  isAppRunning(packageName: string): boolean {
    const appSession = this.apps.get(packageName);
    return appSession?.isRunning ?? false;
  }

  /**
   * Handle App initialization
   *
   * @param ws WebSocket connection
   * @param initMessage App initialization message
   */
  async handleAppInit(ws: IWebSocket, initMessage: AppConnectionInit): Promise<void> {
    try {
      const { packageName, apiKey, sessionId } = initMessage;

      // Validate the API key
      const isValidApiKey = await developerService.validateApiKey(packageName, apiKey, this.userSession);

      if (!isValidApiKey) {
        this.logger.error(
          {
            userId: this.userSession.userId,
            packageName,
            service: "AppManager",
          },
          `Invalid API key for App ${packageName}`,
        );

        // Resolve pending connection with auth error
        this.resolvePendingConnectionWithError(packageName, "AUTHENTICATION", "Invalid API key");

        try {
          ws.send(
            JSON.stringify({
              type: CloudToAppMessageType.CONNECTION_ERROR,
              code: "INVALID_API_KEY",
              message: "Invalid API key",
              timestamp: new Date(),
            }),
          );

          ws.close(1008, "Invalid API key");
        } catch (sendError) {
          this.logger.error(sendError, `Error sending auth error to App ${packageName}:`);
        }

        return;
      }

      // Check if app is in loading, running, grace period, or dormant state via AppSession
      // Grace period allows SDK reconnection after temporary disconnection (e.g., network hiccup)
      // Dormant allows late SDK reconnection after grace period expired while user was disconnected
      const appSession = this.apps.get(packageName);
      const isConnecting = appSession?.isConnecting ?? false;
      const isRunning = appSession?.isRunning ?? false;
      const isInGracePeriod = appSession?.isInGracePeriod ?? false;
      const isDormant = appSession?.isDormant ?? false;

      if (!isConnecting && !isRunning && !isInGracePeriod && !isDormant) {
        this.logger.error(
          {
            userId: this.userSession.userId,
            packageName,
            service: "AppManager",
            appState: appSession?.state ?? "no_session",
          },
          `App ${packageName} not in loading, active, grace period, or dormant state for session ${this.userSession.userId}`,
        );

        // Resolve pending connection with connection error
        this.resolvePendingConnectionWithError(packageName, "CONNECTION", "App not started for this session");

        try {
          ws.send(
            JSON.stringify({
              type: CloudToAppMessageType.CONNECTION_ERROR,
              code: "APP_NOT_STARTED",
              message: "App not started for this session",
              timestamp: new Date(),
            }),
          );
        } catch (sendError) {
          this.logger.error(sendError, `Error sending app not started error to App ${packageName}:`);
        }
        ws.close(1008, "App not started for this session");
        return;
      }

      // If DORMANT, the SDK is reconnecting after we gave up waiting during grace period
      // This is great - accept the reconnection! The mini app server is still alive.
      if (isDormant) {
        this.logger.info(
          { packageName, userId: this.userSession.userId },
          "[AppManager] SDK reconnected while DORMANT - accepting late reconnection",
        );
      }

      // Get or create AppSession and handle the connection
      // AppSession now owns the WebSocket (Phase 4d)
      const connectedAppSession = this.getOrCreateAppSession(packageName);
      if (!connectedAppSession) {
        this.logger.warn({ packageName }, `[AppManager] Cannot handle app init - AppManager disposed`);
        ws.close(1008, "Session ended");
        return;
      }
      connectedAppSession.handleConnect(ws);

      // Note: Close event handler is now managed by AppSession.handleConnect()
      // AppSession registers its own close handler and calls our onDisconnect callback
      // This ensures proper cleanup when AppSession is disposed

      // Note: AppSession state is now RUNNING after handleConnect()
      // runningApps and loadingApps are derived from AppSession state via getRunningAppNames()/getLoadingAppNames()

      // Get app settings with proper fallback hierarchy
      const app = this.userSession.installedApps.get(packageName);

      // Get user's settings with fallback to app defaults
      const user = await User.findOrCreateUser(this.userSession.userId);
      const userSettings = user.getAppSettings(packageName) || app?.settings || [];

      // Get user's AugmentOS system settings with fallback to defaults
      // NOTE: user.augmentosSettings is legacy - new settings go through UserSettings model
      // This fallback is kept for backward compatibility with apps expecting augmentosSettings in CONNECTION_ACK
      const userAugmentosSettings = user.augmentosSettings || {
        useOnboardMic: false,
        contextualDashboard: true,
        headUpAngle: 20,
        brightness: 50,
        autoBrightness: false,
        sensingEnabled: true,
        alwaysOnStatusBar: false,
        bypassVad: false,
        bypassAudioEncoding: false,
        metricSystemEnabled: false,
      };

      // Send connection acknowledgment with capabilities
      const ackMessage = {
        type: CloudToAppMessageType.CONNECTION_ACK,
        sessionId: sessionId,
        settings: userSettings,
        augmentosSettings: userAugmentosSettings,
        capabilities: this.userSession.getCapabilities(),
        timestamp: new Date(),
      };

      ws.send(JSON.stringify(ackMessage));

      // Send full device state snapshot immediately after CONNECTION_ACK
      this.userSession.deviceManager.sendFullStateSnapshot(ws);

      // update user.runningApps in database.
      try {
        if (user) {
          await user.addRunningApp(packageName);
        }
      } catch (error) {
        this.logger.error(
          error,
          `Error updating user's running apps for ${this.userSession.userId} for app ${packageName}`,
        );
        this.logger.debug(
          { packageName, userId: this.userSession.userId },
          `Failed to update user's running apps for ${this.userSession.userId}`,
        );
      }

      // Resolve pending connection if it exists
      const pending = this.pendingConnections.get(packageName);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingConnections.delete(packageName);

        const duration = Date.now() - pending.startTime;
        this.logger.info(
          {
            userId: this.userSession.userId,
            packageName,
            sessionId: this.userSession.sessionId,
            service: "AppManager",
            duration,
          },
          `App ${packageName} successfully connected and authenticated in ${duration}ms`,
        );

        // Note: AppSession.handleConnect() already clears ownership release flag and sets state to RUNNING
        // The startTime is also set in AppSession when startConnecting() was called

        // Track app_start event in PostHog
        try {
          await PosthogService.trackEvent("app_start", this.userSession.userId, {
            packageName,
            userId: this.userSession.userId,
            sessionId: this.userSession.sessionId,
          });
        } catch (error) {
          const logger = this.logger.child({ packageName });
          logger.error(error, "Error tracking app_start event in PostHog");
        }

        pending.resolve({ success: true });
      } else {
        // Log for existing connection (not from startApp)
        this.logger.info(
          {
            userId: this.userSession.userId,
            packageName,
            sessionId: this.userSession.sessionId,
            service: "AppManager",
          },
          `App ${packageName} connected (not from startApp) - moved to runningApps`,
        );
      }

      // Track connection in analytics
      PosthogService.trackEvent("app_connection", this.userSession.userId, {
        packageName,
        sessionId: this.userSession.sessionId,
        timestamp: new Date().toISOString(),
      });

      // Broadcast app state change
      await this.broadcastAppState();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(
        {
          userId: this.userSession.userId,
          packageName: initMessage.packageName,
          service: "AppManager",
          error: errorMessage,
        },
        `Error handling App init for ${initMessage.packageName}`,
      );

      // Resolve pending connection with general error
      this.resolvePendingConnectionWithError(initMessage.packageName, "CONNECTION", `Internal error: ${errorMessage}`);

      try {
        ws.send(
          JSON.stringify({
            type: CloudToAppMessageType.CONNECTION_ERROR,
            code: "INTERNAL_ERROR",
            message: "Internal server error",
            timestamp: new Date(),
          }),
        );

        ws.close(1011, "Internal server error");
      } catch (sendError) {
        this.logger.error(sendError, `Error sending internal error to App:`);
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
      const clientSessionData = await this.userSession.snapshotForClient();
      this.logger.debug({ clientSessionData }, `Transformed user session data for ${this.userSession.userId}`);
      // Create app state change message
      const appStateChange: AppStateChange = {
        type: CloudToGlassesMessageType.APP_STATE_CHANGE,
        sessionId: this.userSession.sessionId,
        // userSession: clientSessionData,
        timestamp: new Date(),
      };

      // Send to client
      if (!this.userSession.websocket || this.userSession.websocket.readyState !== WebSocketReadyState.OPEN) {
        this.logger.warn(`WebSocket is not open for client app state change`);
        return appStateChange;
      }

      this.userSession.websocket.send(JSON.stringify(appStateChange));
      this.logger.debug({ appStateChange }, `Sent APP_STATE_CHANGE to ${this.userSession.userId}`);
      return appStateChange;
    } catch (error) {
      this.logger.error(error, `Error broadcasting app state for ${this.userSession.userId}`);
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
      this.logger.info(
        { installedAppsList: installedAppsList.map((app) => app.packageName) },
        `Fetched ${installedApps.size} installed apps for ${this.userSession.userId}`,
      );

      // Update session's installed apps
      this.userSession.installedApps = installedApps;

      this.logger.info(`Updated installed apps for ${this.userSession.userId}`);
    } catch (error) {
      this.logger.error(error, `Error refreshing installed apps:`);
    }
  }

  /**
   * Start all previously running apps
   */
  async startPreviouslyRunningApps(): Promise<void> {
    const logger = this.logger.child({
      function: "startPreviouslyRunningApps",
    });
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

      await Promise.all(
        previouslyRunningApps.map(async (packageName) => {
          try {
            const appStartResult: AppStartResult = await this.startApp(packageName);
            if (!appStartResult.success) {
              logger.warn(
                { packageName, userId: this.userSession.userId },
                `Failed to start previously running app ${packageName}: ${appStartResult.error?.message}`,
              );
              return; // Skip to next app
            }
            startedApps.push(packageName);
          } catch (error) {
            logger.error(error, `Error starting previously running app ${packageName}:`);
            // Continue with other apps
          }
        }),
      );
      logger.info(
        { previouslyRunningApps, startedApps },
        `Started ${startedApps.length}/${previouslyRunningApps.length} previously running apps for ${this.userSession.userId}`,
      );
    } catch (error) {
      logger.error(error, `Error starting previously running apps:`);
    }
  }

  /**
   * Handle app connection close from AppSession callback
   * This is called AFTER AppSession.handleDisconnect() has already run,
   * so we only need to handle AppManager-level concerns (ownership, subscriptions, display)
   */
  private handleAppConnectionClosedFromCallback(packageName: string, code: number, reason: string): void {
    const logger = this.logger.child({
      function: "handleAppConnectionClosedFromCallback",
      packageName,
      code,
      reason,
    });

    const appSession = this.apps.get(packageName);
    if (!appSession) {
      logger.debug("No AppSession found, nothing to clean up");
      return;
    }

    // Check if ownership was released - if so, clean up subscriptions and display
    if (appSession.ownershipReleased) {
      const releaseInfo = appSession.ownershipReleaseInfo;
      logger.info({ releaseReason: releaseInfo?.reason }, `App closed after ownership release - cleaning up`);

      // Clean up subscriptions
      this.userSession.subscriptionManager.removeSubscriptions(packageName).catch((error) => {
        logger.error(error, "Error removing subscriptions after ownership release");
      });

      // Notify display manager
      this.userSession.displayManager.handleAppStop(packageName);
    }
  }

  /**
   * Handle app connection close
   * Note: This is now mainly called manually (e.g., from sendMessageToApp)
   * WebSocket close events are handled via AppSession callback -> handleAppConnectionClosedFromCallback
   *
   * @param packageName Package name
   * @param code Close code
   * @param reason Close reason
   */
  async handleAppConnectionClosed(packageName: string, code: number, reason: string): Promise<void> {
    const logger = this.logger.child({
      function: "handleAppConnectionClosed",
      packageName,
      code,
      reason,
    });
    try {
      logger.info({ packageName, code, reason }, `[AppManager]: (${packageName}, ${code}, ${reason})`);

      // Note: WebSocket is now owned by AppSession (Phase 4d)
      // Heartbeat is managed by AppSession and cleared in handleDisconnect()

      // Get AppSession and let it handle the disconnect
      const appSession = this.apps.get(packageName);

      if (appSession) {
        // Check current connection state via AppSession
        if (appSession.state === AppSessionState.STOPPING) {
          this.logger.debug(
            { packageName },
            `[AppManager]: App ${packageName} stopped as expected (STOPPING state), removing from tracking`,
          );
          appSession.markStopped();
          return;
        }

        // Check if ownership was released (SDK sent OWNERSHIP_RELEASE before disconnect)
        // This indicates a clean handoff to another cloud.
        // AppSession.handleDisconnect will mark as DORMANT (not STOPPED) so the app
        // will be resurrected if the user returns to this cloud.
        // NOTE: We do NOT modify user.runningApps in the database here because
        // all clouds share the same DB - the new cloud needs to see the app in runningApps.
        if (appSession.ownershipReleased) {
          const releaseInfo = appSession.ownershipReleaseInfo;
          logger.info(
            { packageName, code, reason, releaseReason: releaseInfo?.reason },
            `[AppManager] App ${packageName} closed after ownership release (${releaseInfo?.reason}) - marking DORMANT for potential resurrection`,
          );

          // Let AppSession handle cleanup (state transitions to DORMANT)
          appSession.handleDisconnect(code, reason);

          // Clean up subscriptions
          await this.userSession.subscriptionManager.removeSubscriptions(packageName);

          // Notify display manager
          this.userSession.displayManager.handleAppStop(packageName);

          return;
        }
      }

      // Check for normal close codes (intentional shutdown)
      if (code === 1000 || code === 1001) {
        // this.logger.debug({ packageName, code }, `[AppManager:handleAppConnectionClosed]: (code === 1000 || code === 1001) - App ${packageName} closed normally`);

        // // Let's call stopApp to remove the app from runningApps and loadingApps.
        // await this.stopApp(packageName, false);
        // this.logger.debug(`App ${packageName} stopped cleanly after normal close`);
        // return;

        // NOTE(isaiah): I think even if the app closes normally, we still want to handle the grace period and resurrection logic.
        // The app should only stop if it was stopped explicitly, not just because it closed normally.
        logger.debug(
          `[AppManager]: (code === 1000 || code === 1001) | code:${code}, reason:${reason} | App ${packageName}, continuing to handle grace period and resurrection logic`,
        );
      }

      // Unexpected close - let AppSession handle grace period
      logger.warn(
        `App ${packageName} unexpectedly disconnected (code: ${code}) (reason: ${reason}), starting grace period`,
      );

      if (appSession) {
        // AppSession.handleDisconnect() will:
        // 1. Set state to GRACE_PERIOD
        // 2. Start internal grace timer
        // 3. Call onGracePeriodExpired callback when timer fires (which triggers resurrection)
        appSession.handleDisconnect(code, reason);
      } else {
        // Fallback for edge case where AppSession doesn't exist
        // This can happen if dispose() was called and cleared apps map before
        // the WebSocket close event fired - in that case, don't create new sessions
        if (this.disposed) {
          logger.info(
            { packageName, code, reason },
            `[AppManager] Ignoring app disconnect after disposal - this is expected`,
          );
          return;
        }

        logger.warn({ packageName }, `[AppManager] No AppSession found for disconnected app, creating one`);
        const newAppSession = this.getOrCreateAppSession(packageName);
        if (newAppSession) {
          newAppSession.handleDisconnect(code, reason);
        }
      }
    } catch (error) {
      this.logger.error(error, `Error handling app connection close for ${packageName}:`);
    }
  }

  /**
   * Send a message to a App with automatic resurrection if connection is dead
   * @param packageName - App package name
   * @param message - Message to send (will be JSON.stringify'd)
   * @returns Promise with send result and resurrection info
   */
  async sendMessageToApp(packageName: string, message: any): Promise<AppMessageResult> {
    try {
      // Check connection state first (via AppSession)
      const appState = this.getAppConnectionState(packageName);

      if (appState === AppSessionState.STOPPING) {
        return {
          sent: false,
          resurrectionTriggered: false,
          error: "App is being stopped",
        };
      }

      if (appState === AppSessionState.GRACE_PERIOD) {
        return {
          sent: false,
          resurrectionTriggered: false,
          error: "Connection lost, waiting for reconnection",
        };
      }

      if (appState === AppSessionState.RESURRECTING) {
        return {
          sent: false,
          resurrectionTriggered: false,
          error: "App is restarting",
        };
      }

      // Get WebSocket from AppSession (Phase 4d)
      const appSession = this.apps.get(packageName);
      const websocket = appSession?.webSocket;

      // If connection is connecting, then we can't send messages yet.
      if (websocket && websocket.readyState === WebSocketReadyState.CONNECTING) {
        this.logger.warn(
          {
            userId: this.userSession.userId,
            packageName,
            service: "AppManager",
          },
          `App ${packageName} is still connecting, cannot send message yet`,
        );
        return {
          sent: false,
          resurrectionTriggered: false,
          error: "App is still connecting",
        };
      }

      // Check if websocket exists and is ready
      if (websocket && websocket.readyState === WebSocketReadyState.OPEN) {
        try {
          // Send message successfully
          websocket.send(JSON.stringify(message));
          this.logger.debug(
            {
              packageName,
              messageType: message.type || "unknown",
            },
            `[AppManager:sendMessageToApp]: Message sent to App ${packageName} for user ${this.userSession.userId}`,
          );

          return { sent: true, resurrectionTriggered: false };
        } catch (sendError) {
          const logger = this.logger.child({ packageName });
          const errorMessage = sendError instanceof Error ? sendError.message : String(sendError);
          logger.error(
            sendError,
            `[AppManager:sendMessageToApp]: Failed to send message to App ${packageName}: ${errorMessage}`,
          );

          // Fall through to resurrection logic below
        }
      }

      // If we reach here, it means the connection is not available, let's call handleAppConnectionClosed
      // to handle the grace period and resurrection logic.
      this.logger.warn(
        { packageName },
        `[AppManager:sendMessageToApp]: Triggering handleAppConnectionClosed for ${packageName}`,
      );

      // manually trigger handleAppConnectionClosed, which will handle the grace period and resurrection logic.
      await this.handleAppConnectionClosed(packageName, 1069, "Connection not available for messaging");
      return {
        sent: false,
        resurrectionTriggered: true,
        error: "Connection not available for messaging",
      };
    } catch (error) {
      const logger = this.logger.child({ packageName });
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(
        error,
        `[AppManager:sendMessageToApp]: Internal Server Error in sendMessageToApp: ${errorMessage} - ${this.userSession.userId} ${packageName}`,
      );

      return {
        sent: false,
        resurrectionTriggered: false,
        error: errorMessage,
      };
    }
  }

  /**
   * Clean up all resources
   */
  dispose(): void {
    // Mark as disposed FIRST to prevent any new AppSessions from being created
    // during the disposal process (e.g., from delayed WebSocket close events)
    this.disposed = true;

    try {
      this.logger.debug(
        { userId: this.userSession.userId, service: "AppManager" },
        `[AppManager:dispose]: Disposing AppManager for user ${this.userSession.userId}`,
      );

      // Clear pending connections
      for (const [, pending] of this.pendingConnections.entries()) {
        clearTimeout(pending.timeout);
        pending.resolve({
          success: false,
          error: { stage: "CONNECTION", message: "Session ended" },
        });
      }
      this.pendingConnections.clear();

      // Track app_stop events for all running apps during disposal (using AppSession)
      const currentTime = Date.now();
      for (const [packageName, appSession] of this.apps) {
        // Only track running apps
        if (!appSession.isRunning) continue;
        try {
          const startTime = appSession.startTime;
          if (startTime) {
            const sessionDuration = currentTime - startTime.getTime();

            // Track app_stop event for session end
            PosthogService.trackEvent("app_stop", this.userSession.userId, {
              packageName,
              userId: this.userSession.userId,
              sessionId: this.userSession.sessionId,
              sessionDuration,
              stopReason: "session_end",
            }).catch((error) => {
              const logger = this.logger.child({ packageName });
              logger.error(error, "Error tracking app_stop event during disposal");
            });
          }
        } catch (error) {
          const logger = this.logger.child({ packageName });
          logger.error(error, "Error tracking app stop during disposal");
        }
      }

      // Close all app connections via AppSession (Phase 4d)
      for (const [packageName, appSession] of this.apps) {
        const connection = appSession.webSocket;
        if (connection && connection.readyState === WebSocketReadyState.OPEN) {
          try {
            // Send app stopped message using direct connection (no resurrection needed during dispose)
            const message = {
              type: CloudToAppMessageType.APP_STOPPED,
              timestamp: new Date(),
            };
            connection.send(JSON.stringify(message));

            // Close the connection
            appSession.markStopping();
            connection.close(1000, "User session ended");
            this.logger.debug(
              {
                userId: this.userSession.userId,
                packageName,
                service: "AppManager",
              },
              `Closed connection for ${packageName} during dispose`,
            );
          } catch (error) {
            this.logger.error(
              {
                userId: this.userSession.userId,
                packageName,
                service: "AppManager",
                error: error instanceof Error ? error.message : String(error),
              },
              `Error closing connection for ${packageName}`,
            );
          }
        }
      }

      // Note: runningApps, loadingApps, and appWebsockets are now derived from AppSession (Phase 4d)
      // No need to clear them separately - disposing AppSession handles everything

      // Dispose all AppSession instances
      for (const [packageName, appSession] of this.apps) {
        try {
          appSession.dispose();
          this.logger.debug({ packageName }, `[AppManager:dispose] Disposed AppSession for ${packageName}`);
        } catch (error) {
          this.logger.error(
            { error, packageName },
            `[AppManager:dispose] Error disposing AppSession for ${packageName}`,
          );
        }
      }
      this.apps.clear();
    } catch (error) {
      this.logger.error(error, `Error disposing AppManager for ${this.userSession.userId}`);
    }
  }
}

export default AppManager;
