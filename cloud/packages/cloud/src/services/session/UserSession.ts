/**
 * @fileoverview UserSession class that encapsulates all session-related
 * functionality and state for the server.
 */

import { Logger } from "pino";

import {
  AppI,
  AppToCloudMessage,
  Capabilities,
  CloudToAppMessageType,
  CloudToGlassesMessageType,
  ConnectionError,
  GlassesToCloudMessage,
} from "@mentra/sdk";

import { ResourceTracker } from "../../utils/resource-tracker";
import appService from "../core/app.service";
import { memoryLeakDetector } from "../debug/MemoryLeakDetector";
import DisplayManager from "../layout/DisplayManager6.1";
import { logger as rootLogger } from "../logging/pino-logger";
import { PosthogService } from "../logging/posthog.service";
import { ManagedStreamingExtension } from "../streaming/ManagedStreamingExtension";
import { StreamRegistry } from "../streaming/StreamRegistry";
import { IWebSocket, WebSocketReadyState, hasEventEmitter } from "../websocket/types";

import AppManager from "./AppManager";
import AudioManager from "./AudioManager";
import CalendarManager from "./CalendarManager";
import { DashboardManager } from "./dashboard";
import DeviceManager from "./DeviceManager";
import { handleAppMessage as appMessageHandler, handleGlassesMessage as glassesMessageHandler } from "./handlers";
import LiveKitManager from "./livekit/LiveKitManager";
import SpeakerManager from "./livekit/SpeakerManager";
import LocationManager from "./LocationManager";
import MicrophoneManager from "./MicrophoneManager";
import PhotoManager from "./PhotoManager";
import SubscriptionManager from "./SubscriptionManager";
import { TranscriptionManager } from "./transcription/TranscriptionManager";
import { TranslationManager } from "./translation/TranslationManager";
import UdpAudioManager from "./UdpAudioManager";
import UnmanagedStreamingExtension from "./UnmanagedStreamingExtension";
import UserSettingsManager from "./UserSettingsManager";

export const LOG_PING_PONG = false; // Set to true to enable detailed ping/pong logging
/**
 * Complete user session class that encapsulates all session-related
 * functionality and state for the server.
 */
export class UserSession {
  // Static in-memory registry of sessions (replaces SessionStorage)
  private static sessions: Map<string, UserSession> = new Map();

  // Core identification
  public readonly userId: string;
  public readonly startTime: Date; // = new Date();
  public disconnectedAt: Date | null = null;

  // Logging
  public readonly logger: Logger;

  // WebSocket connection (supports both ws package and Bun's ServerWebSocket)
  public websocket: IWebSocket;

  // App state
  // NOTE: runningApps, loadingApps, and appWebsockets are now derived from AppManager/AppSession (Phase 4d)
  // They are exposed as getters for backward compatibility with existing code
  public installedApps: Map<string, AppI> = new Map();

  /**
   * Get running apps (derived from AppManager/AppSession)
   * @returns Set of package names for running apps
   */
  get runningApps(): Set<string> {
    return this.appManager.getRunningAppNames();
  }

  /**
   * Get loading/connecting apps (derived from AppManager/AppSession)
   * @returns Set of package names for apps currently connecting
   */
  get loadingApps(): Set<string> {
    return this.appManager.getLoadingAppNames();
  }

  /**
   * Get app WebSockets (derived from AppManager/AppSession)
   * @returns Map of packageName -> IWebSocket for connected apps
   */
  get appWebsockets(): Map<string, IWebSocket> {
    return this.appManager.getAllAppWebSockets();
  }

  // Transcription
  public isTranscribing = false; // TODO(isaiah): Sync with frontend to see if we can remove this property.
  public lastAudioTimestamp?: number;

  // Audio
  public bufferedAudio: Buffer[] = [];
  public recentAudioBuffer: Buffer[] = [];

  // Cleanup state
  // When disconnected, this will be set to a timer that will clean up the session after the grace period, if user does not reconnect.
  public cleanupTimerId?: NodeJS.Timeout;

  // Managers
  public displayManager: DisplayManager;
  public dashboardManager: DashboardManager;
  public microphoneManager: MicrophoneManager;
  public appManager: AppManager;
  public audioManager: AudioManager;
  public transcriptionManager: TranscriptionManager;
  public translationManager: TranslationManager;
  public subscriptionManager: SubscriptionManager;
  public liveKitManager: LiveKitManager;
  public speakerManager: SpeakerManager;
  public calendarManager: CalendarManager;
  public locationManager: LocationManager;
  public userSettingsManager: UserSettingsManager;
  public deviceManager: DeviceManager;
  public udpAudioManager: UdpAudioManager;

  public streamRegistry: StreamRegistry;
  public unmanagedStreamingExtension: UnmanagedStreamingExtension;
  public photoManager: PhotoManager;
  public managedStreamingExtension: ManagedStreamingExtension;

  // Resource tracking for automatic cleanup (prevents memory leaks)
  private resources = new ResourceTracker();
  private disposed = false;

  // Heartbeat for glasses connection
  private glassesHeartbeatInterval?: NodeJS.Timeout;
  private appLevelPingInterval?: NodeJS.Timeout;
  private pongHandler?: () => void; // Stored for cleanup
  private lastPongTime?: number;
  private pongTimeoutTimer?: NodeJS.Timeout;
  private readonly PONG_TIMEOUT_MS = 30000; // 30 seconds - 3x heartbeat interval

  // DISABLED: Cloudflare absorbs protocol-level ping/pong at the edge, so pongs from
  // the mobile client never reach Bun — they terminate at Cloudflare's edge. This causes
  // the timeout to fire on every idle connection after 30s, killing healthy connections.
  // Clients then take 3-7 minutes to detect the dead connection and reconnect, making
  // the cure worse than the disease. The server still sends pings and tracks lastPongTime
  // for observability — it just doesn't kill connections based on missing pongs.
  // See: cloud/issues/035-nginx-ws-timeout/spike.md
  private static readonly PONG_TIMEOUT_ENABLED = false;

  // Audio play request tracking - maps requestId to packageName
  public audioPlayRequestMapping: Map<string, string> = new Map();

  // App health status cache (for client apps API)
  public appHealthCache: Map<string, boolean> = new Map();

  // User's timezone (IANA name like "America/New_York")
  public userTimezone?: string;

  // LiveKit transport preference
  public livekitRequested?: boolean;

  // Capability Discovery

  // Current connected glasses model
  // public currentGlassesModel: string | null = null;

  constructor(userId: string, websocket: IWebSocket) {
    this.userId = userId;
    this.websocket = websocket;
    this.logger = rootLogger.child({ userId, service: "UserSession" });
    this.startTime = new Date();

    // Initialize managers
    this.appManager = new AppManager(this);
    this.audioManager = new AudioManager(this);
    this.dashboardManager = new DashboardManager(this);
    this.displayManager = new DisplayManager(this);
    // Initialize subscription manager BEFORE any manager that uses it
    this.subscriptionManager = new SubscriptionManager(this);
    this.microphoneManager = new MicrophoneManager(this);
    this.transcriptionManager = new TranscriptionManager(this);
    this.translationManager = new TranslationManager(this);
    this.calendarManager = new CalendarManager(this);
    this.locationManager = new LocationManager(this);
    this.photoManager = new PhotoManager(this);
    this.streamRegistry = new StreamRegistry(this.logger);
    this.unmanagedStreamingExtension = new UnmanagedStreamingExtension(this);
    this.managedStreamingExtension = new ManagedStreamingExtension(this.logger, this.streamRegistry);
    this.liveKitManager = new LiveKitManager(this);
    this.userSettingsManager = new UserSettingsManager(this);
    this.speakerManager = new SpeakerManager(this);
    this.deviceManager = new DeviceManager(this);
    this.udpAudioManager = new UdpAudioManager(this);

    // Set up heartbeat for glasses connection
    this.setupGlassesHeartbeat();

    // Register in static session map
    UserSession.sessions.set(userId, this);
    this.logger.info(`✅ User session created and registered for ${userId} (static map)`);

    // Register for leak detection
    memoryLeakDetector.register(this, `UserSession:${userId}`);
  }

  /**
   * Set up heartbeat for glasses WebSocket connection
   */
  private setupGlassesHeartbeat(): void {
    const HEARTBEAT_INTERVAL = 10000; // 10 seconds
    const APP_LEVEL_PING_INTERVAL = 2000; // 2 seconds

    // Clear any existing heartbeat
    this.clearGlassesHeartbeat();

    // Set up new heartbeat interval (protocol-level pings for server-side detection)
    this.glassesHeartbeatInterval = setInterval(() => {
      if (this.disposed) return; // Guard against stale callback
      if (this.websocket && this.websocket.readyState === WebSocketReadyState.OPEN) {
        this.websocket.ping?.();
        if (LOG_PING_PONG) {
          this.logger.debug(
            { ping: true },
            `[UserSession:heartbeat:ping] Sent ping to glasses for user ${this.userId}`,
          );
        }
      } else {
        // WebSocket is not open, clear the interval
        this.clearGlassesHeartbeat();
      }
    }, HEARTBEAT_INTERVAL);

    // Application-level pings — visible to the client's onmessage handler.
    // Protocol-level pings are invisible to React Native's WebSocket API,
    // so the client can't use them for liveness detection. These app-level
    // pings give the client guaranteed periodic messages to track against.
    this.appLevelPingInterval = setInterval(() => {
      if (this.disposed) return;
      if (this.websocket && this.websocket.readyState === WebSocketReadyState.OPEN) {
        try {
          this.websocket.send(JSON.stringify({ type: "ping" }));
        } catch (_e) {
          // Send failure will be caught by the connection close handler
        }
      }
    }, APP_LEVEL_PING_INTERVAL);

    this.resources.trackInterval(this.appLevelPingInterval);

    // Track interval for automatic cleanup
    this.resources.trackInterval(this.glassesHeartbeatInterval);

    // Set up pong handler with timeout detection
    // Store reference for proper cleanup (prevents memory leak)
    this.pongHandler = () => {
      if (this.disposed) return; // Guard against stale callback
      this.lastPongTime = Date.now();

      if (LOG_PING_PONG) {
        this.logger.debug(
          { pong: true },
          `[UserSession:heartbeat:pong] Received pong from glasses for user ${this.userId}`,
        );
      }

      // Reset the timeout timer only if enabled
      if (UserSession.PONG_TIMEOUT_ENABLED) {
        this.resetPongTimeout();
      }
    };

    // Only set up event-based pong handler for ws package (not Bun's ServerWebSocket)
    // Bun's pong handling is done in websocketHandlers.pong() which calls handleGlassesPong()
    if (hasEventEmitter(this.websocket)) {
      this.websocket.on("pong", this.pongHandler);

      // Track pong handler for cleanup (prevents memory leak)
      this.resources.track(() => {
        if (this.websocket && hasEventEmitter(this.websocket) && this.pongHandler) {
          this.websocket.off("pong", this.pongHandler);
        }
      });
    }

    // Initialize pong tracking
    this.lastPongTime = Date.now();

    // Only start timeout tracking if enabled
    if (UserSession.PONG_TIMEOUT_ENABLED) {
      this.resetPongTimeout();
    }

    this.logger.debug(`[UserSession:setupGlassesHeartbeat] Heartbeat established for glasses connection`);
  }

  /**
   * Clear heartbeat for glasses connection
   */
  private clearGlassesHeartbeat(): void {
    if (this.glassesHeartbeatInterval) {
      clearInterval(this.glassesHeartbeatInterval);
      this.glassesHeartbeatInterval = undefined;
      this.logger.debug(`[UserSession:clearGlassesHeartbeat] Heartbeat cleared for glasses connection`);
    }

    // Clear app-level ping interval
    if (this.appLevelPingInterval) {
      clearInterval(this.appLevelPingInterval);
      this.appLevelPingInterval = undefined;
    }

    // Clear pong timeout as well
    if (this.pongTimeoutTimer) {
      clearTimeout(this.pongTimeoutTimer);
      this.pongTimeoutTimer = undefined;
    }
  }

  /**
   * Handle pong response from glasses connection
   * Called by Bun WebSocket handler (websocketHandlers.pong)
   * For ws package, this is handled by the pongHandler event listener
   */
  public handlePong(): void {
    if (this.disposed) return;
    this.lastPongTime = Date.now();

    if (LOG_PING_PONG) {
      this.logger.debug(
        { pong: true },
        `[UserSession:heartbeat:pong] Received pong from glasses for user ${this.userId}`,
      );
    }

    // Reset the timeout timer only if enabled
    if (UserSession.PONG_TIMEOUT_ENABLED) {
      this.resetPongTimeout();
    }
  }

  /**
   * Reset the pong timeout timer
   */
  private resetPongTimeout(): void {
    // Skip if pong timeout is disabled
    if (!UserSession.PONG_TIMEOUT_ENABLED) {
      this.logger.debug("[UserSession:resetPongTimeout] Pong timeout disabled by PONG_TIMEOUT_ENABLED=false");
      return;
    }

    // Clear existing timer
    if (this.pongTimeoutTimer) {
      clearTimeout(this.pongTimeoutTimer);
    }

    // Set new timeout
    this.pongTimeoutTimer = setTimeout(() => {
      const timeSinceLastPong = this.lastPongTime ? Date.now() - this.lastPongTime : this.PONG_TIMEOUT_MS;

      this.logger.error(
        `[UserSession:pongTimeout] Phone connection timeout - no pong for ${timeSinceLastPong}ms from user ${this.userId}`,
      );

      // Close the zombie WebSocket connection
      if (this.websocket && this.websocket.readyState === WebSocketReadyState.OPEN) {
        this.logger.info(`[UserSession:pongTimeout] Closing zombie WebSocket connection for user ${this.userId}`);
        this.websocket.close(1001, "Ping timeout - no pong received");
      }
    }, this.PONG_TIMEOUT_MS);
  }

  /**
   * Update WebSocket connection and restart heartbeat
   * Called when glasses reconnect with a new WebSocket
   */
  updateWebSocket(newWebSocket: IWebSocket): void {
    this.logger.info(`[UserSession:updateWebSocket] Updating WebSocket connection for user ${this.userId}`);

    // Clear old heartbeat
    this.clearGlassesHeartbeat();

    // Update WebSocket reference
    this.websocket = newWebSocket;

    // Set up new heartbeat with the new WebSocket
    this.setupGlassesHeartbeat();

    this.logger.debug(`[UserSession:updateWebSocket] WebSocket and heartbeat updated for user ${this.userId}`);

    // CRITICAL: Force mic state resync after WebSocket reconnects
    // Without this, the phone may think mic is off while cloud has active subscriptions.
    // This fixes the bug where mic turns off after WebSocket reconnection because
    // MicrophoneManager tried to send state while WebSocket was closed, and never
    // retried after the WebSocket came back up.
    //
    // We add a small delay to ensure the WebSocket is fully established and ready
    // to receive messages before we send the mic state.
    if (this.microphoneManager) {
      this.logger.info(`[UserSession:updateWebSocket] Scheduling mic state resync after WebSocket reconnect`);
      setTimeout(() => {
        if (this.microphoneManager && this.websocket?.readyState === WebSocketReadyState.OPEN) {
          this.logger.info(`[UserSession:updateWebSocket] Forcing mic state resync after WebSocket reconnect`);
          this.microphoneManager.forceResync();
        } else {
          this.logger.warn(
            `[UserSession:updateWebSocket] Skipping mic resync - WebSocket not ready or manager disposed`,
          );
        }
      }, 100); // Small delay to ensure WebSocket is fully ready
    }
  }

  /**
   * Get capabilities with fallback to default model if none available
   */
  getCapabilities(): Capabilities | null {
    return this.deviceManager.getCapabilities();
  }

  /**
   * Get a user session by ID
   */
  static getById(userId: string): UserSession | undefined {
    return UserSession.sessions.get(userId);
  }

  /**
   * Get all active user sessions
   */
  static getAllSessions(): UserSession[] {
    return Array.from(UserSession.sessions.values());
  }

  /**
   * Create a new session or reconnect an existing one, updating websocket & timers.
   */
  static async createOrReconnect(
    ws: IWebSocket,
    userId: string,
  ): Promise<{ userSession: UserSession; reconnection: boolean }> {
    const existingSession = UserSession.getById(userId);
    if (existingSession) {
      existingSession.logger.info(
        `[UserSession:createOrReconnect] Existing session found for ${userId}, updating WebSocket`,
      );

      // Update WS and restart heartbeat
      existingSession.updateWebSocket(ws);

      // Clear disconnected state and cleanup timer if any
      existingSession.disconnectedAt = null;
      if (existingSession.cleanupTimerId) {
        clearTimeout(existingSession.cleanupTimerId);
        existingSession.cleanupTimerId = undefined;
      }

      return { userSession: existingSession, reconnection: true };
    }

    // Create a fresh session
    const userSession = new UserSession(userId, ws);

    // Wait for user settings to load before proceeding
    // This ensures CONNECTION_ACK sent to apps has correct settings, not defaults
    try {
      await userSession.userSettingsManager.waitForLoad();
    } catch (error) {
      userSession.logger.error({ error }, "Error waiting for user settings to load");
    }

    // Bootstrap installed apps
    try {
      const installedApps = await appService.getAllApps(userId);
      for (const app of installedApps) {
        userSession.installedApps.set(app.packageName, app);
      }
      userSession.logger.info(`Fetched ${installedApps.length} installed apps for user ${userId}`);
    } catch (error) {
      userSession.logger.error({ error }, `Error fetching apps for user ${userId}`);
    }

    return { userSession, reconnection: false };
  }

  /**
   * Transform session into client snapshot and refresh mic state based on subscriptions.
   * Mirrors SessionService.transformUserSessionForClient()
   */
  async snapshotForClient(): Promise<any> {
    try {
      const appSubscriptions: Record<string, string[]> = {};
      for (const packageName of this.runningApps) {
        appSubscriptions[packageName] = this.subscriptionManager.getAppSubscriptions(packageName);
      }

      const hasPCMTranscriptionSubscriptions = this.subscriptionManager.hasPCMTranscriptionSubscriptions();
      const requiresAudio = hasPCMTranscriptionSubscriptions.hasMedia;
      const requiredData = this.microphoneManager.calculateRequiredData(
        hasPCMTranscriptionSubscriptions.hasPCM,
        hasPCMTranscriptionSubscriptions.hasTranscription,
      );
      // Side-effect: update mic state to reflect current needs
      this.microphoneManager.updateState(requiresAudio, requiredData);

      const minimumTranscriptionLanguages = this.subscriptionManager.getMinimalLanguageSubscriptions();

      return {
        userId: this.userId,
        startTime: this.startTime,
        activeAppSessions: Array.from(this.runningApps),
        loadingApps: Array.from(this.loadingApps),
        appSubscriptions,
        requiresAudio,
        minimumTranscriptionLanguages,
        isTranscribing: this.isTranscribing || false,
      };
    } catch (error) {
      this.logger.error({ error }, `Error building client snapshot`);
      return {
        userId: this.userId,
        startTime: this.startTime,
        activeAppSessions: Array.from(this.runningApps),
        loadingApps: Array.from(this.loadingApps),
        isTranscribing: this.isTranscribing || false,
      };
    }
  }

  /**
   * Relay data message to subscribed apps
   */
  relayMessageToApps(data: any): void {
    try {
      const subscribedPackageNames = this.subscriptionManager.getSubscribedApps(data.type as any);
      if (subscribedPackageNames.length === 0) return;

      this.logger.debug(
        { data },
        `Relaying ${data.type} to ${subscribedPackageNames.length} Apps for user ${this.userId}`,
      );
      for (const packageName of subscribedPackageNames) {
        const connection = this.appWebsockets.get(packageName);
        if (connection && connection.readyState === WebSocketReadyState.OPEN) {
          const appSessionId = `${this.sessionId}-${packageName}`;
          const dataStream = {
            type: CloudToAppMessageType.DATA_STREAM,
            sessionId: appSessionId,
            streamType: data.type,
            data,
            timestamp: new Date(),
          } as any;
          try {
            connection.send(JSON.stringify(dataStream));
          } catch (sendError) {
            this.logger.error(
              { error: sendError, packageName, data },
              `Error sending streamType: ${data.type} to ${packageName}`,
            );
          }
        }
      }
    } catch (error) {
      this.logger.error({ error, data }, `Error relaying ${data?.type}`);
    }
  }

  /**
   * Relay binary audio data to apps via AudioManager
   */
  relayAudioToApps(audioData: ArrayBuffer): void {
    try {
      this.audioManager.processAudioData(audioData);
    } catch (error) {
      this.logger.error({ error }, `Error relaying audio for user: ${this.userId}`);
    }
  }

  /**
   * Relay AUDIO_PLAY_RESPONSE to the app that initiated the request
   */
  relayAudioPlayResponseToApp(audioResponse: any): void {
    try {
      const requestId = audioResponse.requestId;
      if (!requestId) {
        this.logger.error({ audioResponse }, "Audio play response missing requestId");
        return;
      }
      const packageName = this.audioPlayRequestMapping.get(requestId);
      if (!packageName) {
        this.logger.warn(
          `🔊 [UserSession] No app mapping found for audio request ${requestId}. Available: ${Array.from(
            this.audioPlayRequestMapping.keys(),
          ).join(", ")}`,
        );
        return;
      }
      const appWebSocket = this.appWebsockets.get(packageName);
      if (!appWebSocket || appWebSocket.readyState !== WebSocketReadyState.OPEN) {
        this.logger.warn(
          `🔊 [UserSession] App ${packageName} not connected or WebSocket not ready for audio response ${requestId}`,
        );
        this.audioPlayRequestMapping.delete(requestId);
        return;
      }
      const appAudioResponse = {
        type: CloudToAppMessageType.AUDIO_PLAY_RESPONSE,
        sessionId: `${this.sessionId}-${packageName}`,
        requestId,
        success: audioResponse.success,
        error: audioResponse.error,
        duration: audioResponse.duration,
        timestamp: new Date(),
      } as any;
      try {
        appWebSocket.send(JSON.stringify(appAudioResponse));
        this.logger.info(`🔊 [UserSession] Successfully sent audio play response ${requestId} to app ${packageName}`);
      } catch (sendError) {
        this.logger.error(
          sendError,
          `🔊 [UserSession] Error sending audio response ${requestId} to app ${packageName}:`,
        );
      }
      this.audioPlayRequestMapping.delete(requestId);
      this.logger.debug(
        `🔊 [UserSession] Cleaned up audio request mapping for ${requestId}. Remaining: ${this.audioPlayRequestMapping.size}`,
      );
    } catch (error) {
      this.logger.error({ error, audioResponse }, `Error relaying audio play response`);
    }
  }

  /**
   * Handle incoming glasses message by routing to appropriate managers
   *
   * This method centralizes message routing that was previously in websocket-glasses.service.ts.
   * It delegates to the appropriate manager based on message type, making the logic
   * testable without requiring a WebSocket connection.
   *
   * @param message The glasses message to handle
   */
  async handleGlassesMessage(message: GlassesToCloudMessage): Promise<void> {
    await glassesMessageHandler(this, message);
  }

  /**
   * Handle incoming app message by routing to appropriate managers
   *
   * This method centralizes message routing that was previously in websocket-app.service.ts.
   * It delegates to the appropriate manager based on message type, making the logic
   * testable without requiring a WebSocket connection.
   *
   * @param appWebsocket The app's WebSocket connection
   * @param message The app message to handle
   */
  async handleAppMessage(appWebsocket: WebSocket, message: AppToCloudMessage): Promise<void> {
    await appMessageHandler(appWebsocket, this, message);
  }

  /**
   * Send error message to glasses
   *
   * @param message Error message
   * @param code Error code
   */
  public sendError(message: string, code: string): void {
    try {
      const errorMessage: ConnectionError = {
        type: CloudToGlassesMessageType.CONNECTION_ERROR,
        code: code,
        message,
        timestamp: new Date(),
      };

      this.websocket.send(JSON.stringify(errorMessage));
      // this.websocket.close(1008, message);
    } catch (error) {
      this.logger.error(error, "Error sending error message to glasses:");

      // try {
      //   this.websocket.close(1011, 'Internal server error');
      // } catch (closeError) {
      //   this.logger.error('Error closing WebSocket connection:', closeError);
      // }
    }
  }

  /**
   * Dispose of all resources and remove from sessions map
   */
  async dispose(): Promise<void> {
    // Idempotent - can be called multiple times safely
    if (this.disposed) {
      this.logger.debug(`[UserSession:dispose]: Already disposed, skipping: ${this.userId}`);
      return;
    }

    // Set disposed flag FIRST to prevent any new operations
    this.disposed = true;

    this.logger.warn(`[UserSession:dispose]: Disposing UserSession: ${this.userId}`);

    // Clean up all tracked resources (removes event listeners, clears timers)
    // This must happen BEFORE disposing managers to prevent stale callbacks
    this.resources.dispose();

    // Log to posthog disconnected duration.
    const now = new Date();
    const duration = now.getTime() - this.startTime.getTime();
    this.logger.info({ duration }, `User session ${this.userId} disconnected. Connected for ${duration}ms`);
    try {
      await PosthogService.trackEvent("disconnected", this.userId, {
        duration: duration,
        userId: this.userId,
        sessionId: this.userId,
        disconnectedAt: now.toISOString(),
        startTime: this.startTime.toISOString(),
      });
    } catch (error) {
      this.logger.error(error, "Error tracking disconnected event:");
    }

    // Clean up all resources
    if (this.appManager) this.appManager.dispose();
    if (this.audioManager) this.audioManager.dispose();
    if (this.liveKitManager) this.liveKitManager.dispose();
    if (this.microphoneManager) this.microphoneManager.dispose();
    if (this.displayManager) this.displayManager.dispose();
    if (this.dashboardManager) this.dashboardManager.dispose();
    if (this.transcriptionManager) this.transcriptionManager.dispose();
    if (this.translationManager) this.translationManager.dispose();
    if (this.subscriptionManager) this.subscriptionManager.dispose();
    // if (this.heartbeatManager) this.heartbeatManager.dispose();
    if (this.unmanagedStreamingExtension) this.unmanagedStreamingExtension.dispose();
    if (this.photoManager) this.photoManager.dispose();
    if (this.managedStreamingExtension) this.managedStreamingExtension.dispose();

    // Persist location to DB cold cache and clean up
    if (this.locationManager) await this.locationManager.dispose();

    // Clear glasses heartbeat (timers already cleared by resources.dispose(), but clear references)
    this.clearGlassesHeartbeat();

    // Clear any timers
    if (this.cleanupTimerId) {
      clearTimeout(this.cleanupTimerId);
      this.cleanupTimerId = undefined;
    }

    // Clear collections
    // Note: runningApps, loadingApps, appWebsockets are now derived from AppManager/AppSession (Phase 4d)
    // They are cleared when appManager.dispose() is called above
    this.bufferedAudio = [];
    this.recentAudioBuffer = [];

    // Clear audio play request mappings
    this.audioPlayRequestMapping.clear();

    // Dispose UDP audio manager
    if (this.udpAudioManager) this.udpAudioManager.dispose();

    // Remove from static session map
    UserSession.sessions.delete(this.userId);

    this.logger.info(
      {
        disposalReason: this.disconnectedAt ? "grace_period_timeout" : "explicit_disposal",
      },
      `🗑️ Session disposed and removed from storage for ${this.userId}`,
    );

    // Mark disposed for leak detection
    memoryLeakDetector.markDisposed(`UserSession:${this.userId}`);
  }

  /**
   * Get the session ID (for backward compatibility)
   */
  get sessionId(): string {
    return this.userId;
  }
}

export default UserSession;
