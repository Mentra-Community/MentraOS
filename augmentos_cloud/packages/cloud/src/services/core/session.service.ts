import { WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import {
  AppStateChange,
  CloudToGlassesMessageType,
  ExtendedStreamType,
  StreamType,
  UserSession,
  TranscriptSegment,
  DisplayRequest,
  AppI, // Import if needed for installedApps type
} from '@augmentos/sdk';
import appService from './app.service';
import transcriptionService, { ASRStreamInstance } from '../processing/transcription.service';
import DisplayManager from '../layout/DisplayManager6.1';
import { createLC3Service, LC3Service, createLoggerForUserSession } from '@augmentos/utils';
import { AudioWriter } from "../debug/audio-writer";
import { systemApps } from './system-apps';
import { SubscriptionManager } from './subscription.manager'; // Import the new manager
// import { Logger } from 'winston';
import { DebugService } from '../debug/debug-service';
import { User } from '../../models/user.model';
import { HeartbeatManager } from './HeartbeatManager';
import { logger as rootLogger } from '../logging/pino-logger';
import { Logger } from 'pino';

const RECONNECT_GRACE_PERIOD_MS = 1000 * 30; // 30 seconds
const LOG_AUDIO = false;
const DEBUG_AUDIO = false;
export const IS_LC3 = false;
const logger = rootLogger.child({ module: 'session.service' });

logger.info("🔈🔈🔈🔈🔈🔈🔈🔈 IS_LC3", IS_LC3);

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

// --- Interfaces ---
export interface SequencedAudioChunk {
  sequenceNumber: number;
  timestamp: number;
  data: ArrayBufferLike;
  isLC3: boolean;
  receivedAt: number;
}

export interface OrderedAudioBuffer {
  chunks: SequencedAudioChunk[];
  lastProcessedSequence: number;
  processingInProgress: boolean;
  expectedNextSequence: number;
  bufferSizeLimit: number;
  bufferTimeWindowMs: number;
  bufferProcessingInterval: NodeJS.Timeout | null; // Allow null initially
}

export interface ExtendedUserSession extends UserSession {
  logger: Logger;
  lc3Service?: LC3Service;
  audioWriter?: AudioWriter;
  audioBuffer?: OrderedAudioBuffer;
  disconnectedAt: Date | null;
  cleanupTimerId?: NodeJS.Timeout;
  websocket: WebSocket;
  displayManager: DisplayManager;
  // Add dashboard manager to the user session
  dashboardManager: any; // Will import and use proper type later to avoid circular dependencies
  transcript: { 
    segments: TranscriptSegment[];  // For backward compatibility (English)
    languageSegments?: Map<string, TranscriptSegment[]>; // Language-indexed map for multi-language support
  };
  bufferedAudio: ArrayBufferLike[]; // More specific type
  lastAudioTimestamp?: number;
  recognizer?: any; // Define type from MS SDK if possible
  transcriptionStreams: Map<string, ASRStreamInstance>;
  isTranscribing: boolean;
  loadingApps: Set<string>;
  appConnections: Map<string, WebSocket | any>; // Consider stricter type if possible
  installedApps: AppI[]; // Add type from SDK

  // Add the subscription manager instance
  subscriptionManager: SubscriptionManager;
  // Add the heartbeat manager instance
  heartbeatManager: HeartbeatManager;
  // Map to track reconnection timers
  _reconnectionTimers?: Map<string, NodeJS.Timeout>;
  recentAudioBuffer: { data: ArrayBufferLike; timestamp: number }[]; // Buffer for last 10 seconds of audio

  // Custom user data
  userDatetime?: string;
}

export class SessionService {
  private activeSessions = new Map<string, ExtendedUserSession>();
  private sessionsByUser = new Map<string, ExtendedUserSession>();
  private debugService: DebugService;

  constructor(debugService: DebugService) {
    this.debugService = debugService;
  }

  async createSession(ws: WebSocket, userId: string): Promise<ExtendedUserSession> {
    const existingSession = this.sessionsByUser.get(userId);

    if (existingSession) {
      existingSession.logger.info(`Reusing existing UserSession for user ${userId}`);

      if (existingSession.cleanupTimerId) {
        clearTimeout(existingSession.cleanupTimerId);
        existingSession.logger.info(`[session.service]: Cleared pending cleanup timer for reused session ${existingSession.sessionId}`);
        existingSession.cleanupTimerId = undefined;
      }

      existingSession.websocket = ws; // Update WebSocket reference
      existingSession.disconnectedAt = null;
      existingSession.isTranscribing = false;

      this.activeSessions.set(existingSession.sessionId, existingSession);
      existingSession.logger.info(`Re-activated session ${existingSession.sessionId} in activeSessions map.`);

      // Ensure installedApps are fresh if reusing
      existingSession.installedApps = await appService.getAllApps(userId);

      // Notify debug service of session reconnection
      this.debugService.sessionConnected(existingSession.sessionId, {
        sessionId: existingSession.sessionId,
        userId: existingSession.userId,
        startTime: existingSession.startTime.toISOString(),
        disconnectedAt: null,
        activeAppSessions: existingSession.activeAppSessions,
        installedApps: existingSession.installedApps,
        loadingApps: existingSession.loadingApps,
        isTranscribing: existingSession.isTranscribing,
        transcript: existingSession.transcript,
        subscriptionManager: {
          subscriptions: Object.fromEntries(Array.from(existingSession.subscriptionManager.getAllSubscriptions()).map(([k, v]) => [k, Array.from(v)]))
        },
        displayManager: existingSession.displayManager,
        dashboardManager: existingSession.dashboardManager,
        appConnections: Object.fromEntries(Array.from(existingSession.appConnections.entries()).map(([k, v]) => [k, { readyState: v.readyState }])),
        lastAudioTimestamp: existingSession.lastAudioTimestamp,
        transcriptionStreams: Object.fromEntries(Array.from(existingSession.transcriptionStreams.entries()).map(([k, v]) => [k, { status: 'active', language: k }])),
        audioBuffer: existingSession.audioBuffer,
        lc3Service: existingSession.lc3Service ? {
          initialized: true,
          status: 'active'
        } : null,
        recentEvents: []
      });

      return existingSession;
    }

    // Create new session
    const sessionId = userId;
    // const sessionLogger = createLoggerForUserSession(sessionId);
    const sessionLogger = rootLogger.child({ userId });
    const installedApps = await appService.getAllApps(userId); // Fetch apps first
    sessionLogger.info(`Fetched installed apps for user ${userId}:`, installedApps);

    // Create partial session first to pass to manager constructor
    const partialSession: Partial<ExtendedUserSession> = {
      logger: sessionLogger,
      sessionId,
      userId,
      startTime: new Date(),
      activeAppSessions: [],
      installedApps: installedApps, // Assign fetched apps
      transcriptionStreams: new Map<string, ASRStreamInstance>(),
      loadingApps: new Set<string>(),
      appConnections: new Map<string, WebSocket | any>(),
      displayManager: {} as any, // Will set after full session init
      // Will add dashboardManager after the session is fully constructed
      transcript: { 
        segments: [],
        languageSegments: new Map<string, TranscriptSegment[]>() 
      },
      websocket: ws,
      bufferedAudio: [],
      disconnectedAt: null,
      isTranscribing: false,
      recentAudioBuffer: [], // Initialize the recent audio buffer

      audioBuffer: {
        chunks: [],
        lastProcessedSequence: -1,
        processingInProgress: false,
        expectedNextSequence: 0,
        bufferSizeLimit: 100,
        bufferTimeWindowMs: 500,
        bufferProcessingInterval: null // Interval set by WebSocketService on connection
      }
    };

    // Instantiate the Subscription Manager for this session
    // Cast to ExtendedUserSession here is safe as we're building it
    partialSession.subscriptionManager = new SubscriptionManager(partialSession as ExtendedUserSession);
    sessionLogger.info(`[session.service] SubscriptionManager created for session ${sessionId}`);
    
    // Instantiate the Heartbeat Manager for this session
    partialSession.heartbeatManager = new HeartbeatManager(partialSession as ExtendedUserSession);
    sessionLogger.info(`[session.service] HeartbeatManager created for session ${sessionId}`);

    // Initialize LC3 and Audio Buffer
    const lc3ServiceInstance = createLC3Service(sessionId);
    try {
      await lc3ServiceInstance.initialize();
      partialSession.lc3Service = lc3ServiceInstance;
      sessionLogger.info(`✅ LC3 Service initialized for session ${sessionId}`);
    } catch (error) {
      sessionLogger.error(`❌ Failed to initialize LC3 service for session ${sessionId}:`, error);
    }

    // Finalize the user session
    const userSession = partialSession as ExtendedUserSession;

    // Now set up the DisplayManager
    const DisplayManager = require('../layout/DisplayManager6.1').default;
    userSession.displayManager = new DisplayManager(userSession);

    // Now create the DashboardManager for this session
    // We need to dynamically import to avoid circular dependency issues
    const { DashboardManager } = require('../dashboard/DashboardManager');
    userSession.dashboardManager = new DashboardManager(userSession, {
      queueSize: 5,
      updateIntervalMs: 500,
      alwaysOnEnabled: false
    });

    // Store the session
    this.activeSessions.set(sessionId, userSession);
    this.sessionsByUser.set(userId, userSession);
    sessionLogger.info(`[session.service] Created and stored new session ${sessionId} for user ${userId}`);

    // Notify debug service of new session
    this.debugService.sessionConnected(sessionId, {
      sessionId: userSession.sessionId,
      userId: userSession.userId,
      startTime: userSession.startTime.toISOString(),
      disconnectedAt: null,
      activeAppSessions: userSession.activeAppSessions,
      installedApps: userSession.installedApps,
      loadingApps: userSession.loadingApps,
      isTranscribing: userSession.isTranscribing,
      transcript: userSession.transcript,
      subscriptionManager: {
        subscriptions: {}
      },
      displayManager: userSession.displayManager,
      dashboardManager: userSession.dashboardManager,
      appConnections: {},
      lastAudioTimestamp: userSession.lastAudioTimestamp,
      transcriptionStreams: {},
      audioBuffer: userSession.audioBuffer,
      lc3Service: userSession.lc3Service ? {
        initialized: true,
        status: 'active'
      } : null,
      recentEvents: []
    });

    return userSession;
  }


  getSession(sessionId: string): ExtendedUserSession | null {
    return this.activeSessions.get(sessionId) || null;
  }

  async transformUserSessionForClient(userSession: ExtendedUserSession): Promise<Partial<UserSession>> {
    const activeAppPackageNames = Array.from(new Set(userSession.activeAppSessions));
    const appSubscriptionsMap = new Map<string, ExtendedStreamType[]>();
    const whatToStreamSet = new Set<ExtendedStreamType>();

    const allSubs = userSession.subscriptionManager.getAllSubscriptions();

    for (const packageName of activeAppPackageNames) {
      const subs = allSubs.get(packageName) || [];
      appSubscriptionsMap.set(packageName, subs);
      subs.forEach(sub => whatToStreamSet.add(sub));
    }

    const dashboardPackageName = systemApps.dashboard.packageName;
    const dashboardSubs = allSubs.get(dashboardPackageName) || [];
    if (dashboardSubs.length > 0 || userSession.appConnections.has(dashboardPackageName)) {
      appSubscriptionsMap.set(dashboardPackageName, dashboardSubs);
      dashboardSubs.forEach(sub => whatToStreamSet.add(sub));
      if (!activeAppPackageNames.includes(dashboardPackageName)) {
        activeAppPackageNames.push(dashboardPackageName);
      }
    }

    const partialUserSession = {
      sessionId: userSession.sessionId,
      userId: userSession.userId,
      startTime: userSession.startTime,
      installedApps: userSession.installedApps, // Use already fetched apps
      appSubscriptions: Object.fromEntries(appSubscriptionsMap),
      activeAppPackageNames: Array.from(new Set(activeAppPackageNames)),
      whatToStream: Array.from(whatToStreamSet),
    };

    return partialUserSession;
  }

  async triggerAppStateChange(userId: string): Promise<void> {
    const userSession = this.getSessionByUserId(userId);
    if (!userSession) {
      logger.error(`❌[${userId}]: No userSession found for client app state change`);
      return;
    }

    if (!userSession.websocket || userSession.websocket.readyState !== WebSocket.OPEN) {
      userSession.logger.error(`❌[${userId}]: Websocket is not open for client app state change`);
      return;
    }

    try {
      // Fetch installed apps (they may have potentially changed).
      const installedApps = await appService.getAllApps(userSession.userId); // Fetch apps first.
      userSession.installedApps = installedApps; // Update installed apps in the session.
      userSession.logger.info(`Updated installed apps for ${userId}:`, installedApps);

      const clientResponse: AppStateChange = {
        type: CloudToGlassesMessageType.APP_STATE_CHANGE,
        sessionId: userSession.sessionId,
        userSession: await this.transformUserSessionForClient(userSession),
        timestamp: new Date()
      };
      userSession.websocket.send(JSON.stringify(clientResponse));
      userSession.logger.info(`[session.service] Sent APP_STATE_CHANGE to ${userId}`);
    } catch (error) {
      userSession.logger.error(`[session.service] Error sending APP_STATE_CHANGE:`, error);
    }
  }

  updateDisplay(userSessionId: string, displayRequest: DisplayRequest): void {
    const userSession = this.getSession(userSessionId);
    if (!userSession) {
      logger.error(`❌[${userSessionId}]: No userSession found for display update`);
      return;
    }
    try {
      userSession.displayManager.handleDisplayEvent(displayRequest, userSession);
    } catch (error) {
      userSession.logger.error(`❌[${userSessionId}]: Error updating display:`, error);
    }
  }

  addTranscriptSegment(userSession: ExtendedUserSession, segment: TranscriptSegment, language: string = 'en-US'): void {
    if (!userSession || !userSession.transcript) return;
    
    // Initialize languageSegments if not exists
    if (!userSession.transcript.languageSegments) {
      userSession.transcript.languageSegments = new Map<string, TranscriptSegment[]>();
    }
    
    // Ensure the language entry exists in the map
    if (!userSession.transcript.languageSegments.has(language)) {
      userSession.transcript.languageSegments.set(language, []);
    }
    
    // Get the current segments for this language
    const languageSpecificSegments = userSession.transcript.languageSegments.get(language)!;
    
    // Add the segment
    languageSpecificSegments.push(segment);
    
    // For backward compatibility, also add to segments array if it's English
    if (language === 'en-US') {
      userSession.transcript.segments.push(segment);
    }
    
    // Prune old segments (older than 30 minutes)
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
    
    // Clean up the language-specific segments
    userSession.transcript.languageSegments.set(
      language,
      languageSpecificSegments.filter(seg => seg.timestamp && new Date(seg.timestamp) >= thirtyMinutesAgo)
    );
    
    // Clean up the legacy segments array for backward compatibility
    if (language === 'en-US') {
      userSession.transcript.segments = userSession.transcript.segments.filter(
        seg => seg.timestamp && new Date(seg.timestamp) >= thirtyMinutesAgo
      );
    }
  }

  // Updated handleAudioData method with improved LC3 handling
  async handleAudioData(userSession: ExtendedUserSession, audioData: ArrayBuffer | any, isLC3 = IS_LC3): Promise<ArrayBuffer | void> {
    // Update the last audio timestamp
    userSession.lastAudioTimestamp = Date.now();

    // --- Maintain recentAudioBuffer for last 10 seconds ---
    if (audioData && userSession.recentAudioBuffer) {
      const now = Date.now();
      // Store the chunk with its timestamp
      userSession.recentAudioBuffer.push({ data: audioData, timestamp: now });
      // Prune to keep only the last 10 seconds
      const tenSecondsAgo = now - 10_000;
      userSession.recentAudioBuffer = userSession.recentAudioBuffer.filter(chunk => chunk.timestamp >= tenSecondsAgo);
    }

    // Lazy initialize the audio writer if it doesn't exist
    if (DEBUG_AUDIO && !userSession.audioWriter) {
      userSession.audioWriter = new AudioWriter(userSession.userId);
    }

    // Write the raw LC3 audio if applicable
    if (DEBUG_AUDIO && isLC3 && audioData) {
      await userSession.audioWriter?.writeLC3(audioData);
    }

    // Process LC3 first if needed
    let processedAudioData = audioData;
    if (isLC3 && userSession.lc3Service) {
      try {
        // The improved LC3Service handles null checks internally
        processedAudioData = await userSession.lc3Service.decodeAudioChunk(audioData);

        if (!processedAudioData) {
          if (LOG_AUDIO) userSession.logger.warn(`⚠️ LC3 decode returned null for session ${userSession.sessionId}`);
          return; // Skip this chunk
        }

        if (DEBUG_AUDIO) {
          // Write the decoded PCM audio
          await userSession.audioWriter?.writePCM(processedAudioData);
        }
      } catch (error) {
        userSession.logger.error(`❌ Error decoding LC3 audio for session ${userSession.sessionId}:`, error);

        // If there was an error with the LC3 service, try to reinitialize it
        if (userSession.lc3Service) {
          userSession.logger.warn(`⚠️ Attempting to reinitialize LC3 service for session ${userSession.sessionId}`);
          try {
            // Clean up existing service
            userSession.lc3Service.cleanup();

            // Create a new service
            const newLc3Service = createLC3Service(userSession.sessionId);
            await newLc3Service.initialize();
            userSession.lc3Service = newLc3Service;
            userSession.logger.info(`✅ Successfully reinitialized LC3 service for session ${userSession.sessionId}`);
          } catch (reinitError) {
            userSession.logger.error(`❌ Failed to reinitialize LC3 service:`, reinitError);
          }
        }

        return; // Skip this chunk after an error
      }
    } else if (processedAudioData) {
      if (DEBUG_AUDIO) {
        // If it's not LC3 or doesn't need decoding, still write it as PCM
        await userSession.audioWriter?.writePCM(processedAudioData);
      }
    }

    transcriptionService.feedAudioToTranscriptionStreams(userSession, processedAudioData);
    return processedAudioData;
  }


  // async handleAudioData(
  //   userSession: ExtendedUserSession,
  //   audioData: ArrayBufferLike | any,
  //   isLC3 = IS_LC3,
  //   sequenceNumber?: number
  // ): Promise<ArrayBuffer | void> {
  //   userSession.lastAudioTimestamp = Date.now();

  //   if (LOG_AUDIO && sequenceNumber !== undefined) {
  //     userSession.logger.debug(`Processing audio chunk ${sequenceNumber}`);
  //   }

  //   if (DEBUG_AUDIO && !userSession.audioWriter) {
  //     userSession.audioWriter = new AudioWriter(userSession.userId);
  //   }
  //   // if (DEBUG_AUDIO && isLC3 && audioData) {
  //   //   await userSession.audioWriter?.writeLC3(audioData);
  //   // }

  //   let processedAudioData = audioData;
  //   // if (isLC3 && userSession.lc3Service) {
  //   //   try {
  //   //     processedAudioData = await userSession.lc3Service.decodeAudioChunk(audioData, sequenceNumber);
  //   //     if (!processedAudioData) {
  //   //       if (LOG_AUDIO) userSession.logger.warn(`⚠️ LC3 decode returned null, sequence ${sequenceNumber}`);
  //   //       return; // Return void if null
  //   //     }
  //   //     if (DEBUG_AUDIO && processedAudioData) await userSession.audioWriter?.writePCM(processedAudioData);
  //   //   } catch (error) {
  //   //     userSession.logger.error(`❌ Error decoding LC3 audio, sequence ${sequenceNumber}:`, error);
  //   //     // LC3 reinitialization logic could go here
  //   //     return; // Return void on error
  //   //   }
  //   // } else if (processedAudioData && DEBUG_AUDIO) {
  //     // await userSession.audioWriter?.writePCM(processedAudioData);
  //   // }

  //   try {
  //     if (DEBUG_AUDIO && processedAudioData) {
  //       await userSession.audioWriter?.writePCM(processedAudioData);
  //     }
  //   }
  //   catch (error) {
  //     userSession.logger.error(`❌ Error writing audio data:`, error);
  //   }

  //   if (processedAudioData) {
  //     transcriptionService.feedAudioToTranscriptionStreams(userSession, processedAudioData);
  //     // Ensure we return ArrayBuffer, not ArrayBufferLike
  //     if (processedAudioData instanceof ArrayBuffer) {
  //       return processedAudioData;
  //     } else if (processedAudioData.buffer instanceof ArrayBuffer) {
  //       // Handle cases like Node.js Buffer or TypedArrays
  //       return processedAudioData.buffer.slice(processedAudioData.byteOffset, processedAudioData.byteOffset + processedAudioData.byteLength);
  //     } else {
  //       userSession.logger.error('Processed audio data is not an ArrayBuffer or convertible.');
  //       return; // Return void if conversion fails
  //     }
  //   }
  //   return; // Return void if no processed data
  // }

  endSession(userSession: ExtendedUserSession): void {
    if (!userSession) return;

    userSession.logger.info(`[Ending session] Starting cleanup for ${userSession.sessionId}`);

    // Notify debug service of session disconnection before cleanup
    this.debugService.sessionDisconnected(userSession.sessionId);

    if (userSession.cleanupTimerId) {
      clearTimeout(userSession.cleanupTimerId);
      userSession.logger.info(`[session.service]: Cleared cleanup timer during endSession for ${userSession.sessionId}`);
      userSession.cleanupTimerId = undefined;
    }

    if (userSession.isTranscribing) { // Use flag
      transcriptionService.stopTranscription(userSession);
    }

    if (userSession.lc3Service) {
      userSession.logger.info(`🧹 Cleaning up LC3 service for session ${userSession.sessionId}`);
      userSession.lc3Service.cleanup();
      userSession.lc3Service = undefined;
    }

    if (userSession.audioBuffer) {
      userSession.logger.info(`🧹 Cleaning up audio buffer for session ${userSession.sessionId}`);
      if (userSession.audioBuffer.bufferProcessingInterval) {
        clearInterval(userSession.audioBuffer.bufferProcessingInterval);
        userSession.audioBuffer.bufferProcessingInterval = null; // Set to null
      }
      userSession.audioBuffer.chunks = [];
    }

    // SubscriptionManager is part of userSession, no specific cleanup needed here

    // Clean up heartbeat manager
    if (userSession.heartbeatManager) {
      userSession.logger.info(`🧹 Cleaning up heartbeat manager for session ${userSession.sessionId}`);
      userSession.heartbeatManager.dispose();
    }
    
    // Clean up any reconnection timers
    if (userSession._reconnectionTimers) {
      userSession.logger.info(`🧹 Cleaning up reconnection timers for session ${userSession.sessionId}`);
      for (const [packageName, timerId] of userSession._reconnectionTimers.entries()) {
        clearTimeout(timerId);
      }
      userSession._reconnectionTimers.clear();
    }

    // Clean up dashboard manager if it exists
    if (userSession.dashboardManager && typeof userSession.dashboardManager.dispose === 'function') {
      userSession.logger.info(`🧹 Cleaning up dashboard manager for session ${userSession.sessionId}`);
      userSession.dashboardManager.dispose();
    }

    // Clear transcript data
    if (userSession.transcript) {
      userSession.transcript.segments = []; // Clear legacy segments
      
      // Clear language-specific segments if they exist
      if (userSession.transcript.languageSegments) {
        userSession.transcript.languageSegments.clear();
      }
    }
    
    userSession.bufferedAudio = [];

    userSession.appConnections.forEach((ws, appName) => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        userSession.logger.info(`[session.service] Closing TPA connection for ${appName} during session end.`);
        try { ws.close(1001, 'User session ended'); } catch (e) { /* ignore */ }
      }
    });
    userSession.appConnections.clear();

    this.activeSessions.delete(userSession.sessionId);

    // Decide whether to remove from sessionsByUser map
    // Keeping it allows faster reuse on next connect
    // Removing it ensures no stale references if user doesn't reconnect soon
    // Let's remove it for cleaner state, user will create new if they reconnect
    if (this.sessionsByUser.get(userSession.userId) === userSession) {
      this.sessionsByUser.delete(userSession.userId);
      userSession.logger.info(`Removed user ${userSession.userId} from sessionsByUser map.`);
    }


    userSession.logger.info(`[Ended session] Completed cleanup for ${userSession.sessionId}`);

    if (global.gc) {
      userSession.logger.info('🧹 Suggesting garbage collection after ending session');
      global.gc();
    }
  }

  getAllSessions(): ExtendedUserSession[] {
    return Array.from(this.activeSessions.values());
  }

  getSessionByUserId(userId: string): ExtendedUserSession | null {
    // Check active sessions first
    for (const session of this.activeSessions.values()) {
      if (session.userId === userId) {
        // Update the user map to point to this active session
        this.sessionsByUser.set(userId, session);
        return session;
      }
    }
    // If not found in active, check the user map (might be disconnected)
    // const disconnectedSession = this.sessionsByUser.get(userId);
    // return disconnectedSession || null; // Return potentially disconnected session? Or null? Let's return null if not active.
    return null;
  }

  getSessionsForUser(userId: string): ExtendedUserSession[] {
    const userSessions: ExtendedUserSession[] = [];
    for (const session of this.activeSessions.values()) {
      if (session.userId === userId) {
        userSessions.push(session);
      }
    }
    return userSessions;
  }

  markSessionDisconnected(userSession: ExtendedUserSession): void {
    if (userSession) {
      if (userSession.cleanupTimerId) {
        clearTimeout(userSession.cleanupTimerId);
        userSession.logger.info(`[session.service]: Cleared cleanup timer during markSessionDisconnected for ${userSession.sessionId}`);
        userSession.cleanupTimerId = undefined;
      }

      if (userSession.isTranscribing) {
        transcriptionService.stopTranscription(userSession);
      }
      userSession.disconnectedAt = new Date();
      userSession.isTranscribing = false;
      userSession.logger.info(
        `Session ${userSession.sessionId} marked as disconnected at ${userSession.disconnectedAt.toISOString()}`
      );

      // Notify debug service of session disconnection
      this.debugService.sessionDisconnected(userSession.sessionId);
    }
  }

  getAudioServiceInfo(sessionId: string): object | null {
    const session = this.getSession(sessionId);
    if (session && session.lc3Service) {
      return session.lc3Service.getInfo();
    }
    return null;
  }
}

// We'll initialize this in index.ts after creating the debug service
let _sessionService: SessionService | null = null;

export function initializeSessionService(debugService: DebugService): SessionService {
  if (!_sessionService) {
    _sessionService = new SessionService(debugService);
    logger.info('✅ Session Service Initialized');
  }
  return _sessionService;
}

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

// Export both the named export and default export using the same proxy
export const sessionService = sessionServiceProxy;
export default sessionServiceProxy;