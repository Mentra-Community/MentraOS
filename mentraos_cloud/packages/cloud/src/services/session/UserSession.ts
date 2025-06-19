/**
 * @fileoverview UserSession class that encapsulates all session-related
 * functionality and state for the server.
 */

import { Logger } from 'pino';
import WebSocket from 'ws';
import { AppI, CloudToGlassesMessageType, ConnectionError, TranscriptSegment } from '@augmentos/sdk';
import { logger as rootLogger } from '../logging/pino-logger';
import AppManager from './AppManager';
import AudioManager from './AudioManager';
import MicrophoneManager from './MicrophoneManager';
import DisplayManager from '../layout/DisplayManager6.1';
import { DashboardManager } from '../dashboard';
// import { HeartbeatManager } from './HeartbeatManager';
import { ASRStreamInstance } from '../processing/transcription.service';
import VideoManager from './VideoManager';
import PhotoManager from './PhotoManager';
import { GlassesErrorCode } from '../websocket/websocket-glasses.service';
import SessionStorage from './SessionStorage';

export const LOG_PING_PONG = false; // Set to true to enable detailed ping/pong logging
/**
 * Complete user session class that encapsulates all session-related
 * functionality and state for the server.
 */
export class UserSession {

  // Core identification
  public readonly userId: string;
  public readonly startTime: Date = new Date();
  public disconnectedAt: Date | null = null;

  // Logging
  public readonly logger: Logger;

  // WebSocket connection
  public websocket: WebSocket;

  // App state
  public installedApps: Map<string, AppI> = new Map();
  public runningApps: Set<string> = new Set();
  public loadingApps: Set<string> = new Set();
  public appWebsockets: Map<string, WebSocket> = new Map();

  // Transcription
  public isTranscribing: boolean = false;
  public transcript: { segments: TranscriptSegment[]; languageSegments: Map<string, TranscriptSegment[]>; }
    = { segments: [], languageSegments: new Map() };
  public transcriptionStreams: Map<string, ASRStreamInstance> = new Map();
  public lastAudioTimestamp?: number;

  // Audio
  public bufferedAudio: ArrayBufferLike[] = [];
  public recentAudioBuffer: { data: ArrayBufferLike; timestamp: number }[] = [];

  // Cleanup state
  // When disconnected, this will be set to a timer that will clean up the session after the grace period, if user does not reconnect.
  public cleanupTimerId?: NodeJS.Timeout;

  // Managers
  public displayManager: DisplayManager;
  public dashboardManager: DashboardManager;
  public microphoneManager: MicrophoneManager;
  public appManager: AppManager;
  public audioManager: AudioManager;

  public videoManager: VideoManager;
  public photoManager: PhotoManager;

  // Reconnection
  public _reconnectionTimers: Map<string, NodeJS.Timeout>;

  // Heartbeat for glasses connection
  private glassesHeartbeatInterval?: NodeJS.Timeout;

  // Other state
  public userDatetime?: string;

  constructor(userId: string, websocket: WebSocket) {
    this.userId = userId;
    this.websocket = websocket;
    this.logger = rootLogger.child({ userId, service: 'UserSession' });

    // Initialize managers
    this.appManager = new AppManager(this);
    this.audioManager = new AudioManager(this);
    this.dashboardManager = new DashboardManager(this);
    this.displayManager = new DisplayManager(this);
    this.microphoneManager = new MicrophoneManager(this);
    this.photoManager = new PhotoManager(this);
    this.videoManager = new VideoManager(this);

    this._reconnectionTimers = new Map();

    // Set up heartbeat for glasses connection
    this.setupGlassesHeartbeat();

    // Register in session storage
    SessionStorage.getInstance().set(userId, this);
    this.logger.info(`✅ User session created and registered for ${userId}`);
  }

  /**
   * Set up heartbeat for glasses WebSocket connection
   */
  private setupGlassesHeartbeat(): void {
    const HEARTBEAT_INTERVAL = 10000; // 10 seconds

    // Clear any existing heartbeat
    this.clearGlassesHeartbeat();

    // Set up new heartbeat
    this.glassesHeartbeatInterval = setInterval(() => {
      if (this.websocket && this.websocket.readyState === WebSocket.OPEN) {
        this.websocket.ping();
        if (LOG_PING_PONG) {
          this.logger.debug({ ping: true }, `[UserSession:heartbeat:ping] Sent ping to glasses for user ${this.userId}`);
        }
      } else {
        // WebSocket is not open, clear the interval
        this.clearGlassesHeartbeat();
      }
    }, HEARTBEAT_INTERVAL);

    // Set up pong handler
    this.websocket.on('pong', () => {
      if (LOG_PING_PONG) {
        this.logger.debug({ pong: true }, `[UserSession:heartbeat:pong] Received pong from glasses for user ${this.userId}`);
      }
    });

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
  }

  /**
   * Update WebSocket connection and restart heartbeat
   * Called when glasses reconnect with a new WebSocket
   */
  updateWebSocket(newWebSocket: WebSocket): void {
    this.logger.info(`[UserSession:updateWebSocket] Updating WebSocket connection for user ${this.userId}`);

    // Clear old heartbeat
    this.clearGlassesHeartbeat();

    // Update WebSocket reference
    this.websocket = newWebSocket;

    // Set up new heartbeat with the new WebSocket
    this.setupGlassesHeartbeat();

    this.logger.debug(`[UserSession:updateWebSocket] WebSocket and heartbeat updated for user ${this.userId}`);
  }

  /**
   * Get a user session by ID
   */
  static getById(userId: string): UserSession | undefined {
    return SessionStorage.getInstance().get(userId);
  }

  /**
   * Get all active user sessions
   */
  static getAllSessions(): UserSession[] {
    return SessionStorage.getInstance().getAllSessions();
  }

  /**
   * Transform session data for client consumption
   */
  async toClientFormat(): Promise<any> {
    // Return only what the client needs
    return {
      userId: this.userId,
      startTime: this.startTime,
      activeAppSessions: Array.from(this.runningApps),
      loadingApps: Array.from(this.loadingApps),
      isTranscribing: this.isTranscribing,
      // Other client-relevant data
    };
  }

  /**
   * Send error message to glasses
   * 
   * @param message Error message
   * @param code Error code
   */
  public sendError(message: string, code: GlassesErrorCode,): void {
    try {
      const errorMessage: ConnectionError = {
        type: CloudToGlassesMessageType.CONNECTION_ERROR,
        code: code,
        message,
        timestamp: new Date()
      };

      this.websocket.send(JSON.stringify(errorMessage));
      // this.websocket.close(1008, message);
    } catch (error) {
      this.logger.error('Error sending error message to glasses:', error);

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
  dispose(): void {
    this.logger.warn(`[UserSession:dispose]: Disposing UserSession: ${this.userId}`);

    // Clean up all resources
    if (this.appManager) this.appManager.dispose();
    if (this.audioManager) this.audioManager.dispose();
    if (this.microphoneManager) this.microphoneManager.dispose();
    if (this.displayManager) this.displayManager.dispose();
    if (this.dashboardManager) this.dashboardManager.dispose();
    // if (this.heartbeatManager) this.heartbeatManager.dispose();
    if (this.videoManager) this.videoManager.dispose();
    if (this.photoManager) this.photoManager.dispose();

    // Clear glasses heartbeat
    this.clearGlassesHeartbeat();

    // Clear any timers
    if (this.cleanupTimerId) {
      clearTimeout(this.cleanupTimerId);
      this.cleanupTimerId = undefined;
    }

    if (this._reconnectionTimers) {
      for (const timer of this._reconnectionTimers.values()) {
        clearTimeout(timer);
      }
      this._reconnectionTimers.clear();
    }

    // Clear collections
    this.appWebsockets.clear();
    this.runningApps.clear();
    this.loadingApps.clear();
    this.bufferedAudio = [];
    this.recentAudioBuffer = [];

    // Remove from session storage
    SessionStorage.getInstance().delete(this.userId);

    this.logger.info({
      disposalReason: this.disconnectedAt ? 'grace_period_timeout' : 'explicit_disposal'
    }, `🗑️ Session disposed and removed from storage for ${this.userId}`);
  }


  /**
   * Get the session ID (for backward compatibility)
   */
  get sessionId(): string {
    return this.userId;
  }
}

export default UserSession;