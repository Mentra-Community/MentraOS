# App Connection Lifecycle Issues (Updated)

## Current Problems

### 1. **Premature App State Transitions**

**Issue**: `AppManager.startApp()` marks apps as "running" before App actually connects.

**Location**: `AppManager.ts:158-161`

```typescript
this.userSession.runningApps.add(packageName); // ❌ Too early!
this.userSession.loadingApps.delete(packageName); // ❌ Too early!
```

**Impact**:

- Services try to send messages to non-existent connections
- Users see apps as "running" when they're actually broken
- No way to detect if app start actually succeeded

### 2. **Incorrect Grace Period Timings**

**Issue**: App apps use 60-second grace period instead of 5 seconds.

**Location**: `AppManager.ts:565` - App reconnection timer set to 60s
**Should be**: 5s for App self-reconnection, then manual resurrection

### 3. **Scattered WebSocket Health Checks**

**Issue**: Every service duplicates `websocket && websocket.readyState === 1` logic.

**Affected Services**: transcription.service, AudioManager, UnmanagedStreamingExtension, PhotoManager, etc.

**Impact**: No centralized resurrection logic when connections fail.

### 4. **No Completion Detection for startApp()**

**Issue**: `startApp()` doesn't wait for App handshake completion.

**Current Flow**: Webhook sent → immediate "success" (but App not actually connected)
**Needed**: Wait for CONNECTION_ACK to confirm actual success

### 5. **Inconsistent Service Logging**

**Issue**: Managers use different field names for service identification.

- Some use `component: 'AppManager'`
- Some use `service: SERVICE_NAME`

**Solution**: Standardize on `service: SERVICE_NAME` across all managers.

## Proposed Solutions

### 1. **Promise-Based startApp() with ACK Waiting**

**Concept**: Make `startApp()` async and wait for actual App connection + handshake.

```typescript
interface AppStartResult {
  success: boolean;
  error?: {
    stage: 'WEBHOOK' | 'CONNECTION' | 'AUTHENTICATION' | 'TIMEOUT';
    message: string;
  }
}

async startApp(packageName: string): Promise<AppStartResult>
```

**Implementation**:

- Create pending Promise when webhook sent
- Listen for CONNECTION_ACK to resolve Promise
- Reject on timeout (APP_SESSION_TIMEOUT_MS = 5s)
- Only add to `runningApps` after ACK received

### 2. **Connection Tracking Without Correlation IDs**

**Use Natural Identifiers**:

- **userId** for session-level tracking
- **userId + packageName** for app-specific tracking
- No SDK changes required (backwards compatible)

**Pending Connections Map**:

```typescript
// Track pending app starts
private pendingAppStarts = new Map<string, {
  packageName: string;
  resolve: (result: AppStartResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}>();
```

### 3. **Centralized App Messaging Through AppManager**

**Replace Direct WebSocket Access**:

```typescript
// Instead of this in services:
const websocket = userSession.appWebsockets.get(packageName);
if (websocket && websocket.readyState === 1) {
  websocket.send(JSON.stringify(message));
} else {
  logger.error("App not connected");
}

// Use this:
const result = await userSession.appManager.sendMessageToApp(
  packageName,
  message,
);
if (!result.sent && result.resurrectionTriggered) {
  logger.info("App disconnected, resurrection triggered");
}
```

**AppManager Messaging Method**:

```typescript
async sendMessageToApp(packageName: string, message: any): Promise<{
  sent: boolean;
  resurrectionTriggered: boolean;
  error?: string;
}> {
  const websocket = this.userSession.appWebsockets.get(packageName);

  if (websocket && websocket.readyState === WebSocket.OPEN) {
    try {
      websocket.send(JSON.stringify(message));
      return { sent: true, resurrectionTriggered: false };
    } catch (error) {
      // Send failed, trigger resurrection
      return await this.resurrectAppAndRetry(packageName, message);
    }
  } else {
    // No connection, trigger resurrection
    return await this.resurrectAppAndRetry(packageName, message);
  }
}
```

### 4. **Smart Resurrection Logic**

**5-Second Grace + Manual Resurrection**:

```typescript
private async resurrectAppAndRetry(packageName: string, originalMessage?: any) {
  this.logger.info({ userId: this.userSession.userId, packageName, service: 'AppManager' },
    'App connection failed, triggering resurrection');

  try {
    // Attempt resurrection
    const result = await this.startApp(packageName);

    if (result.success && originalMessage) {
      // Retry original message
      return await this.sendMessageToApp(packageName, originalMessage);
    }

    return {
      sent: !!result.success,
      resurrectionTriggered: true,
      error: result.error?.message
    };
  } catch (error) {
    return {
      sent: false,
      resurrectionTriggered: true,
      error: error.message
    };
  }
}
```

### 5. **Improved Logging with Natural Keys**

**Standardized Service Logging**:

```typescript
// In every manager constructor:
const SERVICE_NAME = "AppManager"; // or 'AudioManager', etc.
this.logger = userSession.logger.child({ service: SERVICE_NAME });
```

**Enhanced Context in Messages**:

```typescript
// Good log messages with natural correlation
this.logger.info(
  {
    userId,
    packageName,
    service: SERVICE_NAME,
  },
  `Starting app ${packageName} - webhook sent to ${webhookUrl}`,
);

this.logger.info(
  {
    userId,
    packageName,
    service: SERVICE_NAME,
    duration: Date.now() - startTime,
  },
  `App ${packageName} started successfully - ACK received`,
);
```

## Implementation Plan

### Phase 1: Fix startApp() State Management

1. **Remove premature state transitions** from startApp()
2. **Add pending connections tracking**
3. **Wait for ACK before marking as running**
4. **Fix 60s → 5s grace period**

### Phase 2: Centralize App Messaging

1. **Add sendMessageToApp() to AppManager**
2. **Update transcription.service** to use centralized messaging
3. **Update other services** one by one
4. **Remove direct websocket access**

### Phase 3: Enhance Resurrection

1. **Add resurrection logic** to AppManager
2. **Test resurrection scenarios**
3. **Add proper error handling and timeouts**

### Phase 4: Standardize Logging

1. **Update all managers** to use `service: SERVICE_NAME`
2. **Enhance log messages** with better context
3. **Verify searchability** in log aggregation

## Search Patterns for Debugging

```
// All app start attempts for a user
userId:"user123" AND "app" AND "start"

// All App connection issues for specific app
packageName:"com.example.app" AND ("not connected" OR "resurrection")

// All AppManager operations for user
userId:"user123" AND service:"AppManager"

// App authentication issues
service:"websocket-app" AND ("authentication" OR "auth")
```

This approach keeps backwards compatibility while fixing the core connection lifecycle issues.
