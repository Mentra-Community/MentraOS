/**
 * Health Monitor Service
 * 
 * Monitors the health of connections and services in the AugmentOS Cloud system.
 * This service is responsible for:
 * - Sending heartbeats to clients
 * - Monitoring WebSocket connection health
 * - Detecting and cleaning up stale connections
 * - Logging system health statistics
 */

import { WebSocket } from 'ws';
import { logger as rootLogger} from '../logging';
const logger = rootLogger.child({ service: 'health-monitor.service' });

// Constants
const HEARTBEAT_INTERVAL_MS = 15000; // 15 seconds
const CONNECTION_TIMEOUT_MS = 45000; // 45 seconds
const STATS_INTERVAL_MS = 60000; // 1 minute

/**
 * Service for monitoring the health of the system
 */
export class HealthMonitorService {
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private statsInterval: NodeJS.Timeout | null = null;
  
  // Maps to track last seen times for connections
  private glassesLastSeen: Map<WebSocket, number> = new Map();
  private tpaLastSeen: Map<WebSocket, number> = new Map();
  
  constructor() {
    this.startMonitoring();
  }
  
  /**
   * Start monitoring services
   */
  startMonitoring(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }
    
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
    }
    
    // Set up heartbeat interval
    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeats();
      this.checkConnectionTimeouts();
    }, HEARTBEAT_INTERVAL_MS);
    
    // Set up stats logging interval
    this.statsInterval = setInterval(() => {
      this.logSystemStats();
    }, STATS_INTERVAL_MS);
    
    logger.info('Health monitor started');
  }
  
  /**
   * Stop monitoring services
   */
  stopMonitoring(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }
    
    logger.info('Health monitor stopped');
  }
  
  /**
   * Register a new glasses connection to monitor
   * 
   * @param ws - WebSocket connection to monitor
   */
  registerGlassesConnection(ws: WebSocket): void {
    this.glassesLastSeen.set(ws, Date.now());
    
    // Set up ping/pong handler
    ws.on('pong', () => {
      this.glassesLastSeen.set(ws, Date.now());
    });
    
    // Clean up on close
    ws.on('close', () => {
      this.glassesLastSeen.delete(ws);
    });
  }
  
  /**
   * Register a new TPA connection to monitor
   * 
   * @param ws - WebSocket connection to monitor
   */
  registerTpaConnection(ws: WebSocket): void {
    this.tpaLastSeen.set(ws, Date.now());
    
    // Set up ping/pong handler
    ws.on('pong', () => {
      this.tpaLastSeen.set(ws, Date.now());
    });
    
    // Clean up on close
    ws.on('close', () => {
      this.tpaLastSeen.delete(ws);
    });
  }
  
  /**
   * Record activity for a glasses connection
   * 
   * @param ws - WebSocket connection that had activity
   */
  updateGlassesActivity(ws: WebSocket): void {
    this.glassesLastSeen.set(ws, Date.now());
  }
  
  /**
   * Record activity for a TPA connection
   * 
   * @param ws - WebSocket connection that had activity
   */
  updateTpaActivity(ws: WebSocket): void {
    this.tpaLastSeen.set(ws, Date.now());
  }
  
  /**
   * Send heartbeats to all connections
   */
  private sendHeartbeats(): void {
    const now = Date.now();
    
    // Send ping to glasses connections
    for (const [ws, lastSeen] of this.glassesLastSeen.entries()) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.ping();
        } catch (error) {
          logger.error('[health-monitor.service] Error sending ping to glasses:', error);
        }
      }
    }
    
    // Send ping to TPA connections
    for (const [ws, lastSeen] of this.tpaLastSeen.entries()) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.ping();
        } catch (error) {
          logger.error('[health-monitor.service] Error sending ping to TPA:', error);
        }
      }
    }
  }
  
  /**
   * Check for and close timed out connections
   */
  private checkConnectionTimeouts(): void {
    const now = Date.now();
    const timeoutThreshold = now - CONNECTION_TIMEOUT_MS;
    logger.debug(`[health-monitor.service] Checking for timed out connections (threshold: ${timeoutThreshold})`);
    // Check glasses connections
    for (const [ws, lastSeen] of this.glassesLastSeen.entries()) {
      if (lastSeen < timeoutThreshold && ws.readyState === WebSocket.OPEN) {
        logger.warn('[health-monitor.service] Glasses connection timed out, closing');
        try {
          ws.terminate();
        } catch (error) {
          logger.error('[health-monitor.service] Error terminating glasses connection:', error);
        }
        this.glassesLastSeen.delete(ws);
      }
    }
    
    // Check TPA connections
    for (const [ws, lastSeen] of this.tpaLastSeen.entries()) {
      if (lastSeen < timeoutThreshold && ws.readyState === WebSocket.OPEN) {
        logger.warn('[health-monitor.service] TPA connection timed out, closing');
        try {
          ws.terminate();
        } catch (error) {
          logger.error('[health-monitor.service] Error terminating TPA connection:', error);
        }
        this.tpaLastSeen.delete(ws);
      }
    }
  }
  
  /**
   * Log system health statistics
   */
  private logSystemStats(): void {
    // Since sessionService doesn't have getSessionCount method,
    // we'll just use the connection counts we have directly
    const activeGlassesConnections = this.glassesLastSeen.size;
    const activeTpaConnections = this.tpaLastSeen.size;
    
    logger.debug(`[health-monitor.service] System Stats: 
      - Glasses Connections: ${activeGlassesConnections}
      - TPA Connections: ${activeTpaConnections}
    `);
  }
}

// Singleton instance
export const healthMonitorService = new HealthMonitorService();
export default healthMonitorService;