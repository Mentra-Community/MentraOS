AugmentOS Cloud Debug Dashboard Design Document

  Author: Claude (based on consultation with Isaiah Ballah)Date: March 25, 2025Version: 1.0

  1. Overview

  1.1 Objective

  Design and implement a real-time debugging dashboard that provides "X-ray vision" into the AugmentOS Cloud system, focusing on session state, WebSocket connections, TPA
  interactions, and log collection/visualization. This tool will help developers identify and resolve issues faster and understand the system's behavior in development and
  production environments.

  1.2 Background

  The AugmentOS Cloud platform uses WebSocket connections for real-time communication between smart glasses, cloud services, and third-party applications (TPAs). The complex,
   stateful nature of these connections makes debugging challenging, especially when issues occur in production. Currently, logs "go into the void," and there's no
  centralized way to observe the system state.

  1.3 Goals

  - Provide real-time visibility into session state, connections, and TPA interactions
  - Create a centralized logging system that persists and makes logs searchable
  - Enable developers to understand system behavior across components
  - Support both development and production debugging
  - Minimize performance impact on the core system

  1.4 Non-Goals

  - Modify core system architecture
  - Replace existing monitoring solutions
  - Provide user analytics (focus is on technical debugging)
  - Implement auto-remediation of issues
  - Add database or resource monitoring (minimal value for current issues)

  2. System Design

  2.1 Architecture Overview

  graph TD
      subgraph "AugmentOS Cloud Core"
          WS[WebSocket Service]
          SS[Session Service]
          AS[App Service]
          SB[Subscription Service]
          DM[Display Manager]
          TS[Transcription Service]
      end

      subgraph "Debug Infrastructure"
          LS[Logging Service]
          SS -->|State events| LS
          WS -->|Connection events| LS
          AS -->|App events| LS
          SB -->|Subscription events| LS
          DM -->|Display events| LS
          TS -->|Transcription events| LS

          LS --> IS[In-Memory Store]
          IS --> DE[Debug API Endpoints]

          DE -->|REST| DU[Debug UI]
          LS -->|WebSocket| DU
      end

      Users[Developers] --> DU

  2.2 Components

  2.2.1 Logging Service

  The Logging Service will enhance the current logging to include structured context and provide a centralized collection point:

  // Enhanced logger with context
  export function createContextLogger(baseContext: LogContext) {
    return {
      info: (message: string, data?: any) => {
        logger.info(message, { ...baseContext, ...data });
        logStore.addLog({
          level: 'info',
          message,
          context: { ...baseContext, ...data },
          timestamp: new Date()
        });
      },
      error: (message: string, error?: any) => {
        logger.error(message, error, { ...baseContext });
        logStore.addLog({
          level: 'error',
          message,
          error: error instanceof Error ? error.stack : error,
          context: { ...baseContext },
          timestamp: new Date()
        });
      },
      // other log levels...
    };
  }

  2.2.2 In-Memory Store

  A lightweight in-memory store to maintain recent logs and current system state:

  export class DebugStore {
    private logs: LogEntry[] = [];
    private sessions: Map<string, SessionState> = new Map();
    private tpaConnections: Map<string, TPAConnectionState> = new Map();
    private subscriptions: Map<string, SubscriptionState> = new Map();
    private displayState: Map<string, DisplayState> = new Map();

    // Methods to update state...
    updateSession(sessionId: string, state: Partial<SessionState>) {...}
    updateConnection(id: string, state: Partial<TPAConnectionState>) {...}

    // Methods to retrieve state...
    getSessions(): SessionState[] {...}
    getSessionById(sessionId: string): SessionState | undefined {...}

    // Log management
    addLog(log: LogEntry) {...}
    getLogs(filter?: LogFilter): LogEntry[] {...}

    // Memory management
    pruneOldLogs() {...}
  }

  2.2.3 Debug API Endpoints

  REST endpoints to access debug data:

  // Example endpoint implementations
  router.get('/api/debug/sessions', (req, res) => {
    res.json(debugStore.getSessions());
  });

  router.get('/api/debug/session/:id', (req, res) => {
    const session = debugStore.getSessionById(req.params.id);
    if (!session) {
      return res.status(404).json({ error: 'Session not found' });
    }
    res.json(session);
  });

  router.get('/api/debug/logs', (req, res) => {
    const filter = req.query as LogFilter;
    res.json(debugStore.getLogs(filter));
  });

  2.2.4 Debug UI

  A React-based dashboard with the following sections:

  1. Sessions Overview: List of active sessions with status indicators
  2. Session Detail: Detailed view of a selected session
  3. Connections: Visual representation of WebSocket connections
  4. TPAs: Status of all running TPAs and their subscriptions
  5. Logs Explorer: Searchable, filterable log viewer
  6. System Overview: Summary statistics and health indicators

  2.3 Data Models

  2.3.1 Session State

  interface SessionState {
    sessionId: string;
    userId: string;
    startTime: Date;
    disconnectedAt: Date | null;
    status: 'active' | 'disconnected' | 'reconnecting';
    activeApps: string[];
    loadingApps: string[];
    isTranscribing: boolean;
    glassesConnectionState: {
      connected: boolean;
      lastActivity: Date;
      messageCount: number;
      errorCount: number;
    };
  }

  2.3.2 TPA Connection State

  interface TPAConnectionState {
    connectionId: string;
    sessionId: string;
    packageName: string;
    connectionTime: Date;
    lastActivity: Date;
    status: 'connected' | 'disconnected' | 'reconnecting';
    messagesSent: number;
    messagesReceived: number;
    errors: number;
    subscriptions: string[];
  }

  2.3.3 Subscription State

  interface SubscriptionState {
    sessionId: string;
    packageName: string;
    streamTypes: string[];
    lastUpdated: Date;
    messagesDelivered: Map<string, number>; // streamType -> count
  }

  2.3.4 Display State

  interface DisplayState {
    sessionId: string;
    currentDisplay: {
      appPackageName: string | null;
      layoutType: string | null;
      startTime: Date | null;
      expiryTime: Date | null;
      hasLock: boolean;
    };
    pendingDisplays: Array<{
      appPackageName: string;
      layoutType: string;
      priority: number;
    }>;
  }

  2.3.5 Log Entry

  interface LogEntry {
    id: string;
    timestamp: Date;
    level: 'debug' | 'info' | 'warn' | 'error';
    message: string;
    context: {
      sessionId?: string;
      userId?: string;
      packageName?: string;
      component?: string;
      [key: string]: any;
    };
    error?: string;
  }

  2.4 System Integrations

  2.4.1 WebSocket Service Integration

  // In websocket.service.ts
  private handleGlassesConnection(ws: WebSocket): Promise<void> {
    // Existing code...

    // Add debug logging
    debugStore.updateConnection(userSession.sessionId, {
      type: 'glasses',
      connectionTime: new Date(),
      status: 'connected'
    });

    ws.on('message', async (message: Buffer | string, isBinary: boolean) => {
      // Existing handling...

      // Log message receipt
      debugStore.incrementMessageCount(userSession.sessionId, 'received');
    });

    ws.on('close', () => {
      // Existing handling...

      // Update debug state
      debugStore.updateConnection(userSession.sessionId, {
        status: 'disconnected',
        disconnectedAt: new Date()
      });
    });
  }

  2.4.2 Session Service Integration

  // In session.service.ts
  public createSession(ws: WebSocket): Promise<UserSession> {
    // Existing code...

    // Track session creation
    debugStore.updateSession(sessionId, {
      sessionId,
      userId,
      startTime: new Date(),
      status: 'active',
      activeApps: [],
      loadingApps: []
    });

    return session;
  }

  public handleReconnectUserSession(newSession: UserSession, userId: string): void {
    // Existing code...

    // Track reconnection
    debugStore.updateSession(oldSession.sessionId, {
      status: 'reconnecting'
    });

    debugStore.updateSession(newSession.sessionId, {
      reconnectedFrom: oldSession.sessionId
    });
  }

  2.4.3 App Service Integration

  // In app.service.ts
  async startAppSession(userSession: UserSession, packageName: string): Promise<string> {
    // Existing code...

    // Track app start
    debugStore.updateApp(userSession.sessionId, packageName, {
      status: 'loading',
      startTime: new Date()
    });

    // After successful start
    debugStore.updateApp(userSession.sessionId, packageName, {
      status: 'active'
    });

    return tpaSessionId;
  }

  3. User Interface Design

  3.1 Sessions Dashboard

  +-----------------------------------------------------------+
  |                     AugmentOS Debug                       |
  +---------------+-------------------------------------------+
  | Sessions (5)  | Session Detail: 1234-5678-90ab-cdef       |
  |               |                                           |
  | ● Active (3)  | User: user@example.com                    |
  | ○ Disconn (2) | Status: Active (Connected: 1h 23m)        |
  |               |                                           |
  | ● 1234-56..   | Active TPAs:                              |
  | ● 2345-67..   | ✓ dashboard (system)                      |
  | ● 3456-78..   | ✓ mira (system)                           |
  | ○ 4567-89..   | ✓ voice-notes (user)                      |
  | ○ 5678-90..   | ⌛ flash (loading...)                      |
  |               |                                           |
  | + Filters     | Transcription: Active (en-US)             |
  |               | Glasses Connection: WebSocket OPEN        |
  |               | Display: voice-notes (text_wall)          |
  |               |                                           |
  |               | [View Connections] [View Logs] [View TPAs]|
  +---------------+-------------------------------------------+

  3.2 Connection Visualization

  +-----------------------------------------------------------+
  |                     Connection View                       |
  +-----------------------------------------------------------+
  |                                                           |
  |      [Glasses]                                            |
  |         │                                                 |
  |         ▼                                                 |
  |     [AugmentOS Cloud]                                     |
  |      ╱     │      ╲                                       |
  |     ▼      ▼       ▼                                      |
  | [dashboard] [mira] [voice-notes] [flash ⌛]               |
  |                                                           |
  +-----------------------------------------------------------+
  | Connection Details:                                       |
  |                                                           |
  | [Glasses] → [AugmentOS Cloud]                             |
  | Status: OPEN                                              |
  | Duration: 1h 23m                                          |
  | Messages Sent: 1,245                                      |
  | Messages Received: 3,567                                  |
  | Last Message: 3s ago                                      |
  +-----------------------------------------------------------+

  3.3 Logs Explorer

  +-----------------------------------------------------------+
  |                      Logs Explorer                        |
  +-----------------------------------------------------------+
  | Filter: sessionId:1234-5678 level:error                  ↓|
  +-----------------------------------------------------------+
  | 10:25:32 | ERROR | [websocket.service] TPA connection err |
  | Context: { sessionId: "1234-5678", packageName: "flash"   |
  |           error: "WebSocket connection timeout" }         |
  +-----------------------------------------------------------+
  | 10:24:15 | INFO  | [session.service] Session reconnected  |
  | Context: { sessionId: "1234-5678", userId: "user@ex..."   |
  +-----------------------------------------------------------+
  | 10:23:55 | WARN  | [transcription] Language not supported |
  | Context: { sessionId: "1234-5678", language: "fr-FR" }    |
  +-----------------------------------------------------------+
  | 10:22:30 | INFO  | [app.service] Starting TPA             |
  | Context: { sessionId: "1234-5678", packageName: "flash" } |
  +-----------------------------------------------------------+

  3.4 TPA Status View

  +-----------------------------------------------------------+
  |                      TPA Status                           |
  +-----------------------------------------------------------+
  | Session: 1234-5678-90ab-cdef                              |
  +-----------------------------------------------------------+
  | Package     | Status   | Connection | Subscriptions       |
  +-----------------------------------------------------------+
  | dashboard   | Active   | Connected  | audio, transcript   |
  |             |          | 1h 23m     | location, calendar  |
  +-----------------------------------------------------------+
  | mira        | Active   | Connected  | transcript:en-US    |
  |             |          | 1h 20m     | transcript:es-ES    |
  +-----------------------------------------------------------+
  | voice-notes | Active   | Connected  | audio, transcript   |
  |             |          | 45m        |                     |
  +-----------------------------------------------------------+
  | flash       | Loading  | Pending    | (none)              |
  |             |          | 30s        |                     |
  +-----------------------------------------------------------+

  4. Implementation Plan

  4.1 Phase 1: Core Logging Infrastructure (1-2 weeks)

  1. Create Logging Service
    - Implement structured logging with context
    - Build in-memory log storage with TTL
    - Create basic API endpoints for log retrieval
  2. Basic Integration
    - Add session lifecycle logging
    - Add connection event logging
    - Add TPA lifecycle logging
  3. Simple UI
    - Create basic React app shell
    - Implement log explorer view
    - Add simple session list

  4.2 Phase 2: State Tracking (2-3 weeks)

  1. Debug Store Implementation
    - Create session state tracking
    - Implement connection state modeling
    - Add TPA and subscription state
  2. Service Integration
    - Integrate with WebSocket service
    - Add tracking to Session service
    - Connect with App service
    - Integrate with Subscription service
  3. UI Enhancements
    - Build session detail view
    - Implement TPA status table
    - Create connection visualization

  4.3 Phase 3: Real-time Updates and Refinement (1-2 weeks)

  1. WebSocket Updates
    - Add real-time state updates via WebSocket
    - Implement update batching for efficiency
    - Create reconnection handling
  2. UI Polish
    - Add filtering and search capabilities
    - Implement real-time updates in UI
    - Create dashboard view with key metrics
  3. Performance Optimization
    - Add sampling for high-volume logs
    - Implement efficient state diffing
    - Add pruning for old data

  5. Deployment Considerations

  5.1 Development Environment

  For local development, the debug dashboard will run alongside the core services:

  # Addition to docker-compose.dev.yml
  debug-dashboard:
    build:
      context: .
      dockerfile: Dockerfile.debug
    ports:
      - "3001:3000"
    environment:
      - NODE_ENV=development
    volumes:
      - ./packages/debug-dashboard:/app

  5.2 Production Deployment

  For production, a feature flag will control whether debugging is enabled, with a separate dashboard instance:

  # Addition to docker-compose.yml
  debug-dashboard:
    image: augmentos/debug-dashboard:latest
    ports:
      - "3001:3000"
    environment:
      - NODE_ENV=production
      - ENABLE_DEBUG=true
      - DEBUG_LOG_RETENTION=24h
      - DEBUG_SESSION_SAMPLING=100

  5.3 Security Considerations

  - Debug dashboard will require authentication
  - Sensitive user data will be redacted from logs
  - In production, access will be limited to internal network or VPN
  - Rate limiting will be applied to API endpoints
  - Environment flag required to enable debug features in production

  6. Success Metrics

  The debug dashboard will be successful if it:

  1. Reduces time to identify session-related issues by 50%
  2. Provides visibility into 100% of WebSocket connection issues
  3. Captures at least 95% of errors with complete context
  4. Operates with minimal (<5%) performance impact on the core system
  5. Enables developers to independently troubleshoot common issues

  7. Risks and Mitigations

  8. Open Questions

  1. What is the appropriate log retention period for production?
  2. Should we implement role-based access to different levels of debug information?
  3. How will the debug dashboard be accessed in production environments?
  4. Should we add integration with external monitoring tools?
  5. Do we need to implement any automated alerting based on detected issues?

  9. Appendix

  9.1 Key Variables to Monitor

  9.2 Key Events to Log