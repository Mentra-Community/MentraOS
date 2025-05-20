# DisplayManager Improvements

## Overview

The DisplayManager is a critical component of AugmentOS Cloud, responsible for coordinating display updates to smart glasses. This document outlines planned improvements to make the DisplayManager more robust, configurable, and maintainable.

## Current Limitations

After a thorough code review of the current DisplayManager implementation, the following limitations were identified:

1. **Hard-coded Configuration**:
   - Main app is hardcoded (systemApps.captions.packageName)
   - Timing values are embedded as constants
   - Boot duration and animations are fixed

2. **Limited Logging**:
   - Uses console.log for most logging
   - No structured metrics for display success/failure
   - Difficult to track display state transitions

3. **Basic Error Handling**:
   - Minimal validation of incoming display requests
   - Limited handling for malformed layouts
   - No formal reporting mechanism for display failures

4. **Complex State Management**:
   - Background lock system has edge cases
   - Throttling implementation is scattered in multiple methods
   - Display queue management could be more robust

## Planned Improvements

### 0. View Type Enhancements

The View Type system has been enhanced to properly support the always-on dashboard as a persistent overlay:

```typescript
export enum ViewType {
    DASHBOARD = 'dashboard',   // Regular dashboard (main/expanded)
    ALWAYS_ON = 'always_on',   // Persistent overlay dashboard
    MAIN = 'main'              // Regular app content
}
```

This change:
- Separates the always-on dashboard from the regular dashboard modes
- Allows the client to properly display both simultaneously
- Enables the dashboard manager to update each independently
- Makes the system more consistent with the actual user experience

### 1. Configuration System

Replace hard-coded values with a configuration system:

```typescript
export interface DisplayManagerConfig {
  // Core timing values
  throttleDelayMs: number;        // Delay between display updates
  bootDurationMs: number;         // How long to show boot screen per app
  lockTimeoutMs: number;          // Background lock timeout
  lockInactiveTimeoutMs: number;  // Inactivity timeout for background locks
  
  // App configuration
  mainAppPackageName: string;     // Package name of the main/core app
  dashboardPackageName: string;   // Package name of the dashboard app
  
  // Display behavior
  allowDashboardThrottling: boolean; // Whether to throttle dashboard displays
  queueDisplaysInBoot: boolean;      // Queue displays during boot or reject
  
  // Debugging
  debugMode: boolean;             // Enable additional debug logging
}
```

Default configuration can be provided, but values should be overridable:

```typescript
const defaultConfig: DisplayManagerConfig = {
  throttleDelayMs: 200,
  bootDurationMs: 3000,
  lockTimeoutMs: 10000,
  lockInactiveTimeoutMs: 2000,
  mainAppPackageName: systemApps.captions.packageName,
  dashboardPackageName: systemApps.dashboard.packageName,
  allowDashboardThrottling: false,
  queueDisplaysInBoot: false,
  debugMode: false
};
```

### 2. Enhanced Logging System

Replace console.log statements with structured logging:

```typescript
private log(level: 'info' | 'warn' | 'error', message: string, data?: any): void {
  const userId = this.userSession?.userId || 'no-user';
  const timestamp = new Date().toISOString();
  const displayState = {
    currentApp: this.displayState.currentDisplay?.displayRequest.packageName,
    bootingApps: Array.from(this.bootingApps),
    hasBackgroundLock: !!this.displayState.backgroundLock,
    lockHolder: this.displayState.backgroundLock?.packageName
  };
  
  const logEntry = {
    timestamp,
    level,
    message,
    userId,
    displayState,
    ...(data ? { data } : {})
  };
  
  // Use logger from @augmentos/utils
  switch (level) {
    case 'info':
      logger.info(`[DisplayManager] ${message}`, logEntry);
      break;
    case 'warn':
      logger.warn(`[DisplayManager] ${message}`, logEntry);
      break;
    case 'error':
      logger.error(`[DisplayManager] ${message}`, logEntry);
      break;
  }
  
  // Optionally track metrics or send to monitoring system
  if (level === 'error') {
    // Track error metrics
  }
}
```

### 3. Improved Request Validation

Add comprehensive validation of display requests:

```typescript
private validateDisplayRequest(request: DisplayRequest): boolean {
  // Check for required fields
  if (!request || !request.packageName || !request.layout || !request.view) {
    this.log('error', 'Invalid display request: missing required fields', { request });
    return false;
  }
  
  // Check layout type
  if (!Object.values(LayoutType).includes(request.layout.layoutType)) {
    this.log('error', 'Invalid layout type', { 
      layout: request.layout, 
      allowedTypes: Object.values(LayoutType) 
    });
    return false;
  }
  
  // Validate specific layout types
  switch (request.layout.layoutType) {
    case LayoutType.TEXT_WALL:
      if (typeof (request.layout as TextWall).text !== 'string') {
        this.log('error', 'Invalid TEXT_WALL layout: missing text field', { layout: request.layout });
        return false;
      }
      break;
    case LayoutType.REFERENCE_CARD:
      const card = request.layout as ReferenceCard;
      if (typeof card.title !== 'string' || typeof card.text !== 'string') {
        this.log('error', 'Invalid REFERENCE_CARD layout: missing title or text', { layout: card });
        return false;
      }
      break;
    // Add validators for other layout types
  }
  
  // Check duration value if provided
  if (request.durationMs !== undefined && 
      (typeof request.durationMs !== 'number' || request.durationMs < 0)) {
    this.log('error', 'Invalid duration', { duration: request.durationMs });
    return false;
  }
  
  return true;
}
```

### 4. Robust Throttling System

Implement a more robust throttling system with queue management:

```typescript
interface ThrottledRequest {
  id: string;                   // Unique ID for this request
  activeDisplay: ActiveDisplay; // The display to show
  timestamp: number;            // When it was queued
  packageName: string;          // Package name for priority
  expiresAt?: number;           // When it expires from queue
}

private throttleQueue: ThrottledRequest[] = [];
private throttleTimer: NodeJS.Timeout | null = null;

private queueDisplay(activeDisplay: ActiveDisplay): void {
  const request: ThrottledRequest = {
    id: Math.random().toString(36).substring(2, 9),
    activeDisplay,
    timestamp: Date.now(),
    packageName: activeDisplay.displayRequest.packageName,
    // Optional: make queue items expire if they're too old
    expiresAt: Date.now() + 5000 // 5 second expiry
  };
  
  // Remove any existing requests from same package
  this.throttleQueue = this.throttleQueue.filter(
    req => req.packageName !== request.packageName
  );
  
  // Add new request to queue
  this.throttleQueue.push(request);
  this.log('info', 'Display request queued', { request });
  
  // Start the throttle processor if not running
  this.startThrottleProcessor();
}

private startThrottleProcessor(): void {
  if (this.throttleTimer) return;
  
  const processQueue = () => {
    // Clear the reference to the timer
    this.throttleTimer = null;
    
    if (this.throttleQueue.length === 0) return;
    
    // Remove expired requests
    const now = Date.now();
    this.throttleQueue = this.throttleQueue.filter(req => {
      if (req.expiresAt && req.expiresAt < now) {
        this.log('info', 'Request expired in queue', { request: req });
        return false;
      }
      return true;
    });
    
    if (this.throttleQueue.length === 0) return;
    
    // Sort by priority if needed
    // this.sortQueueByPriority();
    
    // Process the next request
    const nextRequest = this.throttleQueue.shift();
    if (nextRequest) {
      this.log('info', 'Processing queued display request', { request: nextRequest });
      this.sendDisplayDirectly(nextRequest.activeDisplay);
    }
    
    // If there are more requests, schedule the next processing
    if (this.throttleQueue.length > 0) {
      this.throttleTimer = setTimeout(
        processQueue, 
        this.config.throttleDelayMs
      );
    }
  };
  
  // Start the first timer
  this.throttleTimer = setTimeout(
    processQueue, 
    this.config.throttleDelayMs - (Date.now() - this.lastDisplayTime)
  );
}
```

### 5. State Recovery Mechanism

Add mechanisms to recover from inconsistent states:

```typescript
public resetState(): void {
  this.log('warn', 'Resetting display manager state');
  
  // Clear all state
  this.displayState = {
    currentDisplay: null,
    coreAppDisplay: null,
    backgroundLock: null
  };
  
  this.bootingApps.clear();
  this.throttleQueue = [];
  
  if (this.throttleTimer) {
    clearTimeout(this.throttleTimer);
    this.throttleTimer = null;
  }
  
  // Clear display
  if (this.userSession) {
    this.clearDisplay('main');
  }
  
  this.log('info', 'Display manager state has been reset');
}

public verifyCoreAppDisplay(): void {
  if (!this.userSession) return;
  
  // Check if core app is running but not correctly represented in state
  const coreAppRunning = this.userSession.activeAppSessions.includes(
    this.config.mainAppPackageName
  );
  
  if (coreAppRunning && !this.displayState.coreAppDisplay) {
    this.log('warn', 'Core app is running but no display state exists, recovering');
    // Trigger display update from core app
    // This would typically happen via API call to the core app
  }
}
```

### 6. Background Lock Improvements

Redesign the background lock system for better clarity:

```typescript
interface BackgroundLock {
  packageName: string;
  acquiredAt: number;
  expiresAt: number;
  lastActivityAt: number;
  priority: number;
}

private acquireBackgroundLock(packageName: string): BackgroundLock | null {
  const now = Date.now();
  
  // Check if this package already has a lock
  if (this.displayState.backgroundLock?.packageName === packageName) {
    // Update the existing lock
    const updatedLock = {
      ...this.displayState.backgroundLock,
      lastActivityAt: now,
      // Optionally extend expiry time
      expiresAt: now + this.config.lockTimeoutMs
    };
    this.displayState.backgroundLock = updatedLock;
    this.log('info', 'Extended existing background lock', { lock: updatedLock });
    return updatedLock;
  }
  
  // Check if we can acquire a new lock
  if (!this.displayState.backgroundLock || 
      this.displayState.backgroundLock.expiresAt < now ||
      now - this.displayState.backgroundLock.lastActivityAt > this.config.lockInactiveTimeoutMs) {
    
    // Create new lock
    const newLock: BackgroundLock = {
      packageName,
      acquiredAt: now,
      expiresAt: now + this.config.lockTimeoutMs,
      lastActivityAt: now,
      priority: this.getAppPriority(packageName)
    };
    
    this.displayState.backgroundLock = newLock;
    this.log('info', 'Acquired new background lock', { lock: newLock });
    return newLock;
  }
  
  // Can't acquire lock
  this.log('info', 'Failed to acquire background lock', { 
    requester: packageName,
    currentLock: this.displayState.backgroundLock
  });
  return null;
}

private releaseBackgroundLock(packageName: string): boolean {
  if (!this.displayState.backgroundLock) return false;
  
  if (this.displayState.backgroundLock.packageName === packageName) {
    this.log('info', 'Released background lock', { 
      lock: this.displayState.backgroundLock 
    });
    this.displayState.backgroundLock = null;
    return true;
  }
  
  return false;
}

private checkBackgroundLocks(): void {
  if (!this.displayState.backgroundLock) return;
  
  const now = Date.now();
  const lock = this.displayState.backgroundLock;
  
  // Check if lock has expired
  if (lock.expiresAt < now) {
    this.log('info', 'Background lock expired', { lock });
    this.displayState.backgroundLock = null;
    return;
  }
  
  // Check for inactivity timeout
  if (now - lock.lastActivityAt > this.config.lockInactiveTimeoutMs) {
    this.log('info', 'Background lock inactive, releasing', { 
      lock,
      inactiveTime: now - lock.lastActivityAt,
      threshold: this.config.lockInactiveTimeoutMs
    });
    this.displayState.backgroundLock = null;
    return;
  }
}
```

### 7. Metrics Collection

Add performance metrics to help identify bottlenecks and issues:

```typescript
interface DisplayMetrics {
  requestsTotal: number;
  requestsSucceeded: number;
  requestsFailed: number;
  requestsThrottled: number;
  averageLatencyMs: number;
  lastLatencyMs: number;
  bootScreensShown: number;
  displaysByApp: Record<string, number>;
}

private metrics: DisplayMetrics = {
  requestsTotal: 0,
  requestsSucceeded: 0,
  requestsFailed: 0,
  requestsThrottled: 0,
  averageLatencyMs: 0,
  lastLatencyMs: 0,
  bootScreensShown: 0,
  displaysByApp: {}
};

private trackDisplayRequest(packageName: string, success: boolean, throttled: boolean, latencyMs: number): void {
  this.metrics.requestsTotal++;
  
  if (success) {
    this.metrics.requestsSucceeded++;
  } else {
    this.metrics.requestsFailed++;
  }
  
  if (throttled) {
    this.metrics.requestsThrottled++;
  }
  
  // Update latency metrics
  this.metrics.lastLatencyMs = latencyMs;
  this.metrics.averageLatencyMs = 
    (this.metrics.averageLatencyMs * (this.metrics.requestsTotal - 1) + latencyMs) / 
    this.metrics.requestsTotal;
  
  // Track by app
  if (!this.metrics.displaysByApp[packageName]) {
    this.metrics.displaysByApp[packageName] = 0;
  }
  this.metrics.displaysByApp[packageName]++;
  
  // Log metrics periodically or on significant changes
  if (this.metrics.requestsTotal % 100 === 0) {
    this.log('info', 'Display metrics', { metrics: { ...this.metrics } });
  }
}

public getMetrics(): DisplayMetrics {
  return { ...this.metrics };
}
```

## Implementation Plan

1. **Phase 1: Configuration System & Logging**
   - Extract hard-coded values to configuration
   - Implement enhanced logging system
   - Add basic metrics collection

2. **Phase 2: Request Validation & Error Handling**
   - Add comprehensive request validation
   - Improve error handling throughout
   - Implement state recovery mechanisms

3. **Phase 3: Throttling & Background Locks**
   - Redesign throttling system with proper queue
   - Improve background lock management
   - Add display conflict resolution

4. **Phase 4: Testing & Documentation**
   - Validate changes with various TPAs
   - Document new configuration options
   - Create usage guidelines for TPAs

## Benefits

These improvements will provide:

1. **Better Reliability**: More robust error handling, validation, and conflict resolution
2. **Improved Configurability**: Easy adjustment of timing and behavior without code changes
3. **Enhanced Debuggability**: Better logging and metrics for issue diagnosis
4. **Cleaner Architecture**: Separation of concerns and clearer state management
5. **Reduced Risk**: Lower chance of display issues impacting user experience

## Conclusion

The proposed improvements to the DisplayManager will make it more robust, maintainable, and configurable. By addressing the current limitations and enhancing key functionality, we can provide a better experience for both TPA developers and end users.