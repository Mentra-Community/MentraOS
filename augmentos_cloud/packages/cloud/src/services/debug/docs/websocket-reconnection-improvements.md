# WebSocket Reconnection Improvements

## Overview

This document describes a set of improvements made to the AugmentOS WebSocket connection system, focusing on reconnection behavior for TPAs when network interruptions occur. These improvements address issues observed both in development environments (laptop sleep causing disconnection) and in production (unexpected disconnections without proper recovery).

## Problem Statement

The WebSocket connections between TPAs and AugmentOS Cloud were experiencing several issues:

1. **WebSocket Closure Detection**: When WebSocket connections would close unexpectedly, the TPAs would not attempt to reconnect.

2. **Health Monitor Tracking**: When the health monitor service would terminate stale connections, there was no coordination with the WebSocket service, and the closure had poor identification of which TPA had been disconnected.

3. **Client State Mismatch**: TPAs would continue attempting to use closed WebSocket connections, leading to error messages like "WebSocket not connected (current state: CLOSED)".

4. **Dashboard Manager Issues**: The dashboard manager was particularly affected due to its continuous update cycle, showing frequent errors when disconnected.

## Key Insights from Investigation

1. **Default Reconnection Behavior**:
   - `autoReconnect` was set to `false` by default in TpaSession class
   - When WebSockets closed, no reconnection attempt was made

2. **Close Type Distinction**:
   - WebSocket closures have different codes (1000 = normal, others = abnormal)
   - The SDK couldn't distinguish between intentional closures and unexpected ones

3. **Health Monitor Service Issues**:
   - Uses `ws.terminate()` instead of `ws.close()`, leading to abrupt closures
   - Logs only generic "TPA connection timed out" without identifying which TPA
   - Doesn't update the WebSocket service's connection tracking

4. **State Management Problems**:
   - When WebSocket connections close, user sessions still keep references to them
   - Health monitor service and WebSocket service don't coordinate state

## Implemented Solutions

We implemented several improvements to address these issues:

1. **Enhanced WebSocket Close Event Handling**:
   ```typescript
   const closeHandler = (code: number, reason: string) => {
     const isNormalClosure = (code === 1000 || code === 1001);
     const isManualStop = reason && reason.includes('App stopped');
     
     // Only reconnect for abnormal closures, not intentional ones
     if (!isNormalClosure && !isManualStop) {
       this.handleReconnection();
     }
   };
   ```

2. **Improved Default Settings**:
   ```typescript
   // Changed defaults to:
   autoReconnect: true,        // Enable by default
   maxReconnectAttempts: 3,    // More attempts for better recovery
   reconnectDelay: 1000        // Start with 1 second delay
   ```

3. **Enhanced Event Payload**:
   ```typescript
   // New extended format for 'disconnected' event
   this.events.emit('disconnected', {
     message: closeInfo,
     code: code,
     reason: reason || '',
     wasClean: code === 1000 || code === 1001,
   });
   ```

4. **Better Logging**:
   Added detailed logging in key areas to help diagnose connection issues.

## Potential Future Improvements

The following areas were identified for future improvement:

1. **Health Monitor Architecture**:
   - Refactor to follow manager-style pattern
   - Make the health monitor part of the extended user session
   - Improve coordination with WebSocket service

2. **Connection Identity Tracking**:
   - Enhance the health monitor to track TPA identity with WebSockets
   - Add callbacks when closing connections

3. **State Synchronization**:
   - Implement better state synchronization between components
   - Ensure all components know when a connection is closed

4. **Client-Side Detection**:
   - Improve how TPAs detect and handle broken connections

## Relevant Code Locations

1. **TPA Session WebSocket Handling**:
   - `/packages/sdk/src/tpa/session/index.ts` - Connection logic and reconnection

2. **Health Monitor Service**:
   - `/packages/cloud/src/services/core/health-monitor.service.ts` - Connection health tracking

3. **WebSocket Service**:
   - `/packages/cloud/src/services/core/websocket.service.ts` - Connection management

4. **Dashboard Manager**:
   - `/packages/apps/dashboard/src/index.ts` - Example TPA affected by disconnections

## Conclusion

The implemented changes significantly improve the WebSocket reconnection behavior, making TPAs more resilient to network interruptions. The primary approach is enabling auto-reconnection by default and making the reconnection logic smarter about when to attempt reconnection.

Further architectural improvements to the health monitor service and its coordination with the WebSocket service would provide even better connection reliability and diagnostics.