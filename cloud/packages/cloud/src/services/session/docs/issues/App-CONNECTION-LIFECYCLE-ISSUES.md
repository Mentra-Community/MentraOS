# App Connection Lifecycle Issues

## Current Problems

### 1. **Premature App State Transitions**

**Issue**: `AppManager.startApp()` marks apps as "running" before App actually connects.

**Location**: `AppManager.ts:158-161`

```typescript
this.userSession.runningApps.add(packageName); // ❌ Too early!
this.userSession.loadingApps.delete(packageName); // ❌ Too early!
```

**Problem**: App appears "started" even if App fails to connect, webhook fails, or authentication fails.

**Impact**:

- Services try to send messages to non-existent connections
- Users see apps as "running" when they're actually broken
- Resurrection logic can't distinguish between "never started" and "disconnected"

### 2. **Incorrect Grace Period Timings**

**Issue**: Both user sessions and App apps use 60-second grace periods.

**Current State**:

- User session (glasses disconnect): 60s ✅ Correct
- App apps (app disconnect): 60s ❌ Should be 5s

**Location**: `AppManager.ts:565` - App uses 60s instead of 5s

**Impact**: Apps stay in "running" state for too long after disconnection.

### 3. **Scattered WebSocket Health Checks**

**Issue**: Every service duplicates `websocket && websocket.readyState === 1` logic.

**Affected Services**:

- `transcription.service.ts:488-502`
- `AudioManager.ts`
- `UnmanagedStreamingExtension.ts`
- `PhotoManager.ts`
- Many others...

**Impact**:

- No centralized resurrection logic
- Services just log errors instead of triggering recovery
- Duplicate code maintenance burden

### 4. **No Completion Detection for startApp()**

**Issue**: `startApp()` doesn't wait for App handshake completion.

**Current Flow**:

1. Send webhook → SUCCESS (but App not actually started)
2. App connects separately (if it works)
3. No way to know if step 2 succeeded

**Impact**:

- Can't detect resurrection success/failure
- No error propagation from App connection failures
- Difficult to debug connection issues

### 5. **Poor Error Propagation and Logging**

**Issue**: Connection failures don't bubble up with context.

**Current State**:

- Webhook success != app started
- WebSocket connection errors not linked to startApp attempts
- No correlation between webhook calls and connection outcomes
- Logs scattered across multiple services without correlation IDs

**Impact**:

- Hard to debug why apps fail to start
- No way to programmatically handle app start failures
- Support requests are difficult to diagnose

## Brainstormed Solutions

### 1. **Smart Connection Tracking System**

**Concept**: Track the full lifecycle from webhook → connection → authentication → ACK.

**Implementation Ideas**:

- Create `ConnectionAttempt` objects with correlation IDs
- Track state: `WEBHOOK_SENT` → `CONNECTED` → `AUTHENTICATED` → `HANDSHAKE_COMPLETE`
- Use event-driven architecture to update states
- `startApp()` waits for `HANDSHAKE_COMPLETE` or timeout

**Benefits**:

- Clear success/failure detection
- Error propagation with context
- Better debugging capabilities

### 2. **Promise-Based startApp() with Timeout**

**Concept**: Make `startApp()` return a Promise that resolves when handshake completes.

```typescript
async startApp(packageName: string): Promise<{
  success: boolean;
  error?: {
    stage: 'WEBHOOK' | 'CONNECTION' | 'AUTHENTICATION' | 'TIMEOUT';
    message: string;
    details?: any;
  }
}>
```

**Implementation**:

- Create pending Promise when webhook sent
- Listen for `CONNECTION_ACK` to resolve
- Reject on timeout or errors with stage information
- Track attempts with correlation IDs

### 3. **Centralized App Messaging Through AppManager**

**Concept**: All services use `appManager.sendMessageToApp()` instead of direct websocket access.

**Implementation**:

```typescript
interface AppMessageResult {
  sent: boolean;
  resurrectionTriggered: boolean;
  error?: string;
}

async sendMessageToApp(packageName: string, message: any): Promise<AppMessageResult>
```

**Logic**:

1. Check websocket health
2. If healthy → send message
3. If dead → trigger resurrection
4. If resurrection successful → retry send
5. Return detailed result

### 4. **Enhanced Logging with Correlation IDs**

**Concept**: Every operation gets a correlation ID for full traceability.

**Implementation**:

- Generate correlation ID for each `startApp()` attempt
- Pass correlation ID through webhook → connection → authentication
- All logs include correlation ID and operation stage
- Structured logging for easy searching

**Log Structure**:

```typescript
{
  correlationId: "start-app-12345",
  stage: "WEBHOOK_SENT" | "APP_CONNECTED" | "AUTHENTICATION" | "ACK_SENT",
  packageName: "com.example.app",
  userId: "user123",
  sessionId: "session456",
  success: boolean,
  error?: { code: string, message: string },
  timing: { startTime: number, duration: number }
}
```

### 5. **Connection State Machine**

**Concept**: Formal state machine for App connection lifecycle.

**States**:

- `IDLE` → `WEBHOOK_PENDING` → `CONNECTING` → `AUTHENTICATING` → `CONNECTED`
- `DISCONNECTED` → `RECONNECTING` → `CONNECTED`
- `FAILED` (terminal state with error details)

**Benefits**:

- Clear state transitions
- Impossible invalid states
- Easy to add retry logic
- Visual debugging possible

### 6. **Resurrection with Backoff Strategy**

**Concept**: Intelligent resurrection with escalating timeouts.

**Strategy**:

1. App disconnect detected
2. Wait 5s for self-reconnection
3. If no reconnect → attempt manual resurrection
4. Exponential backoff: 5s → 15s → 45s → give up
5. Track resurrection attempts per app
6. Circuit breaker for repeatedly failing apps

### 7. **Health Check Integration**

**Concept**: Regular health checks to proactively detect issues.

**Implementation**:

- Periodic ping/pong with Apps (separate from heartbeat)
- Detect zombie connections (connected but not responding)
- Preemptive resurrection before services try to send
- Health status in app state broadcasts

## Next Steps

1. **Document current exact flow** - Map out every step from startApp to ACK
2. **Design correlation ID system** - How to track operations across services
3. **Plan Promise-based startApp** - Define exact interface and timeout behavior
4. **Design centralized messaging** - AppManager App communication interface
5. **Plan migration strategy** - How to move services to new pattern
6. **Design testing strategy** - How to test failure scenarios reliably

## Investigation TODOs

- [ ] Trace exact timing of current startApp flow
- [ ] Map all services that do direct websocket access
- [ ] Identify all error scenarios that need handling
- [ ] Design correlation ID propagation strategy
- [ ] Plan structured logging format for searchability
- [ ] Consider WebSocket connection pooling/management strategies
