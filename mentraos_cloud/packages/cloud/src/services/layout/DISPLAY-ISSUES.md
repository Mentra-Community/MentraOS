# DisplayManager Issues and Solutions

## Current State

The DisplayManager (version 6.1) is responsible for coordinating content display on smart glasses screens. It manages:

1. **Display Throttling**: Enforces a 300ms minimum delay between display updates to prevent overwhelming the Bluetooth connection
2. **Boot Screen Management**: Shows a boot screen when apps are starting
3. **App Display Priority**: Determines which app's content gets shown when multiple apps want to display
4. **Display Transitions**: Handles transitions between apps' content

## Current Problems

### 1. Missing Initial Displays

**Problem**: TPAs often try to display content immediately after starting, but this content disappears or never shows up. This creates a poor first impression for both developers and users.

**Root causes**:
- During boot screen (1.5s duration), ALL display requests are rejected outright, not queued
- TPAs are not notified that their display requests were rejected
- First impressions are lost, leaving developers confused

```typescript
// Block ALL display requests if ANY app is booting (except dashboard)
if (this.bootingApps.size > 0) {
  logger.info(`[DisplayManager] - [${userSession.userId}] ❌ Blocking display during boot: ${displayRequest.packageName}`);
  return false; // Request is completely dropped
}
```

### 2. Throttled Requests Silently Dropped

**Problem**: When multiple display requests arrive in quick succession, some are throttled but then never displayed.

**Root causes**:
- The throttling system maintains only ONE queued request (`this.throttledRequest`) globally
- Later requests overwrite earlier ones in the queue
- A critical bug in the throttle recovery logic prevents showing new content from an app that already has content showing:

```typescript
// Only process if this is still the most recent throttled request AND nothing else has displayed
if (this.throttledRequest?.activeDisplay === activeDisplay &&
  this.displayState.currentDisplay?.displayRequest.packageName !== displayRequest.packageName) {
  // This condition PREVENTS showing new content from the SAME app!
  this.sendDisplay(displayRequest);
}
```
- Any successful display clears ALL throttled requests:
```typescript
if (success && !isDashboard && !isBootPhase) {
  // Clear any throttled request since something new just displayed
  if (this.throttledRequest) {
    this.throttledRequest = null; // ALL throttled requests are lost
  }
}
```

### 3. Race Conditions

**Problem**: Race conditions between app startup, boot screen display, and initial TPA display requests lead to unpredictable behavior.

**Root causes**:
- TPAs connect via websocket almost immediately after receiving the webhook
- Boot screen starts separately from TPA connection
- No coordination between boot screen timing and TPA readiness
- No mechanism to queue requests during boot phase

### 4. Poor Developer Experience

**Problem**: Developers cannot reliably predict or debug display issues.

**Root causes**:
- Silent request dropping with minimal logging
- No status feedback to TPAs about display request state
- No clear documentation on display lifecycle and throttling
- No way for developers to force critical displays (except dashboard has bypass)

## Goals

1. **Reliability**: Ensure ALL display requests are eventually shown, even if delayed
2. **Consistency**: Create predictable behavior for TPA developers
3. **Transparency**: Provide clear feedback about display request status
4. **Compatibility**: Maintain BLE stability with appropriate throttling
5. **Simplicity**: Make the system easier to understand and debug

## Non-Goals

1. Redesigning the entire display system architecture
2. Changing the basic boot screen concept
3. Removing all throttling (needed for BLE stability)
4. Supporting simultaneous displays from multiple apps
5. Creating a complex priority system

## Proposed Solutions

### 1. Queue All Requests During Boot

Instead of rejecting display requests during boot, queue them for display after the boot screen completes:

```typescript
// Replace rejection with queueing
if (this.bootingApps.size > 0) {
  logger.info(`[DisplayManager] - [${userSession.userId}] ⏳ Queuing display request during boot: ${displayRequest.packageName}`);
  this.queueDisplayRequestForAfterBoot(displayRequest, userSession);
  return true; // Indicate success to the TPA
}
```

### 2. Per-App Throttling Queue

Replace the single global throttle queue with a map of queues per app:

```typescript
// Replace single throttled request with a map
private throttledRequests = new Map<string, ThrottledRequest>();

// Queue per app
private queueThrottledRequest(activeDisplay: ActiveDisplay, timestamp: number) {
  const packageName = activeDisplay.displayRequest.packageName;
  this.throttledRequests.set(packageName, { activeDisplay, timestamp });
  
  // Schedule processing
  setTimeout(() => {
    const request = this.throttledRequests.get(packageName);
    if (request && request.activeDisplay === activeDisplay) {
      // Always display the most recent request from this app
      this.sendDisplay(activeDisplay);
      this.throttledRequests.delete(packageName);
    }
  }, this.THROTTLE_DELAY);
}
```

### 3. Fix Throttle Recovery Logic

Remove the condition that prevents showing new content from an app that already has content displaying:

```typescript
// Replace current condition with simpler logic
setTimeout(() => {
  // Only check if this is still the most recent request for this app
  if (this.throttledRequests.get(packageName)?.activeDisplay === activeDisplay) {
    // Always show most recent content, even if replacing the app's own content
    this.sendDisplay(activeDisplay);
    this.throttledRequests.delete(packageName);
  }
}, this.THROTTLE_DELAY);
```

### 4. Implement Request Status Feedback

Add a status feedback mechanism to inform TPAs about their display request status:

```typescript
// Inform TPA about request status
private sendRequestStatus(userSession: UserSession, packageName: string, status: 'queued' | 'throttled' | 'displayed' | 'rejected', reason?: string) {
  const websocket = userSession.appConnections.get(packageName);
  if (websocket && websocket.readyState === 1) {
    const message = {
      type: 'display_request_status',
      status,
      reason,
      timestamp: new Date()
    };
    websocket.send(JSON.stringify(message));
  }
}
```

### 5. Allow Critical Display Requests

Add support for "critical" display requests that bypass certain restrictions:

```typescript
// In DisplayRequest interface:
interface DisplayRequest {
  // ...existing fields
  priority?: 'normal' | 'critical';
}

// In handleDisplayEvent:
if (displayRequest.priority === 'critical') {
  // Still respect basic throttling but bypass other restrictions
  // For example, always queue during boot instead of rejecting
}
```

### 6. Improve Logging and Metrics

Add comprehensive logging and metrics to help diagnose display issues:

```typescript
// Track statistics about display requests
private displayStats = {
  totalRequests: 0,
  throttledRequests: 0,
  bootQueuedRequests: 0,
  rejectedRequests: 0,
  displayedRequests: 0,
  // Per-app stats
  perApp: new Map<string, { displayed: number, throttled: number, queued: number, rejected: number }>()
};

// Update stats consistently throughout the code
private updateStats(packageName: string, status: 'displayed' | 'throttled' | 'queued' | 'rejected') {
  this.displayStats.totalRequests++;
  this.displayStats[`${status}Requests`]++;
  
  // Update per-app stats
  const appStats = this.displayStats.perApp.get(packageName) || { displayed: 0, throttled: 0, queued: 0, rejected: 0 };
  appStats[status]++;
  this.displayStats.perApp.set(packageName, appStats);
}
```

## Expected User Experience After Fixes

### For TPA Developers:

1. **Reliability**: All display requests will eventually be shown, even if delayed due to boot screen or throttling
2. **Predictability**: Newer requests from the same TPA always replace older ones
3. **Transparency**: Debug logs and webhook status updates explain display timing and state
4. **Control**: Critical flag for important displays that should bypass certain restrictions

### For End Users:

1. **Consistency**: Apps consistently show their initial content after starting
2. **Smoothness**: Throttling prevents jarring display changes while maintaining responsiveness
3. **Information**: Boot screen provides clear status during app startup
4. **Performance**: BLE connection remains stable due to retained throttling

## Implementation Steps

1. Add per-app throttling queue
2. Fix throttle recovery logic
3. Implement boot screen request queuing
4. Add display request status feedback
5. Implement request priority system
6. Enhance logging and metrics
7. Update documentation
8. Create dev tools for monitoring display flow

## Future Improvements

1. **Interactive Debug Mode**: Allow developers to see display request flow in real-time
2. **Multi-level Priority System**: More sophisticated priority management for different display types
3. **Display Transitions**: Add smooth transitions between display content
4. **Request Batching**: Group multiple rapid requests to optimize BLE traffic
5. **Smart Throttling**: Adjust throttle timing based on connection quality and display complexity