# DisplayManager Code Refactoring

## Current Code Issues

The current DisplayManager implementation has several structural issues that make it difficult to understand, maintain, and debug:

1. **Unclear naming**: Method and variable names don't always clearly indicate their purpose
2. **Complex conditional logic**: Nested if statements and complex conditions
3. **Inconsistent code patterns**: Different approaches used for similar operations
4. **Poor separation of concerns**: Mixing of throttling, display state management, and boot screen logic
5. **Limited comments**: Missing documentation for critical logic flows
6. **Scattered logging**: Inconsistent logging patterns

## Refactoring Goals

1. Improve code readability and maintainability
2. Clarify the flow of display requests through the system
3. Simplify the logic for priority, throttling, and boot screen management
4. Make the code more modular and testable
5. Better document the intended behavior
6. Ensure future developers can understand and extend the code

## Proposed Structural Changes

### 1. Reorganize Core Data Structures

```typescript
// Clearer display state management
interface DisplayState {
  // Current display showing on glasses
  activeDisplay: ActiveDisplay | null;
  
  // Last valid display from system apps (e.g., captions)
  systemAppDisplay: ActiveDisplay | null;
  
  // Last valid display from each app (for recovery after boot screen)
  lastDisplayByApp: Map<string, ActiveDisplay>;
  
  // Display priority lock 
  displayLock: {
    packageName: string;
    expiresAt: Date;
    lastActiveTime: number;
  } | null;
}

// Queue structures
interface QueueState {
  // Requests queued during boot (by package name)
  bootRequests: Map<string, ActiveDisplay>;
  
  // Throttled requests (by package name)
  throttledRequests: Map<string, ThrottledRequest>;
}
```

### 2. Create Clear Process Flow Methods

```typescript
class DisplayManager implements DisplayManagerI {
  private displayState: DisplayState;
  private queueState: QueueState;
  
  // Main entry point for all display requests
  public handleDisplayEvent(displayRequest: DisplayRequest, userSession: UserSession): boolean {
    // Validation and userSession setup
    
    // 1. Determine display action (show now, throttle, or queue for boot)
    const action = this.determineDisplayAction(displayRequest);
    
    // 2. Handle based on determined action
    switch (action) {
      case 'SHOW_NOW':
        return this.processImmediateDisplay(displayRequest);
      case 'THROTTLE':
        return this.enqueueThrottledDisplay(displayRequest);
      case 'QUEUE_FOR_BOOT':
        return this.queueForBootCompletion(displayRequest);
      case 'REJECT':
        return this.handleRejectedDisplay(displayRequest);
    }
  }
  
  // Clear methods for different logic flows
  private determineDisplayAction(request: DisplayRequest): 'SHOW_NOW' | 'THROTTLE' | 'QUEUE_FOR_BOOT' | 'REJECT';
  private processImmediateDisplay(request: DisplayRequest): boolean;
  private enqueueThrottledDisplay(request: DisplayRequest): boolean;
  private queueForBootCompletion(request: DisplayRequest): boolean;
  private handleRejectedDisplay(request: DisplayRequest): boolean;
  
  // Boot screen handling
  public handleAppStart(packageName: string, userSession: UserSession): void;
  public handleAppStop(packageName: string, userSession: UserSession): void;
  private showBootScreen(): void;
  private processBootQueue(): void;
  
  // Display queue management
  private processNextDisplay(reason: DisplayTransitionReason): void;
  private restoreDisplayState(): void;
}
```

### 3. Improve Method Naming

Current Name | Proposed Name | Reason
-------------|---------------|-------
`showDisplay` | `sendDisplayToGlasses` | Clarifies this actually sends to hardware
`canBackgroundAppDisplay` | `hasDisplayPermission` | More clear about purpose
`showNextDisplay` | `processNextInDisplayQueue` | Clearer about queue processing
`updateBootScreen` | `refreshBootScreenContent` | Describes content refreshing
`hasRemainingDuration` | `isDisplayStillValid` | More descriptive of check purpose
`sendDisplay` | `processDisplayRequest` | Clearer about overall process
`sendToWebSocket` | `transmitToGlasses` | More specific about destination

### 4. Add State Enums for Clarity

```typescript
// Clear enums for state management
enum DisplayAction {
  SHOW_NOW = 'SHOW_NOW',
  THROTTLE = 'THROTTLE',
  QUEUE_FOR_BOOT = 'QUEUE_FOR_BOOT',
  REJECT = 'REJECT'
}

enum DisplayTransitionReason {
  APP_STOPPED = 'APP_STOPPED',
  DURATION_EXPIRED = 'DURATION_EXPIRED',
  BOOT_COMPLETED = 'BOOT_COMPLETED',
  HIGHER_PRIORITY = 'HIGHER_PRIORITY',
  NEW_DISPLAY_REQUEST = 'NEW_DISPLAY_REQUEST'
}
```

## Specific Code Improvements

### 1. Throttling Logic Refactoring

Current code:
```typescript
if (!isDashboard && !isBootPhase && Date.now() - this.lastDisplayTime < this.THROTTLE_DELAY) {
  logger.info(`[DisplayManager] - [${this.userSession.userId}] ⏳ Display throttled, queuing: ${displayRequest.packageName}`);

  const activeDisplay = this.createActiveDisplay(displayRequest);
  this.throttledRequest = {
    activeDisplay,
    timestamp: Date.now()
  };

  // Schedule this display to happen after throttle delay
  setTimeout(() => {
    // Only process if this is still the most recent throttled request AND nothing else has displayed
    if (this.throttledRequest?.activeDisplay === activeDisplay &&
      this.displayState.currentDisplay?.displayRequest.packageName !== displayRequest.packageName) {
      logger.info(`[DisplayManager] - [${this.userSession?.userId}] ⏳ Processing throttled display: ${displayRequest.packageName}`);
      this.sendDisplay(displayRequest);
    }
    this.throttledRequest = null;
  }, this.THROTTLE_DELAY);

  return false;
}
```

Refactored code:
```typescript
private enqueueThrottledDisplay(displayRequest: DisplayRequest): boolean {
  const packageName = displayRequest.packageName;
  logger.info(`[DisplayManager] - [${this.userSession.userId}] ⏳ Display throttled, queuing: ${packageName}`);

  // Create active display object
  const activeDisplay = this.createActiveDisplay(displayRequest);
  
  // Store in per-app throttle map
  this.queueState.throttledRequests.set(packageName, {
    activeDisplay,
    timestamp: Date.now()
  });

  // Schedule processing after throttle window
  this.scheduleThrottledDisplayProcessing(packageName, activeDisplay);
  
  // Return true to indicate request is being handled
  return true;
}

private scheduleThrottledDisplayProcessing(packageName: string, activeDisplay: ActiveDisplay): void {
  setTimeout(() => {
    // Only process if this is still the same request in the queue
    const queuedRequest = this.queueState.throttledRequests.get(packageName);
    if (queuedRequest?.activeDisplay === activeDisplay) {
      logger.info(`[DisplayManager] - [${this.userSession?.userId}] ⏳ Processing throttled display: ${packageName}`);
      this.sendDisplayToGlasses(activeDisplay);
      this.queueState.throttledRequests.delete(packageName);
    }
  }, this.THROTTLE_DELAY);
}
```

### 2. Boot Screen Queue Handling

Current code: 
```typescript
// Block ALL display requests if ANY app is booting (except dashboard)
if (this.bootingApps.size > 0) {
  logger.info(`[DisplayManager] - [${userSession.userId}] ❌ Blocking display during boot: ${displayRequest.packageName}`);
  return false;
}
```

Refactored code:
```typescript
private queueForBootCompletion(displayRequest: DisplayRequest): boolean {
  const packageName = displayRequest.packageName;
  
  logger.info(`[DisplayManager] - [${this.userSession.userId}] 🔄 Queuing display for after boot: ${packageName}`);
  
  // Store most recent request per app in boot queue
  const activeDisplay = this.createActiveDisplay(displayRequest);
  this.queueState.bootRequests.set(packageName, activeDisplay);
  
  // Return true to indicate request is acknowledged and being handled
  return true;
}

// Called when boot screen completes
private processBootQueue(): void {
  logger.info(`[DisplayManager] - [${this.userSession?.userId}] 🔄 Processing ${this.queueState.bootRequests.size} queued boot requests`);
  
  if (this.queueState.bootRequests.size === 0) {
    // No queued requests, restore previous display if available
    this.restoreDisplayState();
    return;
  }
  
  // Find highest priority display from boot queue
  // Process most recent request for highest priority app
  // (Implementation details...)
  
  // Clear boot queue after processing
  this.queueState.bootRequests.clear();
}
```

### 3. Display State Management

Current code:
```typescript
private displayState: DisplayState = {
  currentDisplay: null,
  coreAppDisplay: null,
  backgroundLock: null
};
```

Refactored code:
```typescript
private displayState: DisplayState = {
  activeDisplay: null,
  systemAppDisplay: null,
  lastDisplayByApp: new Map(),
  displayLock: null
};

// Store last display from each app
private updateLastDisplayForApp(activeDisplay: ActiveDisplay): void {
  const packageName = activeDisplay.displayRequest.packageName;
  
  // Don't track dashboard displays
  if (packageName === systemApps.dashboard.packageName) {
    return;
  }
  
  // Track system app displays separately
  if (packageName === this.systemAppPackageName) {
    this.displayState.systemAppDisplay = activeDisplay;
  }
  
  // Store latest display for each app (for recovery)
  this.displayState.lastDisplayByApp.set(packageName, activeDisplay);
}
```

## Documentation Improvements

### Add Method Documentation

```typescript
/**
 * Processes a display request from a TPA
 * 
 * This is the main entry point for all display requests. It determines
 * how the request should be handled based on current system state:
 * - Show immediately if conditions allow
 * - Throttle if too soon after previous display
 * - Queue if boot screen is active
 * - Reject if permission checks fail
 * 
 * @param displayRequest - The display request to process
 * @param userSession - User session context
 * @returns boolean indicating if request was successfully handled
 */
public handleDisplayEvent(displayRequest: DisplayRequest, userSession: UserSession): boolean {
  // Implementation
}
```

### Add Flow Documentation

```typescript
/**
 * Display Request Flow:
 * 
 * 1. handleDisplayEvent (entry point)
 * 2. determineDisplayAction (decides handling approach)
 * 3. One of:
 *    - processImmediateDisplay → sendDisplayToGlasses → transmitToGlasses
 *    - enqueueThrottledDisplay → scheduleThrottledDisplayProcessing
 *    - queueForBootCompletion (processed later by processBootQueue)
 *    - handleRejectedDisplay (permission denied)
 */
```

## Implementation Plan

1. Create new data structures and enums
2. Refactor main entry point methods
3. Implement queue handling mechanisms
4. Fix the throttling logic
5. Implement boot queue processing
6. Add proper documentation
7. Update logging for consistency

## Testing Strategy

1. Test boot screen queuing
2. Test throttling with multiple apps
3. Test display recovery after boot screen
4. Test rapid display requests from same app
5. Test priority handling between apps

This refactoring will make the code significantly easier to understand and maintain while fixing the core functional issues identified earlier.