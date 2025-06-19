# TPA Connection State Management Issues

## Overview

During investigation of Azure Speech Recognition infinite retry loops and TPA stopping issues, we discovered fundamental problems with TPA connection state management that prevent proper grace period handling and cause inappropriate app resurrection.

## Root Cause: Missing WebSocket Close Event Handlers

### The Problem
TPA WebSocket connections are stored in `AppManager.handleTpaInit()` but **no close event handlers are set up**, meaning:

1. **Grace Period Logic Never Executes**: `handleAppConnectionClosed()` exists but is never called
2. **Immediate Inappropriate Resurrection**: Services detect closed connections and trigger resurrection without any grace period
3. **No State Management**: No tracking of connection states (grace period, resurrecting, etc.)

### Current Broken Flow
```
TPA WebSocket closes → NO close handler → WebSocket removed from Map eventually
                                      ↓
                    Service tries to send message → sendMessageToTpa() detects closed connection
                                      ↓
                    Immediately triggers resurrection (BYPASSES 5-second grace period!)
```

### Expected Flow
```
TPA WebSocket closes → Close handler fires → Grace period starts (5 seconds)
                                         ↓
                     Natural reconnection OR grace period expires → Allow resurrection
```

## Issue 1: TPA Apps Cannot Be Stopped

### Problem Description
When users try to stop TPAs via the app interface, the apps immediately restart due to automatic resurrection logic.

### Root Cause
The resurrection logic in `AppManager.sendMessageToTpa()` cannot distinguish between:
- **Crashed/Disconnected TPAs** (should be resurrected)
- **Intentionally Stopped TPAs** (should NOT be resurrected)

### Current Conflict
1. User stops TPA → `AppManager.stopApp()` closes WebSocket
2. Service (e.g., transcription) tries to send data → `sendMessageToTpa()` detects closed connection
3. Automatic resurrection triggered → TPA restarts against user's intent

## Issue 2: Azure Speech Recognition Infinite Retry Loop
(this might have been fixed already, i haven't seen it since.)
### Problem Description
Azure Speech Recognition enters infinite retry loop with error code 7 (SPXERR_INVALID_OPERATION) every ~60 seconds.

### Root Cause Analysis
1. **60-Second Pattern**: MicrophoneManager triggers transcription restart every ~60 seconds
2. **Overlapping Streams**: `updateTranscriptionState()` creates new Azure streams without checking if streams already exist
3. **Resource Conflicts**: Multiple active Azure Speech Recognition streams cause error code 7

### Log Pattern
```
[07:24:30.310] ERROR: Recognition canceled with InvalidOperation (error 7)
    streamAge: 60050    ← Stream was running successfully for 60 seconds
[07:24:30.522] INFO: Starting transcription based on microphone state  
[07:24:30.952] ERROR: Recognition canceled with InvalidOperation (error 7)
    streamAge: 427      ← New stream fails after only 427ms due to resource conflict
```

## Issue 3: Missing Connection State Management

### Current State (Implicit)
- **RUNNING**: App in `runningApps` + active WebSocket
- **GRACE_PERIOD**: App in `runningApps` + no WebSocket + reconnection timer active
- **DISCONNECTED**: App NOT in `runningApps` + no WebSocket  
- **RESURRECTING**: No explicit tracking!

### Problems
1. **No Explicit State Tracking**: Connection states are implicit and scattered
2. **Race Conditions**: Services can trigger resurrection during grace periods
3. **Duplicate Resurrections**: Multiple services can trigger resurrection simultaneously
4. **No Message Queueing Strategy**: Unclear what happens to messages during state transitions

## Solutions

### Solution 1: Add Missing WebSocket Close Event Handlers

**Location**: `AppManager.handleTpaInit()` after line 530

```typescript
// Store the WebSocket connection  
this.userSession.appWebsockets.set(packageName, ws);

// Set up close event handler for proper grace period handling
ws.on('close', (code: number, reason: Buffer) => {
  this.handleAppConnectionClosed(packageName, code, reason.toString());
});
```

**Benefits**:
- ✅ Grace period logic finally gets triggered
- ✅ Immediate detection of connection loss
- ✅ Prevents premature resurrection during natural reconnection window
- ✅ Centralizes connection lifecycle management in AppManager

### Solution 2: Implement Explicit Connection State Management

**Proposed State Enum**:
```typescript
enum AppConnectionState {
  RUNNING = 'running',           // Active WebSocket connection
  GRACE_PERIOD = 'grace_period', // Waiting for natural reconnection (5s)
  RESURRECTING = 'resurrecting', // System actively restarting app
  STOPPING = 'stopping',         // User/system initiated stop in progress
  DISCONNECTED = 'disconnected'  // Available for resurrection
}
```

**State Transitions**:
- User stops app → STOPPING
- WebSocket closes unexpectedly → GRACE_PERIOD (5s timer)
- WebSocket closes while STOPPING → Remove from all states (clean shutdown)
- Grace period expires → DISCONNECTED  
- Message fails + state is DISCONNECTED → RESURRECTING
- WebSocket reconnects → RUNNING
- Resurrection fails → DISCONNECTED

**Distinguishing Intentional vs Unintentional Closes**:
```typescript
// User calls stopApp()
async stopApp(packageName: string): Promise<void> {
  // Set to STOPPING state before closing WebSocket
  this.setAppConnectionState(packageName, AppConnectionState.STOPPING);
  
  // Close WebSocket - this will trigger close handler
  const websocket = this.userSession.appWebsockets.get(packageName);
  if (websocket) {
    websocket.close(1000, 'App stopped by user');
  }
}

// Close handler
handleAppConnectionClosed(packageName: string, code: number, reason: string): void {
  const currentState = this.getAppConnectionState(packageName);
  
  if (currentState === AppConnectionState.STOPPING) {
    // Expected close - remove from all tracking
    this.logger.info(`App ${packageName} stopped as expected`);
    this.cleanupApp(packageName);
    return;
  }
  
  // Unexpected close - start grace period
  this.logger.info(`App ${packageName} unexpectedly disconnected, starting grace period`);
  this.setAppConnectionState(packageName, AppConnectionState.GRACE_PERIOD);
  this.startGracePeriod(packageName);
}
```

### Solution 3: Message Handling Strategy by Connection State

**Natural Reconnection (within grace period)**:
- **TPA Perspective**: Same session continuing, internal state intact
- **Message Handling**: ✅ Queue or "fail gracefully (dropped messages)" - TPA expects continuity
- **Rationale**: Brief network hiccup, ongoing conversation should continue

**Resurrection (after grace period)**:
- **TPA Perspective**: Fresh start, new session, internal state reset
- **Message Handling**: ❌ Fail gracefully - old messages don't make sense  
- **Rationale**: TPA was restarted, expects clean slate

**Implementation**:
```typescript
async sendMessageToTpa(packageName: string, message: any): Promise<TpaMessageResult> {
  const appState = this.getAppConnectionState(packageName);
  
  if (appState === AppConnectionState.STOPPING) {
    return { sent: false, resurrectionTriggered: false, error: 'App is being stopped' };
  }
  
  if (appState === AppConnectionState.GRACE_PERIOD) {
    return { sent: false, resurrectionTriggered: false, error: 'Connection lost, waiting for reconnection' };
  }
  
  if (appState === AppConnectionState.RESURRECTING) {
    return { sent: false, resurrectionTriggered: false, error: 'App is restarting' };
  }
  
  if (appState === AppConnectionState.DISCONNECTED) {
    // Trigger resurrection but DON'T retry the message
    await this.resurrectTpa(packageName); // No message retry
    return { sent: false, resurrectionTriggered: true, error: 'App restarted, message not sent' };
  }
  
  // Normal sending for RUNNING state...
}
```

### Solution 4: Fix Azure Speech Recognition Overlapping Streams

**Problem**: `MicrophoneManager.updateTranscriptionState()` calls `transcriptionService.startTranscription()` without checking if streams already exist.

**Solution**: Add stream state validation in `updateTranscriptionState()`:
```typescript
private updateTranscriptionState(): void {
  try {
    if (this.enabled) {
      // Check if transcription is already running
      if (!transcriptionService.isTranscriptionActive(this.session)) {
        this.logger.info('Starting transcription based on microphone state');
        transcriptionService.startTranscription(this.session);
      } else {
        this.logger.debug('Transcription already active, skipping start request');
      }
    } else {
      this.logger.info('Stopping transcription based on microphone state');
      transcriptionService.stopTranscription(this.session);
    }
  } catch (error) {
    this.logger.error('Error updating transcription state:', error);
  }
}
```

## Implementation Status

1. ✅ **COMPLETED**: Add WebSocket close event handlers (fixes grace period)
2. ✅ **COMPLETED**: Implement basic connection state tracking (fixes stopping issue)  
3. ✅ **COMPLETED**: Implement message handling strategy (improves developer experience)
4. ✅ **COMPLETED**: Fix Azure Speech Recognition overlapping streams (reduces error spam)

All major issues have been resolved with this implementation.

## Benefits of Complete Solution

- ✅ **Proper Grace Period Handling**: 5-second natural reconnection window works as intended
- ✅ **User Control**: TPAs can be stopped without immediate resurrection
- ✅ **Clean Session Boundaries**: Clear distinction between session continuity vs fresh starts
- ✅ **Reduced Error Noise**: Eliminates Azure Speech Recognition infinite retry loops
- ✅ **Better Developer Experience**: Predictable message delivery behavior
- ✅ **System Stability**: Prevents race conditions and duplicate resurrection attempts

## Files Involved

- `/src/services/session/AppManager.ts` - Primary implementation location
- `/src/services/session/MicrophoneManager.ts` - Azure Speech fix
- `/src/services/processing/transcription.service.ts` - Stream state validation
- `/src/services/websocket/websocket-tpa.service.ts` - Reference for WebSocket event patterns