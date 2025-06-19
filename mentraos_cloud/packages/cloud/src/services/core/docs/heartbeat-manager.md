HeartbeatManager: Improved WebSocket Reconnection Design

  1. Introduction

  This document outlines the design for an improved WebSocket connection management system in AugmentOS Cloud, focusing on proper disconnect
  reason detection and session recovery. The new HeartbeatManager will be a session-scoped component that replaces the global health monitor
  service and eliminates dependencies on the tpa-registration system.

  2. Current System Analysis

  2.1 Current Architecture

  The current system uses three separate components for WebSocket health:

  1. HealthMonitorService: A global service that sends pings to all connections and terminates inactive ones.
  2. TpaRegistrationService: Tracks TPA sessions to enable recovery after server restarts.
  3. TpaSession reconnection logic: Client-side exponential backoff reconnection in the SDK.

  2.2 Current Issues

  1. No Distinction Between Disconnect Types: The system can't distinguish between network issues, server restarts, timeouts, or deliberate
  closures.
  2. Single Timeout Threshold: Connections are abruptly terminated after 45 seconds of inactivity with no intermediate warnings.
  3. TPA Registration Complexity: The registration system adds unnecessary complexity while not providing significant value.
  4. Limited Context for Recovery: When disconnections occur, the system lacks detailed diagnostics for intelligent recovery.

  2.3 TPA Registration Dependencies

  The TPA registration system currently:
  - Validates connections via handleTpaSessionStart
  - Tracks disconnections via handleTpaSessionEnd
  - Provides session recovery via handleTpaServerRestart

  All of these can be safely replaced with simpler, direct session management within the HeartbeatManager.

  3. HeartbeatManager Design

  3.1 Overall Approach

  The HeartbeatManager will be a session-scoped component, responsible for:

  1. Monitoring WebSocket connections for a single user session
  2. Implementing ping/pong heartbeat with detailed diagnostics
  3. Detecting and recording specific disconnect reasons
  4. Ensuring proper cleanup of resources

  3.2 Key Components

  export class HeartbeatManager {
    private glassesPingInterval: NodeJS.Timeout | null = null;
    private tpaPingInterval: NodeJS.Timeout | null = null;
    private connectionStats: Map<WebSocket, ConnectionStats> = new Map();

    constructor(private userSession: ExtendedUserSession) {
      this.userSession.logger.info(`HeartbeatManager initialized for user ${userSession.userId}`);
      this.startMonitoring();
    }

    // Other methods...
  }

  interface ConnectionStats {
    // Connection identifiers
    sessionId: string;
    packageName?: string; // For TPA connections
    startTime: number;

    // Activity tracking
    lastActivity: number;
    lastPongReceived: number;
    missedPings: number;

    // Disconnect info if applicable
    disconnectReason?: DisconnectReason;
    disconnectTime?: number;
    disconnectCode?: number;

    // Health metrics
    totalBytes: number;
    messageCount: number;
    latencies: number[]; // Recent ping-pong latencies
  }

  enum DisconnectReason {
    NORMAL_CLOSURE = 'normal_closure',
    TIMEOUT = 'timeout',
    NETWORK_ERROR = 'network_error',
    SERVER_RESTART = 'server_restart',
    HEALTH_MONITOR = 'health_monitor',
    EXPLICIT_STOP = 'explicit_stop',
    UNKNOWN = 'unknown'
  }

  3.3 Core Functionality

  3.3.1 Connection Tracking

  registerConnection(ws: WebSocket, packageName?: string): void {
    const stats: ConnectionStats = {
      sessionId: this.userSession.sessionId,
      packageName, // Undefined for glasses connection
      startTime: Date.now(),
      lastActivity: Date.now(),
      lastPongReceived: Date.now(),
      missedPings: 0,
      totalBytes: 0,
      messageCount: 0,
      latencies: []
    };

    this.connectionStats.set(ws, stats);
    this.setupListeners(ws);

    this.userSession.logger.info(
      `[HeartbeatManager] Registered ${packageName || 'glasses'} connection`
    );
  }

  unregisterConnection(ws: WebSocket): void {
    const stats = this.connectionStats.get(ws);
    if (stats) {
      // Log connection stats
      const duration = Date.now() - stats.startTime;
      this.userSession.logger.info(
        `[HeartbeatManager] Connection stats for ${stats.packageName || 'glasses'}: ` +
        `duration=${duration}ms, messages=${stats.messageCount}, bytes=${stats.totalBytes}`
      );
    }

    // Remove trackers and listeners
    this.connectionStats.delete(ws);
    this.removeListeners(ws);
  }

  3.3.2 Activity Tracking

  updateActivity(ws: WebSocket, messageSize?: number): void {
    const stats = this.connectionStats.get(ws);
    if (stats) {
      stats.lastActivity = Date.now();
      stats.messageCount++;
      if (messageSize) {
        stats.totalBytes += messageSize;
      }
    }
  }

  private setupListeners(ws: WebSocket): void {
    // Message handler to track activity
    const messageHandler = (data: Buffer | string) => {
      this.updateActivity(ws, typeof data === 'string' ? data.length : data.byteLength);
    };

    // Pong handler
    const pongHandler = () => {
      const stats = this.connectionStats.get(ws);
      if (stats) {
        const now = Date.now();
        stats.lastPongReceived = now;
        stats.missedPings = 0;

        // Track latency (time since last ping)
        const lastPingTime = stats.lastPing;
        if (lastPingTime) {
          const latency = now - lastPingTime;
          stats.latencies.push(latency);
          // Keep only last 10 latencies
          if (stats.latencies.length > 10) {
            stats.latencies.shift();
          }
        }
      }
    };

    // Add listeners
    ws.on('message', messageHandler);
    ws.on('pong', pongHandler);

    // Store handlers for later removal
    (ws as any)._heartbeatHandlers = { messageHandler, pongHandler };
  }

  private removeListeners(ws: WebSocket): void {
    const handlers = (ws as any)._heartbeatHandlers;
    if (handlers) {
      ws.off('message', handlers.messageHandler);
      ws.off('pong', handlers.pongHandler);
      delete (ws as any)._heartbeatHandlers;
    }
  }

  3.3.3 Heartbeat Implementation

  startMonitoring(): void {
    // Send pings to glasses connection at regular intervals
    this.glassesPingInterval = setInterval(() => {
      this.sendHeartbeats(false); // false = glasses connections
    }, HEARTBEAT_INTERVAL_MS);

    // Send pings to TPA connections
    this.tpaPingInterval = setInterval(() => {
      this.sendHeartbeats(true); // true = TPA connections
    }, HEARTBEAT_INTERVAL_MS);

    this.userSession.logger.info(
      `[HeartbeatManager] Started monitoring for session ${this.userSession.sessionId}`
    );
  }

  private sendHeartbeats(isTpa: boolean): void {
    const now = Date.now();

    for (const [ws, stats] of this.connectionStats.entries()) {
      // Skip if not the right connection type
      if (isTpa && !stats.packageName) continue;
      if (!isTpa && stats.packageName) continue;

      // Skip if not open
      if (ws.readyState !== WebSocket.OPEN) continue;

      try {
        // Send ping with timestamp for correlation
        const pingData = JSON.stringify({ timestamp: now, session: stats.sessionId });
        stats.lastPing = now;

        // Increment missed pings counter (will be reset on pong)
        stats.missedPings++;

        // If too many missed pings, handle potential disconnection
        if (stats.missedPings >= MAX_MISSED_PINGS) {
          this.handleInactiveConnection(ws, stats);
        } else {
          // Send ping
          ws.ping(pingData);
        }
      } catch (error) {
        this.userSession.logger.error(
          `[HeartbeatManager] Error sending ping to ${stats.packageName || 'glasses'}:`,
          error
        );
      }
    }
  }

  3.3.4 Disconnect Handling

  private handleInactiveConnection(ws: WebSocket, stats: ConnectionStats): void {
    const inactivityTime = Date.now() - stats.lastActivity;
    const pongMissingTime = Date.now() - stats.lastPongReceived;

    const isCritical = pongMissingTime > CRITICAL_INACTIVE_MS;

    if (isCritical) {
      // We need to terminate this connection as it's unresponsive
      this.userSession.logger.warn(
        `[HeartbeatManager] Connection ${stats.packageName || 'glasses'} unresponsive ` +
        `for ${pongMissingTime}ms, terminating with HEALTH_MONITOR reason`
      );

      // Record the disconnect reason and details
      stats.disconnectReason = DisconnectReason.HEALTH_MONITOR;
      stats.disconnectTime = Date.now();
      stats.disconnectCode = 4000; // Custom code for health monitor termination

      try {
        // Send close frame with custom code and reason
        ws.close(4000, 'Terminated by HeartbeatManager: no pong responses');

        // Force terminate after a short grace period if still open
        setTimeout(() => {
          if (ws.readyState !== WebSocket.CLOSED) {
            ws.terminate();
          }
        }, 1000);
      } catch (error) {
        this.userSession.logger.error(
          `[HeartbeatManager] Error terminating connection:`,
          error
        );

        // Force terminate
        try {
          ws.terminate();
        } catch (e) {
          // Ignore errors on force terminate
        }
      }
    } else {
      // Connection is inactive but not critical yet, sending one more ping
      this.userSession.logger.warn(
        `[HeartbeatManager] Connection ${stats.packageName || 'glasses'} inactive ` +
        `for ${pongMissingTime}ms, sending final ping attempt`
      );

      try {
        ws.ping();
      } catch (error) {
        // If we can't even send a ping, terminate the connection
        this.userSession.logger.error(`[HeartbeatManager] Final ping failed, terminating connection`);
        ws.terminate();
      }
    }
  }

  3.3.5 Specific Disconnect Reason Detection

  captureDisconnect(ws: WebSocket, code: number, reason: string): void {
    const stats = this.connectionStats.get(ws);
    if (!stats) return;

    // Determine disconnect reason based on code and reason text
    let disconnectReason: DisconnectReason;

    if (code === 1000 || code === 1001) {
      disconnectReason = DisconnectReason.NORMAL_CLOSURE;
    } else if (code === 4000) {
      disconnectReason = DisconnectReason.HEALTH_MONITOR;
    } else if (reason && reason.includes('App stopped')) {
      disconnectReason = DisconnectReason.EXPLICIT_STOP;
    } else if (code >= 1002 && code <= 1015) {
      disconnectReason = DisconnectReason.NETWORK_ERROR;
    } else {
      disconnectReason = DisconnectReason.UNKNOWN;
    }

    // Record disconnect details
    stats.disconnectReason = disconnectReason;
    stats.disconnectTime = Date.now();
    stats.disconnectCode = code;

    // Log detailed disconnect information
    this.userSession.logger.info(
      `[HeartbeatManager] Connection ${stats.packageName || 'glasses'} disconnected: ` +
      `reason=${disconnectReason}, code=${code}, message=${reason}, ` +
      `uptime=${stats.disconnectTime - stats.startTime}ms`
    );

    // Return captured reason for external handlers
    return {
      reason: disconnectReason,
      code,
      message: reason,
      stats: {
        uptime: stats.disconnectTime - stats.startTime,
        messageCount: stats.messageCount,
        byteCount: stats.totalBytes,
        avgLatency: stats.latencies.length > 0 ?
          stats.latencies.reduce((a, b) => a + b, 0) / stats.latencies.length : 0
      }
    };
  }

  3.4 Reconnection Timer Management

  The system manages reconnection timers to ensure proper cleanup and prevent memory leaks:

  ```typescript
  // In session.service.ts endSession method
  // Clean up any reconnection timers
  if (userSession._reconnectionTimers) {
    userSession.logger.info(`🧹 Cleaning up reconnection timers for session ${userSession.sessionId}`);
    for (const [packageName, timerId] of userSession._reconnectionTimers.entries()) {
      clearTimeout(timerId);
    }
    userSession._reconnectionTimers.clear();
  }
  ```

  These timers are also cleared when a TPA successfully reconnects:

  ```typescript
  // In handleTpaInit method
  // Check if there's a pending reconnection timer and clear it
  if (userSession._reconnectionTimers && userSession._reconnectionTimers.has(initMessage.packageName)) {
    userSession.logger.info(
      `[websocket.service]: Clearing reconnection timer for ${initMessage.packageName} - app successfully reconnected`
    );
    clearTimeout(userSession._reconnectionTimers.get(initMessage.packageName));
    userSession._reconnectionTimers.delete(initMessage.packageName);
  }
  ```

  3.5 Integration with WebSocket Service

  The HeartbeatManager will be instantiated as part of the ExtendedUserSession:

  // In session.service.ts
  interface ExtendedUserSession extends UserSession {
    // ...existing properties
    heartbeatManager: HeartbeatManager;
    // Map to track reconnection timers for zombie app prevention
    _reconnectionTimers?: Map<string, NodeJS.Timeout>;
  }

  // In createSession method
  const userSession = partialSession as ExtendedUserSession;
  userSession.heartbeatManager = new HeartbeatManager(userSession);

  In the WebSocket service, we'll update the connection handlers:

  // In handleGlassesConnection method
  ws.on('close', (code, reason) => {
    // Capture detailed disconnect information
    const disconnectInfo = userSession.heartbeatManager.captureDisconnect(ws, code, reason);

    userSession.logger.info(
      `[websocket.service]: Glasses WebSocket disconnected: ${disconnectInfo.reason}`
    );

    // Mark session as disconnected but keep it for grace period
    this.getSessionService().markSessionDisconnected(userSession);

    // Grace period for potential reconnection
    setTimeout(() => {
      if (userSession.websocket.readyState === WebSocket.CLOSED) {
        this.getSessionService().endSession(userSession);
      }
    }, RECONNECT_GRACE_PERIOD_MS);

    // Tracking and analytics
    const endTimestamp = new Date();
    const connectionDuration = endTimestamp.getTime() - startTimestamp.getTime();
    PosthogService.trackEvent('disconnected', userSession.userId, {
      userId: userSession.userId,
      sessionId: userSession.sessionId,
      timestamp: new Date().toISOString(),
      duration: connectionDuration,
      disconnectReason: disconnectInfo.reason
    });
  });

  3.5 Removing TPA Registration

  To safely remove TPA Registration, we'll:

  1. Remove initialization and imports:
  // Remove from websocket.service.ts
  import tpaRegistrationService from './tpa-registration.service';
  2. Remove validation in handleTpaInit:
  // Replace this code:
  const isValidTpa = tpaRegistrationService.handleTpaSessionStart(initMessage);
  if (!isSystemApp && !isValidTpa) {
    userSession.logger.warn(`Unregistered TPA attempting to connect: ${initMessage.packageName}`);
  }

  // With simpler validation just using appService:
  const isValidApp = await appService.isValidApp(initMessage.packageName, initMessage.apiKey);
  if (!isValidApp && !isSystemApp) {
    userSession.logger.warn(`Invalid TPA attempting to connect: ${initMessage.packageName}`);
  }
  3. Remove handleTpaSessionEnd call:
  // Remove this line in ws.on('close', ...) handler:
  tpaRegistrationService.handleTpaSessionEnd(currentAppSession);
  4. Remove the API Routes:
    - Delete the entire tpa-server.routes.ts file
    - Remove the route registration in app.ts or index.ts
  5. Delete the service and model files:
    - tpa-registration.service.ts
    - tpa-server.model.ts

  4. Implementation Plan

  4.1 Phase 1: Create HeartbeatManager

  1. Implement HeartbeatManager class
  2. Integrate with ExtendedUserSession
  3. Add connection monitoring and ping/pong handling
  4. Add the `_reconnectionTimers` property to ExtendedUserSession for tracking reconnection grace periods

  4.2 Phase 2: Enhance Disconnect Reason Tracking

  1. Implement disconnect reason detection
  2. Add disconnect information collection
  3. Update WebSocket service to use captured disconnect info

  4.3 Phase 3: Safely Remove TPA Registration

  1. Update WebSocket service to remove tpaRegistrationService calls
  2. Clean up imports and dependencies
  3. Remove API routes and endpoints
  4. Delete the service and model files

  4.4 Phase 4: Testing and Verification

  1. Test WebSocket reconnection with different disconnect scenarios
  2. Verify correct disconnect reason detection
  3. Ensure no regressions in connection handling
  4. Test recovery from various failure cases

  5. Expected Benefits

  1. Clear Disconnect Information: Accurate disconnect reasons help with debugging and recovery
  2. Simplified Architecture: Removing TPA registration reduces complexity
  3. Session-Scoped Management: Each session handles its own connection health
  4. Better Metrics: More detailed connection stats for monitoring and analysis
  5. Improved Recovery: Smarter reconnection based on specific disconnect reasons

  6. Auto-Restart Configuration

  The auto-restart functionality can be controlled through configuration flags defined at the top of the websocket.service.ts file:

  ```typescript
  // Constants
  const TPA_SESSION_TIMEOUT_MS = 5000;  // 5 seconds
  const LOG_AUDIO = false;               // Whether to log audio processing details
  const AUTO_RESTART_APPS = true;        // Whether to automatically try to restart apps after disconnection
  const AUTO_RESTART_DELAY_MS = 500;     // Delay before attempting auto-restart
  ```

  These flags enable:
  - Toggling the auto-restart functionality on/off without code changes
  - Adjusting the delay before attempting restart
  - Easy configuration in different environments

  7. App State Consistency Improvements

  During implementation review, we identified a potential issue where apps with unexpectedly terminated connections may still appear active to users.
  This "zombie app" state occurs because:

  1. When a TPA connection unexpectedly drops, the WebSocket connection is removed from `userSession.appConnections`
  2. However, the app isn't automatically removed from `userSession.activeAppSessions`
  3. The glasses client isn't notified of the connection drop with an updated `AppStateChange` message

  To address this UI consistency issue, we'll modify the WebSocket close and error handlers to:

  1. Implement a 5-second reconnection grace period before removing apps from the active list
  2. Remove the app from the `activeAppSessions` array only after this grace period expires
  3. Send an updated `AppStateChange` message to the glasses client after grace period
  4. Log appropriate error messages for easier debugging
  5. Update the display system to reflect the current app state only if reconnection doesn't occur
  6. Automatically attempt to restart the app after a brief delay if it fails to reconnect during the grace period

  This multi-layered recovery approach includes:
  - A 5-second grace period giving client-side reconnection logic time to work
  - Automatic server-side restart attempt if client reconnection fails
  - Configurable toggle flag to enable/disable the auto-restart behavior
  - Proper timer management using the `_reconnectionTimers` map in ExtendedUserSession
  - Comprehensive cleanup of timers when sessions end

  These mechanisms ensure maximum resilience against temporary network issues and connection problems,
  minimizing disruption to the user experience while still properly handling truly disconnected applications.

  This will ensure users have an accurate view of which apps are actually running, and aren't confused by stale app states
  when connections have dropped unexpectedly.

  8. Conclusion
  
  The redesigned HeartbeatManager provides a cleaner, more effective approach to WebSocket connection health monitoring, with clear disconnect
  reason tracking and without the unnecessary complexity of the TPA registration system. The enhanced app state synchronization
  ensures that the user interface accurately reflects the true state of application connections. By focusing on the actual needs of reliable connections,
  proper error diagnostics, and user interface consistency, we significantly improve the overall reliability and user experience of
  the AugmentOS Cloud platform.