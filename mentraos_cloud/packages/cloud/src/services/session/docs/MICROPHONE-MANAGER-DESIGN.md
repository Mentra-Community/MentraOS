# MicrophoneManager Design Document

## Overview

The MicrophoneManager is a component responsible for managing microphone state within a user session. It encapsulates all microphone-related functionality that is currently spread throughout the WebSocket service, following the pattern used by other managers like DisplayManager and DashboardManager.

## Current Implementation Details

### Location and Structure

Currently, microphone state management is implemented in `websocket.service.ts` with the following components:

1. **Type Definition**:
   ```typescript
   type MicrophoneStateChangeDebouncer = { 
     timer: ReturnType<typeof setTimeout> | null; 
     lastState: boolean; 
     lastSentState: boolean 
   };
   ```

2. **Global State Map**:
   ```typescript
   private microphoneStateChangeDebouncers = new Map<string, MicrophoneStateChangeDebouncer>();
   ```

3. **Debouncer Function**:
   ```typescript
   private sendDebouncedMicrophoneStateChange(
     ws: WebSocket,
     userSession: UserSession,
     isEnabled: boolean,
     delay = 1000
   ): void {
     // Implementation details for debouncing microphone state changes
   }
   ```

### Current Behavior

1. **Initial State Management**:
   - When a user connects, microphone state is initialized based on whether there are media subscriptions
   - First call sends state change immediately
   - Creates a debouncer object to track subsequent changes

2. **Debouncing Mechanism**:
   - Tracks the last sent state and the current desired state
   - Only sends updates when the final state differs from the last sent state
   - Uses a timer to delay updates, clearing previous timers if new changes arrive
   - The debouncer is removed after processing

3. **Transcription Integration**:
   - Updates transcription service state based on microphone state
   - If microphone enabled: `transcriptionService.startTranscription(userSession)`
   - If microphone disabled: `transcriptionService.stopTranscription(userSession)`

### Current Usage Points

1. **GLASSES_CONNECTION_STATE Handler** (~line 1252):
   ```typescript
   case GlassesToCloudMessageType.GLASSES_CONNECTION_STATE: {
     const glassesConnectionStateMessage = message as GlassesConnectionState;
     userSession.logger.info('Glasses connection state:', glassesConnectionStateMessage);
     
     if (glassesConnectionStateMessage.status === 'CONNECTED') {
       const mediaSubscriptions = subscriptionService.hasMediaSubscriptions(userSession.sessionId);
       userSession.logger.info('Init Media subscriptions:', mediaSubscriptions);
       this.sendDebouncedMicrophoneStateChange(ws, userSession, mediaSubscriptions);
     }
     
     // Rest of the handler...
   }
   ```

2. **TPA Subscription Updates** (when a TPA subscribes to audio):
   - Called when TPAs update their subscription preferences
   - Enables microphone if any TPA subscribes to audio streams
   - Disables microphone if no TPAs are subscribed to audio streams

3. **Session Cleanup**:
   - Clears any active debounce timers when sessions end
   - Ensures microphone state is properly reset

4. **Default AugmentOS Settings** (~line 111):
   ```typescript
   const DEFAULT_AUGMENTOS_SETTINGS = {
     useOnboardMic: false,
     // Other settings...
   }
   ```

5. **Core Status Update** (~line 1437):
   ```typescript
   // Updates useOnboardMic based on glasses state:
   useOnboardMic: coreInfo.force_core_onboard_mic,
   ```

## Proposed Implementation

### New Directory Structure

```
/packages/cloud/src/services/
├── session/
│   ├── MicrophoneManager.ts    # New microphone state manager
│   └── MICROPHONE-MANAGER-DESIGN.md # This document
```

### MicrophoneManager Class

```typescript
/**
 * Manages microphone state for a user session
 */
export class MicrophoneManager {
  private session: ExtendedUserSession;
  private logger: Logger;
  
  // Track the current microphone state
  private enabled: boolean = false;
  
  // Debounce mechanism for state changes
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingState: boolean | null = null;
  private lastSentState: boolean = false;
  
  constructor(session: ExtendedUserSession) {
    this.session = session;
    this.logger = session.logger.child({ component: 'MicrophoneManager' });
    this.logger.info('MicrophoneManager initialized');
  }
  
  /**
   * Update the microphone state with debouncing
   * Replicates the exact behavior of the original sendDebouncedMicrophoneStateChange
   * 
   * @param isEnabled - Whether the microphone should be enabled
   * @param delay - Debounce delay in milliseconds (default: 1000ms)
   */
  updateState(isEnabled: boolean, delay: number = 1000): void {
    this.logger.debug(`Updating microphone state: ${isEnabled}, delay: ${delay}ms`);
    
    if (this.debounceTimer === null) {
      // First call: send immediately and update lastSentState
      this.sendStateChangeToGlasses(isEnabled);
      this.lastSentState = isEnabled;
      this.pendingState = isEnabled;
      this.enabled = isEnabled;
    } else {
      // For subsequent calls, update pending state
      this.pendingState = isEnabled;
      
      // Clear existing timer
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    
    // Set or reset the debounce timer
    this.debounceTimer = setTimeout(() => {
      // Only send if the final state differs from the last sent state
      if (this.pendingState !== this.lastSentState) {
        this.logger.info(`Sending debounced microphone state change: ${this.pendingState}`);
        this.sendStateChangeToGlasses(this.pendingState!);
        this.lastSentState = this.pendingState!;
        this.enabled = this.pendingState!;
      }
      
      // Update transcription service state
      this.updateTranscriptionState();
      
      // Cleanup: reset debounce timer
      this.debounceTimer = null;
      this.pendingState = null;
    }, delay);
  }
  
  /**
   * Send microphone state change message to glasses
   * This replicates the exact message format from the original implementation
   */
  private sendStateChangeToGlasses(isEnabled: boolean): void {
    if (!this.session.websocket || this.session.websocket.readyState !== WebSocket.OPEN) {
      this.logger.warn('Cannot send microphone state change: WebSocket not open');
      return;
    }
    
    try {
      const message: MicrophoneStateChange = {
        type: CloudToGlassesMessageType.MICROPHONE_STATE_CHANGE,
        sessionId: this.session.sessionId,
        userSession: {
          sessionId: this.session.sessionId,
          userId: this.session.userId,
          startTime: this.session.startTime,
          activeAppSessions: this.session.activeAppSessions || [],
          loadingApps: Array.from(this.session.loadingApps || []),
          isTranscribing: this.session.isTranscribing || false,
        },
        isEnabled: isEnabled,
        timestamp: new Date(),
      };
      
      this.session.websocket.send(JSON.stringify(message));
      this.logger.debug('Sent microphone state change message');
    } catch (error) {
      this.logger.error('Error sending microphone state change:', error);
    }
  }
  
  /**
   * Update transcription service state based on current microphone state
   * This replicates the transcription service integration from the original implementation
   */
  private updateTranscriptionState(): void {
    try {
      if (this.enabled) {
        this.logger.info('Starting transcription based on microphone state');
        transcriptionService.startTranscription(this.session);
      } else {
        this.logger.info('Stopping transcription based on microphone state');
        transcriptionService.stopTranscription(this.session);
      }
    } catch (error) {
      this.logger.error('Error updating transcription state:', error);
    }
  }
  
  /**
   * Get the current microphone state
   */
  isEnabled(): boolean {
    return this.enabled;
  }
  
  /**
   * Handle glasses connection state changes
   * This replicates the behavior in the GLASSES_CONNECTION_STATE case
   */
  handleConnectionStateChange(status: string): void {
    if (status === 'CONNECTED') {
      this.logger.info('Glasses connected, checking media subscriptions');
      const hasMediaSubscriptions = this.checkMediaSubscriptions();
      this.updateState(hasMediaSubscriptions);
    }
  }
  
  /**
   * Check if there are any media subscriptions that require microphone
   * This replicates the subscription check in the original implementation
   */
  private checkMediaSubscriptions(): boolean {
    try {
      return subscriptionService.hasMediaSubscriptions(this.session.sessionId);
    } catch (error) {
      this.logger.error('Error checking media subscriptions:', error);
      return false;
    }
  }
  
  /**
   * Handle subscription changes
   * This should be called when TPAs update their subscriptions
   */
  handleSubscriptionChange(): void {
    const hasMediaSubscriptions = this.checkMediaSubscriptions();
    this.logger.info(`Subscription changed, media subscriptions: ${hasMediaSubscriptions}`);
    this.updateState(hasMediaSubscriptions);
  }
  
  /**
   * Update microphone settings based on core status
   * This replicates the onboard mic setting update
   */
  updateOnboardMicSetting(useOnboardMic: boolean): void {
    this.logger.info(`Updating onboard mic setting: ${useOnboardMic}`);
    // Update the setting in user preferences or session state
    // Implementation depends on how settings are stored
  }
  
  /**
   * Cleanup resources
   */
  dispose(): void {
    this.logger.info('Disposing MicrophoneManager');
    // Clear any timers
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }
}
```

### ExtendedUserSession Integration

The MicrophoneManager will be added to the ExtendedUserSession interface in the new structure:

```typescript
// In services/session/types.ts or similar
export interface ExtendedUserSession extends UserSession {
  // Existing properties...
  
  // Add the microphone manager
  microphoneManager: MicrophoneManager;
  
  // Other properties...
}
```

### Usage in New WebSocket Services

```typescript
// In services/websocket/websocket-glasses.service.ts
private async handleGlassesConnectionState(userSession: ExtendedUserSession, message: GlassesConnectionState): Promise<void> {
  try {
    userSession.logger.info('Glasses connection state:', message);
    
    // Update the microphone state based on connection status
    userSession.microphoneManager.handleConnectionStateChange(message.status);
    
    // Rest of the handling...
    
  } catch (error) {
    userSession.logger.error('Error handling glasses connection state:', error);
  }
}

// In services/websocket/websocket-tpa.service.ts
private async handleTpaSubscriptionUpdate(userSession: ExtendedUserSession, message: TpaSubscriptionUpdate): Promise<void> {
  try {
    // Update subscriptions...
    
    // Notify microphone manager about subscription changes
    userSession.microphoneManager.handleSubscriptionChange();
    
  } catch (error) {
    userSession.logger.error('Error handling subscription update:', error);
  }
}
```

### Session Service Integration

```typescript
// In services/session/session.service.ts
async createSession(ws: WebSocket, userId: string): Promise<ExtendedUserSession> {
  // Existing session creation code...
  
  // Create the session object
  const userSession: ExtendedUserSession = {
    // Other properties...
  };
  
  // Initialize the MicrophoneManager
  userSession.microphoneManager = new MicrophoneManager(userSession);
  
  // Rest of the method...
  
  return userSession;
}

// In services/session/session.service.ts - cleanup
endSession(userSession: ExtendedUserSession): void {
  if (!userSession) return;
  
  userSession.logger.info(`[Ending session] Starting cleanup for ${userSession.sessionId}`);
  
  // Cleanup microphone manager
  if (userSession.microphoneManager) {
    userSession.microphoneManager.dispose();
  }
  
  // Rest of cleanup...
}
```

## Migration Strategy

1. We will NOT modify the existing `websocket.service.ts` file
2. All new code will be in separate directories:
   - `/services/session/MicrophoneManager.ts`
   - `/services/websocket/websocket-glasses.service.ts`
   - `/services/websocket/websocket-tpa.service.ts`

3. The new WebSocket and session services will use MicrophoneManager
4. Once completely tested, we'll switch over to the new implementation

## Critical Behaviors to Preserve

1. **Initial State on Connection**:
   - Check for media subscriptions when glasses connect
   - Send initial state immediately without debouncing

2. **Debouncing Behavior**:
   - First state change sent immediately
   - Subsequent changes are debounced
   - Multiple rapid changes collapse to a single update
   - Final state is always the last requested state

3. **Message Format**:
   - Maintain exact message format expected by glasses client
   - Include all required session properties

4. **Transcription Integration**:
   - Start/stop transcription based on microphone state
   - Update session.isTranscribing flag appropriately

5. **Subscription Awareness**:
   - Enable mic when any TPA subscribes to audio streams
   - Disable mic when no TPAs need audio anymore

6. **Cleanup**:
   - Properly dispose of timers when session ends
   - Prevent memory leaks from lingering references

7. **Error Handling**:
   - Graceful recovery from WebSocket errors
   - Continued operation if transcription service fails

By encapsulating all microphone functionality in the MicrophoneManager, we ensure no regression in behavior while making the code more maintainable and testable.