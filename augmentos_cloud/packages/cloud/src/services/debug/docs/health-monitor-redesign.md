# Health Monitor Service Redesign

## Current Architecture Analysis

The current health monitor service for WebSocket connections has several limitations in its design:

1. **Global Singleton Pattern**:
   - The current implementation is a singleton service that manages all connections globally
   - This makes it difficult to associate WebSockets with specific TPAs or users
   - State tracking becomes complex across many different connections

2. **Limited Connection Metadata**:
   - WebSockets are stored in simple Maps with their timestamps
   - No additional metadata is stored about who owns the connection or what it's for
   - Makes logging and debugging extremely difficult

3. **Uncoordinated State Management**:
   - Terminating connections isn't coordinated with other services
   - The WebSocket service isn't informed when health monitor closes connections
   - Results in user sessions having stale WebSocket references

4. **Blunt Termination Mechanism**:
   - Uses `ws.terminate()` instead of the more graceful `ws.close()`
   - Client-side handlers may not be properly triggered
   - Denied opportunity for graceful cleanup or reconnection

## Proposed Architecture: Per-Session Health Monitor

### Core Design Principles

1. **Manager Style Pattern**:
   - Each user session should have its own health monitor instance
   - Follows the standard AugmentOS manager pattern
   - Consistent with other session-scoped services

2. **Enhanced Connection Identity**:
   - Clear association between connections and their owners
   - Store metadata with each connection
   - Better logging and debugging capabilities

3. **Coordinated State Management**:
   - Health monitor works in coordination with WebSocket service
   - State is synchronized across components
   - Clean up references when connections end

4. **Graceful Connection Handling**:
   - Use proper WebSocket closure mechanisms
   - Inform clients with proper close codes and reasons
   - Allow for clean reconnection where appropriate

### Implementation Components

#### 1. SessionHealthMonitor Class

```typescript
class SessionHealthMonitor {
  private connections: Map<WebSocket, {
    type: 'glasses' | 'tpa';
    lastSeen: number;
    metadata: {
      packageName?: string;
      appId?: string;
      connectionId: string;
    }
  }>;
  
  constructor(private userSession: ExtendedUserSession) {
    this.connections = new Map();
    this.startMonitoring();
  }
  
  // Methods for connection management
  registerConnection(ws: WebSocket, type: 'glasses' | 'tpa', metadata: any) {...}
  unregisterConnection(ws: WebSocket) {...}
  updateActivity(ws: WebSocket) {...}
  
  // Health checking
  private startMonitoring() {...}
  private sendHeartbeats() {...}
  private checkTimeouts() {...}
}
```

#### 2. ExtendedUserSession Integration

```typescript
interface ExtendedUserSession extends UserSession {
  healthMonitor: SessionHealthMonitor;
  // ... other properties
}

// Usage in session creation
const userSession = {
  // ... other properties
  healthMonitor: new SessionHealthMonitor(userSession)
};
```

#### 3. Coordinated WebSocket Closure

```typescript
// In SessionHealthMonitor
private handleTimeout(ws: WebSocket, metadata: ConnectionMetadata): void {
  // Log with detailed identification
  this.userSession.logger.warn(
    `Connection timed out: ${metadata.type} ${metadata.packageName || 'unknown'}`
  );
  
  // Graceful closure
  try {
    // Close with specific code and reason
    ws.close(1001, 'Connection timeout detected');
    
    // Update session state
    if (metadata.type === 'tpa' && metadata.packageName) {
      this.userSession.appConnections.delete(metadata.packageName);
    }
    
    // Remove from tracking
    this.connections.delete(ws);
  } catch (error) {
    this.userSession.logger.error('Error closing timed out connection:', error);
    // Fallback to terminate if close fails
    try {
      ws.terminate();
    } catch {
      // Last resort handling
    }
  }
}
```

#### 4. Heartbeat Mechanism

```typescript
private sendHeartbeats(): void {
  const now = Date.now();
  
  for (const [ws, connectionInfo] of this.connections.entries()) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        // Send ping with payload for better tracking
        const pingId = crypto.randomUUID().slice(0, 8);
        ws.ping(pingId);
        
        // Log detailed heartbeat info if debug enabled
        if (this.userSession.debug) {
          this.userSession.logger.debug(
            `Heartbeat sent to ${connectionInfo.metadata.packageName || 'unknown'} [${pingId}]`
          );
        }
      } catch (error) {
        this.userSession.logger.error(`Error sending heartbeat:`, error);
      }
    }
  }
}
```

## Migration Strategy

To migrate from the current global health monitor to session-specific monitors:

1. **Staged Transition**:
   - Initially run both systems in parallel
   - Gradually transition tracking to session-specific monitors
   - After validation, phase out the global monitor

2. **WebSocket Registration Refactoring**:
   - Update the `registerTpaConnection` and `registerGlassesConnection` methods
   - Route registrations to the appropriate session health monitor
   - Ensure existing connections aren't disrupted during upgrade

3. **Graceful Upgrade**:
   - Implement feature toggling to control enabling the new system
   - Roll out incrementally to reduce risk
   - Monitor for unexpected behaviors during transition

## Improved Diagnostics

The new design enables much richer diagnostics:

1. **Connection Lifecycle Logging**:
   ```
   [User: alice@example.com] TPA connection registered: com.example.app1
   [User: alice@example.com] Heartbeat sent to com.example.app1 [f7a2e9b1]
   [User: alice@example.com] Connection timed out: tpa com.example.app1
   ```

2. **Session-Based Metrics**:
   - Track health statistics per session
   - Identify problematic TPAs or sessions
   - Generate aggregated health reports

3. **Improved API**:
   - Provide dashboard endpoints to view connection health
   - Enable querying connection status by user, package name, etc.
   - Expose health metrics for monitoring systems

## Expected Benefits

1. **Better TPA Reliability**:
   - Fewer unexplained disconnections
   - Proper reconnection behavior
   - Better handling of network interruptions

2. **Improved Debugging**:
   - Clear identification of connection issues
   - Connection events are linked to specific TPAs and sessions
   - Detailed logs for troubleshooting

3. **Better Resource Management**:
   - Cleaner cleanup of stale connections
   - Coordinated state management
   - Reduced resource leaks

4. **Enhanced User Experience**:
   - Fewer disconnection errors for users
   - More reliable dashboard and TPAs
   - Automatic recovery from temporary network issues

## Conclusion

This redesign of the health monitor service will significantly improve the reliability and observability of WebSocket connections in AugmentOS. By moving to a session-scoped model with proper connection identification and coordinated state management, we'll address the core issues seen in the current system.