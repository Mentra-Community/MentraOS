# Original Session Service Analysis

## Overview

The `session.service.ts` is a critical component of the MentraOS Cloud system, responsible for managing user sessions, audio processing, transcription integration, and display management. It serves as the central hub connecting glasses clients, TPAs, and various system services.

## Core Responsibilities

### 1. Session Creation and Management
- **Function**: `createSession(ws: WebSocket, userId: string): Promise<ExtendedUserSession>`
- **Purpose**: Creates or reuses a user session based on userId
- **Usage**: Called by the WebSocket service when a glasses client connects
- **Details**:
  - Checks for existing sessions for the user
  - Creates a new session or reuses an existing one
  - Initializes various managers (DisplayManager, DashboardManager)
  - Sets up LC3 audio processing if needed
  - Fetches installed apps for the user

### 2. Session Retrieval
- **Function**: `getSession(sessionId: string): ExtendedUserSession | null`
- **Purpose**: Retrieves a session by its ID
- **Usage**: Called by various parts of the system to access user sessions
- **Details**: Looks up session in the activeSessions map

### 3. Session Data Transformation
- **Function**: `transformUserSessionForClient(userSession: ExtendedUserSession): Promise<Partial<UserSession>>`
- **Purpose**: Prepares session data to be sent to glasses clients
- **Usage**: Used when sending app state changes to clients
- **Details**:
  - Collects app subscriptions from all active apps
  - Determines what streams need to be active
  - Creates a streamlined session object for clients

### 4. App State Change Broadcasting
- **Function**: `triggerAppStateChange(userId: string): Promise<void>`
- **Purpose**: Notifies clients of changes in app state
- **Usage**: Called when apps are started/stopped or subscriptions change
- **Details**:
  - Fetches latest installed apps
  - Transforms session data
  - Sends APP_STATE_CHANGE message to clients

### 5. Display Management
- **Function**: `updateDisplay(userSessionId: string, displayRequest: DisplayRequest): void`
- **Purpose**: Updates display content on glasses
- **Usage**: Called when TPAs want to display content
- **Details**: Delegates to the DisplayManager in the user session

### 6. Transcript Management
- **Function**: `addTranscriptSegment(userSession: ExtendedUserSession, segment: TranscriptSegment, language: string): void`
- **Purpose**: Adds transcript segments to the session history
- **Usage**: Called by the transcription service when new transcripts are generated
- **Details**:
  - Maintains both language-specific and legacy transcript segments
  - Prunes old segments (older than 30 minutes)

### 7. Audio Data Processing
- **Function**: `handleAudioData(userSession: ExtendedUserSession, audioData: ArrayBuffer | any, isLC3): Promise<ArrayBuffer | void>`
- **Purpose**: Processes audio data from glasses
- **Usage**: Called by the WebSocket service when audio data is received
- **Details**:
  - Updates last audio timestamp
  - Maintains a recent audio buffer
  - Handles LC3 decoding if needed
  - Feeds audio to transcription streams

### 8. Session Termination
- **Function**: `endSession(userSession: ExtendedUserSession): void`
- **Purpose**: Cleans up and terminates a session
- **Usage**: Called when a session needs to be ended (user disconnected too long)
- **Details**:
  - Notifies debug service
  - Clears timers and intervals
  - Stops transcription
  - Cleans up LC3 service
  - Clears audio buffer
  - Notifies TPAs of session end
  - Removes session from maps

### 9. Session Listing
- **Function**: `getAllSessions(): ExtendedUserSession[]`
- **Purpose**: Gets all active sessions
- **Usage**: Used for debugging and monitoring
- **Details**: Returns array from activeSessions map

### 10. User Session Lookup
- **Function**: `getSessionByUserId(userId: string): ExtendedUserSession | null`
- **Purpose**: Gets a session by user ID
- **Usage**: Used when operations need to find a user's session
- **Details**:
  - Searches active sessions first
  - Updates sessionsByUser map
  - Returns null if not found

### 11. Multiple Session Lookup
- **Function**: `getSessionsForUser(userId: string): ExtendedUserSession[]`
- **Purpose**: Gets all sessions for a user
- **Usage**: Used when operations need all of a user's sessions
- **Details**: Filters active sessions by userId

### 12. Session Disconnection Handling
- **Function**: `markSessionDisconnected(userSession: ExtendedUserSession): void`
- **Purpose**: Marks a session as disconnected
- **Usage**: Called when a WebSocket connection closes
- **Details**:
  - Clears cleanup timer
  - Stops transcription
  - Records disconnection time
  - Updates session state
  - Notifies debug service

### 13. Audio Service Information
- **Function**: `getAudioServiceInfo(sessionId: string): object | null`
- **Purpose**: Gets audio service info for a session
- **Usage**: Used for debugging audio issues
- **Details**: Delegates to LC3 service if available

## Session Service State

The session service maintains several important state collections:

1. **Active Sessions Map**
   - `private activeSessions = new Map<string, ExtendedUserSession>()`
   - Tracks all currently active sessions by sessionId
   - Primary lookup mechanism for session access

2. **Sessions By User Map**
   - `private sessionsByUser = new Map<string, ExtendedUserSession>()`
   - Maps userIds to their active session
   - Used for quick lookup by userId

## ExtendedUserSession Interface

The ExtendedUserSession interface extends the basic UserSession with additional properties:

```typescript
export interface ExtendedUserSession extends UserSession {
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
  subscriptionManager: SubscriptionManager;
  heartbeatManager: HeartbeatManager;
  _reconnectionTimers?: Map<string, NodeJS.Timeout>;
  recentAudioBuffer: { data: ArrayBufferLike; timestamp: number }[];
  userDatetime?: string;
}
```

## Usage Patterns

The session service is used by various parts of the system:

1. **WebSocket Service**
   - Creates sessions when users connect
   - Accesses sessions to handle messages
   - Marks sessions as disconnected when WebSockets close
   - Ends sessions after grace periods

2. **API Routes**
   - Gets sessions to handle HTTP requests
   - Updates session state based on API calls
   - Triggers app state changes

3. **Display Manager**
   - Receives display requests from session service
   - Updates session display state

4. **Dashboard Manager**
   - Interacts with session to manage dashboard state
   - Updates dashboard displays

5. **Transcription Service**
   - Adds transcript segments to sessions
   - Uses session to broadcast transcription results

6. **Debug Service**
   - Monitors session creation and termination
   - Collects session statistics

## Initialization

The session service uses a singleton pattern:

1. **Initialization Function**
   - `initializeSessionService(debugService: DebugService): SessionService`
   - Creates the singleton instance with debug service dependency

2. **Getter Function**
   - `getSessionService(): SessionService`
   - Returns the singleton, throws if not initialized

3. **Proxy Object**
   - `sessionServiceProxy`
   - Forwards calls to the real service once initialized
   - Throws descriptive errors if accessed before initialization

## Key Dependencies

1. **Display Manager**
   - Handles display content on glasses
   - Initialized for each session

2. **Dashboard Manager**
   - Manages dashboard displays
   - Initialized for each session

3. **Subscription Manager**
   - Tracks TPA subscriptions
   - Initialized for each session

4. **Heartbeat Manager**
   - Monitors connection health
   - Initialized for each session

5. **LC3 Service**
   - Handles audio decoding
   - Initialized for each session

6. **Transcription Service**
   - Manages speech recognition
   - Shared across all sessions

7. **App Service**
   - Provides app data
   - Used for fetching installed apps

8. **Debug Service**
   - Monitors session lifecycle
   - Notified of session events

## Limitations of Current Implementation

1. **Monolithic Design**
   - The session service handles too many different responsibilities
   - Different concerns are mixed together (audio processing, session management, etc.)

2. **WebSocket Dependencies**
   - Several functions that logically belong in the session service are currently in the WebSocket service
   - This creates tight coupling between these services

3. **Inconsistent Error Handling**
   - Error handling is inconsistent across different methods
   - Some errors are caught and logged, others propagate to callers

4. **Global State**
   - Relies on global maps for session tracking
   - Makes testing and isolation difficult

5. **Limited Separation of Concerns**
   - Mixes business logic with connection management
   - Hard to change one without affecting the other

6. **Missing Functionality**
   - Several key functions are missing and are currently handled in WebSocket service

## Missing Functions

These functions aren't in the old session service but need to be added:

1. **Transcription Start/Stop**
   - `handleTranscriptionStart(userSession: ExtendedUserSession): Promise<void>`
   - `handleTranscriptionStop(userSession: ExtendedUserSession): Promise<void>`
   - Currently handled in websocket.service.ts through direct calls to transcriptionService

2. **User Settings**
   - `getUserSettings(userId: string): Promise<Record<string, any>>`
   - Currently handled in websocket.service.ts through direct database access

3. **Message Relaying**
   - `relayMessageToTpas(userSession: ExtendedUserSession, streamType: StreamType, data: any): void`
   - `relayAudioToTpas(userSession: ExtendedUserSession, audioData: ArrayBuffer): void`
   - Currently implemented as `broadcastToTpa` and `broadcastToTpaAudio` in websocket.service.ts

4. **App Lifecycle Management**
   - `startAppSession(userSession: ExtendedUserSession, packageName: string): Promise<void>`
   - `stopAppSession(userSession: ExtendedUserSession, packageName: string): Promise<void>`
   - Currently implemented in websocket.service.ts

5. **Session State Management**
   - `handleTpaInit(ws: WebSocket, initMessage: any, setCurrentSessionId: Function): Promise<void>`
   - `handleAppStateBroadcast(userSession: ExtendedUserSession): Promise<void>`
   - Currently implemented in websocket.service.ts