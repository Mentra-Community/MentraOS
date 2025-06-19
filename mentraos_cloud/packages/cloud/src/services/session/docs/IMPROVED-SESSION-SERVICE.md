# Improved Session Service Design

## Overview

The improved session service is a comprehensive redesign that consolidates all session-related functionality from the original session service and the WebSocket service. It follows the manager pattern established with other components like DisplayManager and introduces new specialized functionality for transcription, user settings, and message relaying.

## Design Principles

1. **Separation of Concerns**: Each component has a clear, focused responsibility
2. **Manager Pattern**: Encapsulate functionality in specialized managers
3. **Consistent Error Handling**: All functions handle errors consistently
4. **Stateful Session, Stateless Service**: Session objects are stateful, service functions are stateless
5. **Clean Interfaces**: Clear, well-defined interfaces between components

## Core Components

### SessionService Class

The SessionService is the main entry point for session-related operations. It coordinates between various managers and exposes a clean API for the rest of the system.

```typescript
export class SessionService {
  // Core functionality from original service
  async createSession(ws: WebSocket, userId: string): Promise<ExtendedUserSession>;
  getSession(sessionId: string): ExtendedUserSession | null;
  async transformUserSessionForClient(userSession: ExtendedUserSession): Promise<Partial<UserSession>>;
  async triggerAppStateChange(userId: string): Promise<void>;
  updateDisplay(userSessionId: string, displayRequest: DisplayRequest): void;
  addTranscriptSegment(userSession: ExtendedUserSession, segment: TranscriptSegment, language?: string): void;
  async handleAudioData(userSession: ExtendedUserSession, audioData: ArrayBuffer | any, isLC3?: boolean): Promise<ArrayBuffer | void>;
  endSession(userSession: ExtendedUserSession): void;
  getAllSessions(): ExtendedUserSession[];
  getSessionByUserId(userId: string): ExtendedUserSession | null;
  getSessionsForUser(userId: string): ExtendedUserSession[];
  markSessionDisconnected(userSession: ExtendedUserSession): void;
  getAudioServiceInfo(sessionId: string): object | null;
  
  // New functionality from WebSocket service
  async handleTranscriptionStart(userSession: ExtendedUserSession): Promise<void>;
  async handleTranscriptionStop(userSession: ExtendedUserSession): Promise<void>;
  async getUserSettings(userId: string): Promise<Record<string, any>>;
  relayMessageToTpas(userSession: ExtendedUserSession, streamType: StreamType, data: any): void;
  relayAudioToTpas(userSession: ExtendedUserSession, audioData: ArrayBuffer): void;
  async startAppSession(userSession: ExtendedUserSession, packageName: string): Promise<void>;
  async stopAppSession(userSession: ExtendedUserSession, packageName: string): Promise<void>;
  isAppRunning(userSession: ExtendedUserSession, packageName: string): boolean;
  async handleTpaInit(ws: WebSocket, initMessage: any, setCurrentSessionId: Function): Promise<void>;
  async handleAppStateBroadcast(userSession: ExtendedUserSession): Promise<void>;
}
```

### ExtendedUserSession Interface

The ExtendedUserSession interface represents a user session with all its associated managers and state:

```typescript
export interface ExtendedUserSession extends UserSession {
  // Original properties
  logger: Logger;
  lc3Service?: LC3Service;
  audioWriter?: AudioWriter;
  audioBuffer?: OrderedAudioBuffer;
  disconnectedAt: Date | null;
  cleanupTimerId?: NodeJS.Timeout;
  websocket: WebSocket;
  displayManager: DisplayManager;
  dashboardManager: any;
  transcript: {
    segments: TranscriptSegment[];
    languageSegments?: Map<string, TranscriptSegment[]>;
  };
  bufferedAudio: ArrayBufferLike[];
  lastAudioTimestamp?: number;
  recognizer?: any;
  transcriptionStreams: Map<string, ASRStreamInstance>;
  isTranscribing: boolean;
  loadingApps: Set<string>;
  appConnections: Map<string, WebSocket | any>;
  installedApps: AppI[];
  
  // Manager instances
  subscriptionManager: SubscriptionManager;
  heartbeatManager: HeartbeatManager;
  microphoneManager: MicrophoneManager;
  
  // Timers and additional state
  _reconnectionTimers?: Map<string, NodeJS.Timeout>;
  recentAudioBuffer: { data: ArrayBufferLike; timestamp: number }[];
  userDatetime?: string;
}
```

### MicrophoneManager Class

The MicrophoneManager encapsulates all microphone-related functionality:

```typescript
export class MicrophoneManager {
  constructor(session: ExtendedUserSession);
  
  // Core functionality
  updateState(isEnabled: boolean, delay?: number): void;
  isEnabled(): boolean;
  handleConnectionStateChange(status: string): void;
  handleSubscriptionChange(): void;
  updateOnboardMicSetting(useOnboardMic: boolean): void;
  dispose(): void;
  
  // Private helpers
  private sendStateChangeToGlasses(isEnabled: boolean): void;
  private updateTranscriptionState(): void;
  private checkMediaSubscriptions(): boolean;
}
```

## New Functionality

### Transcription Management

```typescript
/**
 * Start transcription for a user session
 * 
 * @param userSession The user session to start transcription for
 */
async handleTranscriptionStart(userSession: ExtendedUserSession): Promise<void> {
  try {
    // If not already transcribing, start transcription
    if (!userSession.isTranscribing) {
      userSession.logger.info('Starting transcription service');
      userSession.isTranscribing = true;
      await transcriptionService.startTranscription(userSession);
    } else {
      userSession.logger.debug('Transcription already running, ignoring start request');
    }
  } catch (error) {
    userSession.logger.error('Error starting transcription:', error);
    // Don't throw - we want to handle errors gracefully
  }
}

/**
 * Stop transcription for a user session
 * 
 * @param userSession The user session to stop transcription for
 */
async handleTranscriptionStop(userSession: ExtendedUserSession): Promise<void> {
  try {
    // If currently transcribing, stop transcription
    if (userSession.isTranscribing) {
      userSession.logger.info('Stopping transcription service');
      userSession.isTranscribing = false;
      await transcriptionService.stopTranscription(userSession);
    } else {
      userSession.logger.debug('Transcription already stopped, ignoring stop request');
    }
  } catch (error) {
    userSession.logger.error('Error stopping transcription:', error);
    // Don't throw - we want to handle errors gracefully
  }
}
```

### User Settings Management

```typescript
/**
 * Get user settings for a given user ID
 * 
 * @param userId User ID to get settings for
 * @returns User settings object
 */
async getUserSettings(userId: string): Promise<Record<string, any>> {
  try {
    // Look up user in database
    const user = await User.findOne({ email: userId });
    
    if (!user) {
      this.logger.warn(`No user found for ID: ${userId}, using default settings`);
      return DEFAULT_AUGMENTOS_SETTINGS;
    }
    
    // Get augmentos settings
    const augmentosSettings = user.getAugmentosSettings();
    
    // Create a settings object combining both augmentOS settings and app settings
    const allSettings: Record<string, any> = {
      ...augmentosSettings
    };
    
    // Get app settings and add them to the response
    if (user.appSettings && user.appSettings.size > 0) {
      // Convert Map to object
      const appSettingsObj: Record<string, any> = {};
      
      for (const [appName, settings] of user.appSettings.entries()) {
        appSettingsObj[appName] = settings;
      }
      
      allSettings.appSettings = appSettingsObj;
    } else {
      allSettings.appSettings = {};
    }
    
    return allSettings;
  } catch (error) {
    this.logger.error(`Error fetching settings for user ${userId}:`, error);
    // Return default settings on error
    return DEFAULT_AUGMENTOS_SETTINGS;
  }
}
```

### Message Relaying

```typescript
/**
 * Relay a message to all TPAs subscribed to the given stream type
 * 
 * @param userSession User session containing subscription information
 * @param streamType Type of stream to relay to
 * @param data Data to relay
 */
relayMessageToTpas(userSession: ExtendedUserSession, streamType: StreamType, data: any): void {
  try {
    const sessionId = userSession.sessionId;
    const subscriptionManager = userSession.subscriptionManager;
    
    // Get all TPAs subscribed to this stream type
    const subscribedPackageNames = subscriptionManager.getSubscribers(streamType);
    
    if (subscribedPackageNames.length === 0) {
      return; // No subscribers, nothing to do
    }
    
    userSession.logger.debug(`Relaying ${streamType} to ${subscribedPackageNames.length} TPAs`);
    
    // Create the message to send
    const message = {
      type: CloudToTpaMessageType.DATA_STREAM,
      streamType,
      data,
      timestamp: new Date()
    };
    
    const messageStr = JSON.stringify(message);
    
    // Send to each subscribed TPA
    for (const packageName of subscribedPackageNames) {
      const connection = userSession.appConnections.get(packageName);
      
      if (connection && connection.readyState === WebSocket.OPEN) {
        try {
          connection.send(messageStr);
        } catch (sendError) {
          userSession.logger.error(`Error sending ${streamType} to ${packageName}:`, sendError);
        }
      }
    }
  } catch (error) {
    userSession.logger.error(`Error relaying ${streamType} message:`, error);
  }
}

/**
 * Relay audio data to all TPAs subscribed to audio streams
 * 
 * @param userSession User session containing subscription information
 * @param audioData Audio data to relay
 */
relayAudioToTpas(userSession: ExtendedUserSession, audioData: ArrayBuffer): void {
  try {
    const sessionId = userSession.sessionId;
    const subscriptionManager = userSession.subscriptionManager;
    
    // Get all TPAs subscribed to audio
    const subscribedPackageNames = subscriptionManager.getSubscribers(StreamType.AUDIO_CHUNK);
    
    if (subscribedPackageNames.length === 0) {
      return; // No subscribers, nothing to do
    }
    
    // Send binary data to each subscribed TPA
    for (const packageName of subscribedPackageNames) {
      const connection = userSession.appConnections.get(packageName);
      
      if (connection && connection.readyState === WebSocket.OPEN) {
        try {
          connection.send(audioData);
        } catch (sendError) {
          userSession.logger.error(`Error sending audio to ${packageName}:`, sendError);
        }
      }
    }
  } catch (error) {
    userSession.logger.error(`Error relaying audio:`, error);
  }
}
```

### App Lifecycle Management

```typescript
/**
 * Start an app session
 * 
 * @param userSession User session
 * @param packageName Package name of the app to start
 */
async startAppSession(userSession: ExtendedUserSession, packageName: string): Promise<void> {
  try {
    if (this.isAppRunning(userSession, packageName)) {
      userSession.logger.info(`App ${packageName} already running, ignoring start request`);
      return;
    }
    
    userSession.logger.info(`Starting app ${packageName}`);
    
    // Add to loading apps
    userSession.loadingApps.add(packageName);
    
    // Trigger app start webhook
    try {
      await appService.triggerStartByPackageName(packageName, userSession.userId);
    } catch (webhookError) {
      userSession.logger.error(`Error triggering start webhook for ${packageName}:`, webhookError);
    }
    
    // Add to active app sessions if not already present
    if (!userSession.activeAppSessions.includes(packageName)) {
      userSession.activeAppSessions.push(packageName);
    }
    
    // Remove from loading apps
    userSession.loadingApps.delete(packageName);
    
    // Broadcast app state change
    await this.triggerAppStateChange(userSession.userId);
    
  } catch (error) {
    userSession.logger.error(`Error starting app ${packageName}:`, error);
    // Remove from loading apps in case of error
    userSession.loadingApps.delete(packageName);
  }
}

/**
 * Stop an app session
 * 
 * @param userSession User session
 * @param packageName Package name of the app to stop
 */
async stopAppSession(userSession: ExtendedUserSession, packageName: string): Promise<void> {
  try {
    if (!this.isAppRunning(userSession, packageName)) {
      userSession.logger.info(`App ${packageName} not running, ignoring stop request`);
      return;
    }
    
    userSession.logger.info(`Stopping app ${packageName}`);
    
    // Remove from active app sessions
    userSession.activeAppSessions = userSession.activeAppSessions.filter(
      app => app !== packageName
    );
    
    // Trigger app stop webhook
    try {
      await appService.triggerStopByPackageName(packageName, userSession.userId);
    } catch (webhookError) {
      userSession.logger.error(`Error triggering stop webhook for ${packageName}:`, webhookError);
    }
    
    // Broadcast app state change
    await this.triggerAppStateChange(userSession.userId);
    
    // Close WebSocket connection if exists
    const connection = userSession.appConnections.get(packageName);
    if (connection && connection.readyState === WebSocket.OPEN) {
      try {
        // Send app stopped message
        const message = {
          type: CloudToTpaMessageType.APP_STOPPED,
          timestamp: new Date()
        };
        connection.send(JSON.stringify(message));
        
        // Close the connection
        connection.close(1000, 'App stopped');
      } catch (closeError) {
        userSession.logger.error(`Error closing connection for ${packageName}:`, closeError);
      }
    }
    
    // Remove from app connections
    userSession.appConnections.delete(packageName);
    
  } catch (error) {
    userSession.logger.error(`Error stopping app ${packageName}:`, error);
  }
}

/**
 * Check if an app is running in a session
 * 
 * @param userSession User session
 * @param packageName Package name to check
 * @returns Whether the app is running
 */
isAppRunning(userSession: ExtendedUserSession, packageName: string): boolean {
  return userSession.activeAppSessions.includes(packageName);
}
```

## Initialization

The session service follows the singleton pattern, with both a factory function and a singleton export:

```typescript
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
```

## Error Handling

All functions follow a consistent error handling pattern:

1. **Top-level try/catch**: Every public function has a try/catch block
2. **Error logging**: Errors are logged with context
3. **No error propagation**: Errors are handled within the function
4. **Default values**: Appropriate default values are returned when errors occur
5. **Session state preservation**: Session state is preserved in case of errors

## Integration with Other Services

### WebSocket Service Integration

The WebSocket service will use the session service for:

1. **Session creation**: When clients connect
2. **Message handling**: Delegating to session methods
3. **Session cleanup**: When clients disconnect

```typescript
// In websocket-glasses.service.ts
private async handleVad(userSession: ExtendedUserSession, message: Vad): Promise<void> {
  const userId = userSession.userId;
  const isSpeaking = message.status === true || message.status === 'true';
  
  if (isSpeaking) {
    userSession.logger.info(`🎙️ VAD detected speech - starting transcription for user: ${userId}`);
    userSession.isTranscribing = true;
    await sessionService.handleTranscriptionStart(userSession);
  } else {
    userSession.logger.info(`🤫 VAD detected silence - stopping transcription for user: ${userId}`);
    userSession.isTranscribing = false;
    await sessionService.handleTranscriptionStop(userSession);
  }
}

// In websocket-tpa.service.ts
private async handleTpaInit(ws: WebSocket, message: TpaConnectionInit): Promise<void> {
  try {
    await sessionService.handleTpaInit(ws, message, (sessionId: string) => {
      this.currentSessionId = sessionId;
    });
  } catch (error) {
    logger.error('Error handling TPA init:', error);
  }
}
```

### Transcription Service Integration

The transcription service will use the session service for:

1. **Adding transcript segments**: When new transcripts are generated
2. **Managing audio data**: When audio needs processing
3. **Broadcasting results**: When transcripts need to be sent to TPAs

### App Service Integration

The app service will use the session service for:

1. **Triggering app state changes**: When apps are installed/uninstalled
2. **Managing app sessions**: When apps need to be started/stopped

## Benefits

1. **Improved Modularity**: Clear separation of concerns with specialized components
2. **Better Error Handling**: Consistent error handling across all functions
3. **Enhanced Maintainability**: Smaller, focused components with clear responsibilities
4. **Reduced Coupling**: WebSocket handling separated from session management
5. **Improved Testability**: Components can be tested independently
6. **Future Extensibility**: Cleaner structure for adding new functionality

## Migration Strategy

1. **Parallel Implementation**: Create new implementation without modifying existing code
2. **Staged Testing**: Test new implementation alongside existing code
3. **Gradual Transition**: Move to the new implementation in phases
4. **Preservation**: Keep original implementation until new one is fully tested
5. **Final Cleanup**: Remove unused code once new implementation is confirmed working

This improved design addresses the limitations of the original session service while preserving all existing functionality and adding new capabilities from the WebSocket service.