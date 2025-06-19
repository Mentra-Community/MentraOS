# AppManager Design Document

## Overview

The AppManager is a specialized component responsible for managing app/TPA lifecycle within a user session. It follows the manager pattern established by other components like DisplayManager and MicrophoneManager. The AppManager encapsulates all app-related functionality that is currently embedded in the session service, improving separation of concerns and code organization.

## Current Implementation Details

### Current Location of App Management

Currently, app lifecycle management is implemented across multiple functions in `session.service.ts`:

```typescript
async startAppSession(userSession: ExtendedUserSession, packageName: string): Promise<void> {
  // Implementation details...
}

async stopAppSession(userSession: ExtendedUserSession, packageName: string): Promise<void> {
  // Implementation details...
}

isAppRunning(userSession: ExtendedUserSession, packageName: string): boolean {
  // Implementation details...
}

async handleTpaInit(ws: WebSocket, initMessage: TpaConnectionInit, setCurrentSessionId: Function): Promise<void> {
  // Implementation details...
}

async handleAppStateBroadcast(userSession: ExtendedUserSession): Promise<void> {
  // Implementation details...
}

async triggerAppStateChange(userId: string): Promise<void> {
  // Implementation details...
}
```

### Current Issues

1. **Mixed Concerns**: Session service handles both session management and app lifecycle
2. **Scattered Code**: App-related functions are spread throughout the service
3. **Large Service**: Adding app functions to session service makes it unwieldy
4. **Unclear Ownership**: Responsibility for app state is split between session and app logic

## Important Implementation Note

**Regarding Subscription Management**: Although our design might suggest using a subscription manager, the implementation should continue using the existing `subscriptionService` instead. The `SubscriptionManager` is not fully implemented yet, and using it would be risky. We should stick with the proven `subscriptionService` to ensure stability during refactoring.

Example of how to use the subscription service:
```typescript
// Instead of this.userSession.subscriptionManager.getSubscribers(StreamType.AUDIO_CHUNK)
const subscribedPackageNames = subscriptionService.getSubscribedApps(this.userSession, StreamType.AUDIO_CHUNK);
```

## Proposed Implementation

### AppManager Class

```typescript
/**
 * Manages app lifecycle and TPA connections for a user session
 */
export class AppManager {
  private userSession: ExtendedUserSession;
  private logger: Logger;
  
  // Cache of installed apps
  private installedApps: AppI[] = [];
  
  constructor(userSession: ExtendedUserSession) {
    this.userSession = userSession;
    this.logger = userSession.logger.child({ component: 'AppManager' });
    this.installedApps = userSession.installedApps || [];
    this.logger.info('AppManager initialized');
  }
  
  /**
   * Start an app by package name
   * 
   * @param packageName Package name of the app to start
   */
  async startApp(packageName: string): Promise<void> {
    try {
      if (this.isAppRunning(packageName)) {
        this.logger.info(`App ${packageName} already running, ignoring start request`);
        return;
      }
      
      this.logger.info(`Starting app ${packageName}`);
      
      // Add to loading apps
      this.userSession.loadingApps.add(packageName);
      
      // Trigger app start webhook
      try {
        await appService.triggerStartByPackageName(packageName, this.userSession.userId);
      } catch (webhookError) {
        this.logger.error(`Error triggering start webhook for ${packageName}:`, webhookError);
      }
      
      // Add to active app sessions if not already present
      if (!this.userSession.activeAppSessions.includes(packageName)) {
        this.userSession.activeAppSessions.push(packageName);
      }
      
      // Remove from loading apps
      this.userSession.loadingApps.delete(packageName);
      
      // Broadcast app state change
      await this.broadcastAppState();
      
    } catch (error) {
      this.logger.error(`Error starting app ${packageName}:`, error);
      // Remove from loading apps in case of error
      this.userSession.loadingApps.delete(packageName);
    }
  }
  
  /**
   * Stop an app by package name
   * 
   * @param packageName Package name of the app to stop
   */
  async stopApp(packageName: string): Promise<void> {
    try {
      if (!this.isAppRunning(packageName)) {
        this.logger.info(`App ${packageName} not running, ignoring stop request`);
        return;
      }
      
      this.logger.info(`Stopping app ${packageName}`);
      
      // Remove from active app sessions
      this.userSession.activeAppSessions = this.userSession.activeAppSessions.filter(
        app => app !== packageName
      );
      
      // Trigger app stop webhook
      try {
        await appService.triggerStopByPackageName(packageName, this.userSession.userId);
      } catch (webhookError) {
        this.logger.error(`Error triggering stop webhook for ${packageName}:`, webhookError);
      }
      
      // Broadcast app state change
      await this.broadcastAppState();
      
      // Close WebSocket connection if exists
      const connection = this.userSession.appConnections.get(packageName);
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
          this.logger.error(`Error closing connection for ${packageName}:`, closeError);
        }
      }
      
      // Remove from app connections
      this.userSession.appConnections.delete(packageName);
      
    } catch (error) {
      this.logger.error(`Error stopping app ${packageName}:`, error);
    }
  }
  
  /**
   * Check if an app is currently running
   * 
   * @param packageName Package name to check
   * @returns Whether the app is running
   */
  isAppRunning(packageName: string): boolean {
    return this.userSession.activeAppSessions.includes(packageName);
  }
  
  /**
   * Handle TPA initialization
   * 
   * @param ws WebSocket connection
   * @param initMessage TPA initialization message
   */
  async handleTpaInit(ws: WebSocket, initMessage: TpaConnectionInit): Promise<void> {
    try {
      const { packageName, apiKey, sessionId } = initMessage;
      
      // Validate the API key
      const isValidApiKey = await developerService.validateApiKey(packageName, apiKey);
      
      if (!isValidApiKey) {
        this.logger.error(`Invalid API key for TPA ${packageName}`);
        
        try {
          ws.send(JSON.stringify({
            type: CloudToTpaMessageType.CONNECTION_ERROR,
            code: 'INVALID_API_KEY',
            message: 'Invalid API key',
            timestamp: new Date()
          }));
          
          ws.close(1008, 'Invalid API key');
        } catch (sendError) {
          this.logger.error(`Error sending auth error to TPA ${packageName}:`, sendError);
        }
        
        return;
      }
      
      // Store the WebSocket connection
      this.userSession.appConnections.set(packageName, ws);
      
      // Add to active app sessions if not already present
      if (!this.userSession.activeAppSessions.includes(packageName)) {
        this.userSession.activeAppSessions.push(packageName);
      }
      
      // Get app settings
      const app = this.userSession.installedApps.find(app => app.packageName === packageName);
      
      // Send connection acknowledgment
      const ackMessage = {
        type: CloudToTpaMessageType.CONNECTION_ACK,
        sessionId: sessionId,
        settings: app?.settings || [],
        timestamp: new Date()
      };
      
      ws.send(JSON.stringify(ackMessage));
      
      // Log successful connection
      this.logger.info(`TPA ${packageName} connected to session ${this.userSession.sessionId}`);
      
      // Track connection in analytics
      PosthogService.trackEvent('tpa_connection', this.userSession.userId, {
        packageName,
        sessionId: this.userSession.sessionId,
        timestamp: new Date().toISOString()
      });
      
      // Broadcast app state change
      await this.broadcastAppState();
      
    } catch (error) {
      this.logger.error(`Error handling TPA init:`, error);
      
      try {
        ws.send(JSON.stringify({
          type: CloudToTpaMessageType.CONNECTION_ERROR,
          code: 'INTERNAL_ERROR',
          message: 'Internal server error',
          timestamp: new Date()
        }));
        
        ws.close(1011, 'Internal server error');
      } catch (sendError) {
        this.logger.error(`Error sending internal error to TPA:`, sendError);
      }
    }
  }
  
  /**
   * Broadcast app state to connected clients
   */
  async broadcastAppState(): Promise<void> {
    try {
      if (!this.userSession.websocket || this.userSession.websocket.readyState !== WebSocket.OPEN) {
        this.logger.error(`WebSocket is not open for client app state change`);
        return;
      }
      
      // Refresh installed apps
      await this.refreshInstalledApps();
      
      // Transform session for client
      const sessionService = getSessionService();
      const clientSessionData = await sessionService.transformUserSessionForClient(this.userSession);
      
      // Create app state change message
      const appStateChange: AppStateChange = {
        type: CloudToGlassesMessageType.APP_STATE_CHANGE,
        sessionId: this.userSession.sessionId,
        userSession: clientSessionData,
        timestamp: new Date()
      };
      
      // Send to client
      this.userSession.websocket.send(JSON.stringify(appStateChange));
      this.logger.info(`Sent APP_STATE_CHANGE to ${this.userSession.userId}`);
      
    } catch (error) {
      this.logger.error(`Error broadcasting app state:`, error);
    }
  }
  
  /**
   * Refresh the installed apps list
   */
  async refreshInstalledApps(): Promise<void> {
    try {
      // Fetch installed apps
      const installedApps = await appService.getAllApps(this.userSession.userId);
      
      // Update session's installed apps
      this.userSession.installedApps = installedApps;
      
      // Update local cache
      this.installedApps = installedApps;
      
      this.logger.info(`Updated installed apps for ${this.userSession.userId}`);
    } catch (error) {
      this.logger.error(`Error refreshing installed apps:`, error);
    }
  }
  
  /**
   * Start all previously running apps
   */
  async startPreviouslyRunningApps(): Promise<void> {
    try {
      // Fetch previously running apps from database
      const previouslyRunningApps = await appService.getPreviouslyRunningApps(this.userSession.userId);
      
      if (previouslyRunningApps.length === 0) {
        this.logger.info(`No previously running apps for ${this.userSession.userId}`);
        return;
      }
      
      this.logger.info(`Starting ${previouslyRunningApps.length} previously running apps for ${this.userSession.userId}`);
      
      // Start each app
      for (const packageName of previouslyRunningApps) {
        try {
          await this.startApp(packageName);
        } catch (error) {
          this.logger.error(`Error starting previously running app ${packageName}:`, error);
          // Continue with other apps
        }
      }
    } catch (error) {
      this.logger.error(`Error starting previously running apps:`, error);
    }
  }
  
  /**
   * Handle app connection close
   * 
   * @param packageName Package name
   * @param code Close code
   * @param reason Close reason
   */
  async handleAppConnectionClosed(packageName: string, code: number, reason: string): Promise<void> {
    try {
      this.logger.info(`App connection closed for ${packageName}: ${code} - ${reason}`);
      
      // Remove from app connections
      this.userSession.appConnections.delete(packageName);
      
      // Don't automatically remove from active app sessions
      // The app can reconnect without losing its active status
      
      // Set up reconnection timer
      if (!this.userSession._reconnectionTimers) {
        this.userSession._reconnectionTimers = new Map();
      }
      
      // Clear any existing timer
      const existingTimer = this.userSession._reconnectionTimers.get(packageName);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }
      
      // Set new timer
      const reconnectionTimer = setTimeout(() => {
        this.logger.info(`Reconnection grace period expired for ${packageName}`);
        
        // If not reconnected, remove from active app sessions
        if (!this.userSession.appConnections.has(packageName)) {
          this.userSession.activeAppSessions = this.userSession.activeAppSessions.filter(
            app => app !== packageName
          );
          
          // Broadcast app state change
          this.broadcastAppState().catch(error => {
            this.logger.error(`Error broadcasting app state after reconnection timeout:`, error);
          });
        }
        
        // Remove the timer from the map
        this.userSession._reconnectionTimers?.delete(packageName);
      }, 60000); // 1 minute reconnection grace period
      
      // Store the timer
      this.userSession._reconnectionTimers.set(packageName, reconnectionTimer);
      
    } catch (error) {
      this.logger.error(`Error handling app connection close for ${packageName}:`, error);
    }
  }
  
  /**
   * Clean up all resources
   */
  dispose(): void {
    try {
      this.logger.info('Disposing AppManager');
      
      // Clear reconnection timers
      if (this.userSession._reconnectionTimers) {
        for (const [packageName, timer] of this.userSession._reconnectionTimers.entries()) {
          clearTimeout(timer);
        }
        this.userSession._reconnectionTimers.clear();
      }
      
      // Close all app connections
      for (const [packageName, connection] of this.userSession.appConnections.entries()) {
        if (connection && connection.readyState === WebSocket.OPEN) {
          try {
            // Send app stopped message
            const message = {
              type: CloudToTpaMessageType.APP_STOPPED,
              timestamp: new Date()
            };
            connection.send(JSON.stringify(message));
            
            // Close the connection
            connection.close(1000, 'User session ended');
          } catch (error) {
            this.logger.error(`Error closing connection for ${packageName}:`, error);
          }
        }
      }
      
      // Clear connections
      this.userSession.appConnections.clear();
      
      // Clear active app sessions
      this.userSession.activeAppSessions = [];
      
      // Clear loading apps
      this.userSession.loadingApps.clear();
      
    } catch (error) {
      this.logger.error(`Error disposing AppManager:`, error);
    }
  }
}
```

### ExtendedUserSession Integration

```typescript
export interface ExtendedUserSession extends UserSession {
  // Existing properties...
  
  // Add AppManager
  appManager: AppManager;
}
```

### Session Service Integration

The session service will delegate to the AppManager:

```typescript
// In createSession
const userSession = partialSession as ExtendedUserSession;
// ...other initialization
userSession.appManager = new AppManager(userSession);

// Delegate methods
async startAppSession(userSession: ExtendedUserSession, packageName: string): Promise<void> {
  return userSession.appManager.startApp(packageName);
}

async stopAppSession(userSession: ExtendedUserSession, packageName: string): Promise<void> {
  return userSession.appManager.stopApp(packageName);
}

isAppRunning(userSession: ExtendedUserSession, packageName: string): boolean {
  return userSession.appManager.isAppRunning(packageName);
}

async handleTpaInit(ws: WebSocket, initMessage: TpaConnectionInit, setCurrentSessionId: Function): Promise<void> {
  // Set current session ID
  setCurrentSessionId(initMessage.sessionId);
  
  // Get user session
  const userSession = this.getSession(initMessage.sessionId);
  if (!userSession) {
    throw new Error(`Session ${initMessage.sessionId} not found`);
  }
  
  // Delegate to AppManager
  return userSession.appManager.handleTpaInit(ws, initMessage);
}

async triggerAppStateChange(userId: string): Promise<void> {
  const userSession = this.getSessionByUserId(userId);
  if (!userSession) {
    logger.error(`No userSession found for client app state change: ${userId}`);
    return;
  }
  
  return userSession.appManager.broadcastAppState();
}
```

### Session Cleanup

```typescript
endSession(userSession: ExtendedUserSession): void {
  // ...existing cleanup
  
  // Clean up app manager
  if (userSession.appManager) {
    userSession.logger.info(`🧹 Cleaning up app manager for session ${userSession.sessionId}`);
    userSession.appManager.dispose();
  }
  
  // ...rest of cleanup
}
```

## Benefits

1. **Improved Separation of Concerns**: App lifecycle management is properly encapsulated
2. **Reduced Session Service Complexity**: Session service focuses on session management
3. **Consistent Manager Pattern**: Follows the same pattern as other managers
4. **Better Testability**: AppManager can be tested in isolation
5. **Enhanced Error Handling**: Centralized error handling for app-related operations
6. **Improved Code Organization**: Related functionality grouped together
7. **Clearer Responsibility Boundaries**: Each manager has a well-defined purpose

## Implementation Strategy

1. Create the AppManager class in `src/services/session/AppManager.ts`
2. Update the ExtendedUserSession interface to include the AppManager
3. Modify session.service.ts to create and use the AppManager
4. Update session cleanup to properly dispose of the AppManager
5. Test the implementation thoroughly alongside the existing code

## Error Handling

All methods in the AppManager follow a consistent error handling pattern:

1. **Method-level try/catch blocks**: Every public method has its own try/catch
2. **Detailed error logging**: Errors are logged with context
3. **Graceful degradation**: Failures in one app don't affect others
4. **State consistency**: Even in error cases, state is maintained correctly

## Additional Features

The AppManager includes some enhanced functionality beyond what's currently in the session service:

1. **Reconnection Grace Period**: Apps have a window to reconnect without losing state
2. **Bulk App Start**: Ability to start multiple apps at once
3. **App State Caching**: Local caching of installed apps for performance
4. **Enhanced Cleanup**: More thorough resource cleanup during disposal

## Consistency with Other Managers

The AppManager follows the same patterns as other managers:

1. **Constructor pattern**: Takes userSession and initializes with it
2. **Logging approach**: Creates child logger with component name
3. **Method naming**: Consistent method names (startX, stopX, handleX)
4. **Disposal pattern**: Implements dispose() method for cleanup
5. **Error handling**: Consistent error handling approach

By implementing the AppManager, we further enhance the modularity and maintainability of the session service while maintaining full compatibility with the existing implementation.