/**
 * HeartbeatManager
 * 
 * Session-scoped manager for WebSocket connection health monitoring.
 * Replaces both the global health monitor service and TPA registration system with
 * a simpler, more targeted approach to connection health tracking and disconnect detection.
 */

import { WebSocket } from 'ws';
import { ExtendedUserSession } from './session.service';
import { logger as rootLogger } from "../logging";
const logger = rootLogger.child({ service: 'HeartbeatManager' });

// Constants
const HEARTBEAT_INTERVAL_MS = 15000; // 15 seconds
const MAX_MISSED_PINGS = 3; // Consider disconnected after 3 missed pings
const CRITICAL_INACTIVE_MS = 45000; // 45 seconds (same as previous timeout)

/**
 * Detailed connection statistics for monitoring and diagnostics
 */
interface ConnectionStats {
  // Connection identifiers
  sessionId: string;
  packageName?: string; // For TPA connections
  startTime: number;

  // Activity tracking
  lastActivity: number;
  lastPongReceived: number;
  missedPings: number;
  lastPing?: number;

  // Disconnect info if applicable
  disconnectReason?: DisconnectReason;
  disconnectTime?: number;
  disconnectCode?: number;

  // Health metrics
  totalBytes: number;
  messageCount: number;
  latencies: number[]; // Recent ping-pong latencies
}

/**
 * Specific disconnect reasons to enable better diagnostics and recovery
 */
enum DisconnectReason {
  NORMAL_CLOSURE = 'normal_closure',
  TIMEOUT = 'timeout',
  NETWORK_ERROR = 'network_error',
  SERVER_RESTART = 'server_restart',
  HEALTH_MONITOR = 'health_monitor',
  EXPLICIT_STOP = 'explicit_stop',
  UNKNOWN = 'unknown'
}

/**
 * Detailed information about a disconnection event
 */
export interface DisconnectInfo {
  reason: DisconnectReason;
  code: number;
  message: string;
  stats: {
    uptime: number;
    messageCount: number;
    byteCount: number;
    avgLatency: number;
  };
}

/**
 * Session-scoped manager for WebSocket connection health
 */
export class HeartbeatManager {
  private glassesPingInterval: NodeJS.Timeout | null = null;
  private tpaPingInterval: NodeJS.Timeout | null = null;
  private connectionStats: Map<WebSocket, ConnectionStats> = new Map();

  constructor(private userSession: ExtendedUserSession) {
    this.userSession.logger.info(`[HeartbeatManager] Initialized for user ${userSession.userId}`);
    this.startMonitoring();
  }

  /**
   * Register a glasses connection for health monitoring
   * 
   * @param ws WebSocket connection to monitor
   */
  registerGlassesConnection(ws: WebSocket): void {
    this.registerConnection(ws);
  }

  /**
   * Register a TPA connection for health monitoring
   * 
   * @param ws WebSocket connection to monitor
   * @param packageName Package name of the TPA
   */
  registerTpaConnection(ws: WebSocket, packageName: string): void {
    this.registerConnection(ws, packageName);
  }

  /**
   * General connection registration with optional package name
   * 
   * @param ws WebSocket connection to monitor
   * @param packageName Optional package name for TPA connections
   */
  private registerConnection(ws: WebSocket, packageName?: string): void {
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

  /**
   * Update activity timestamp for a glasses connection
   * 
   * @param ws WebSocket connection that had activity
   * @param messageSize Optional size of the message in bytes
   */
  updateGlassesActivity(ws: WebSocket, messageSize?: number): void {
    this.updateActivity(ws, messageSize);
  }

  /**
   * Update activity timestamp for a TPA connection
   * 
   * @param ws WebSocket connection that had activity
   * @param messageSize Optional size of the message in bytes
   */
  updateTpaActivity(ws: WebSocket, messageSize?: number): void {
    this.updateActivity(ws, messageSize);
  }

  /**
   * Update activity for any connection type
   * 
   * @param ws WebSocket connection that had activity
   * @param messageSize Optional size of the message in bytes
   */
  private updateActivity(ws: WebSocket, messageSize?: number): void {
    const stats = this.connectionStats.get(ws);
    if (stats) {
      stats.lastActivity = Date.now();
      stats.messageCount++;
      if (messageSize) {
        stats.totalBytes += messageSize;
      }
    }
  }

  /**
   * Remove connection from monitoring when closed
   * 
   * @param ws WebSocket connection to unregister
   */
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

  /**
   * Start the heartbeat monitoring for all connections
   */
  private startMonitoring(): void {
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

  /**
   * Set up event listeners for a connection
   * 
   * @param ws WebSocket connection to set up listeners for
   */
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

  /**
   * Remove event listeners from a connection
   * 
   * @param ws WebSocket connection to remove listeners from
   */
  private removeListeners(ws: WebSocket): void {
    const handlers = (ws as any)._heartbeatHandlers;
    if (handlers) {
      ws.off('message', handlers.messageHandler);
      ws.off('pong', handlers.pongHandler);
      delete (ws as any)._heartbeatHandlers;
    }
  }

  /**
   * Send heartbeats to a specific connection type
   * 
   * @param isTpa Whether to send to TPA connections (true) or glasses connections (false)
   */
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

  /**
   * Handle an inactive connection that has missed too many pings
   * 
   * @param ws WebSocket connection that is inactive
   * @param stats Connection statistics
   */
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

  /**
   * Capture detailed information about a disconnection
   * 
   * @param ws WebSocket connection that disconnected
   * @param code Close code
   * @param reason Close reason
   * @returns DisconnectInfo object with detailed diagnostics
   */
  captureDisconnect(ws: WebSocket, code: number, reason: string): DisconnectInfo | undefined {
    const stats = this.connectionStats.get(ws);
    if (!stats) return undefined;

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

  /**
   * Clean up all resources used by this manager
   */
  dispose(): void {
    this.userSession.logger.info(`[HeartbeatManager] Disposing for session ${this.userSession.sessionId}`);
    
    // Clear intervals
    if (this.glassesPingInterval) {
      clearInterval(this.glassesPingInterval);
      this.glassesPingInterval = null;
    }
    
    if (this.tpaPingInterval) {
      clearInterval(this.tpaPingInterval);
      this.tpaPingInterval = null;
    }
    
    // Clean up any remaining connections
    for (const [ws, stats] of this.connectionStats.entries()) {
      this.removeListeners(ws);
    }
    
    this.connectionStats.clear();
  }
}