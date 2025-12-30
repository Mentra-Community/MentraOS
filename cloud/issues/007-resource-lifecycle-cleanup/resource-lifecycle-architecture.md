# Resource Lifecycle Architecture

## Current System

### Event Listener Flow

```
UserSession created
    │
    ├── setupGlassesHeartbeat()
    │       └── websocket.on("pong", callback)  ← NEVER REMOVED
    │
    ├── AppManager.handleAppInit()
    │       └── ws.on("close", callback)        ← NEVER REMOVED (fixed)
    │
    ├── LiveKitClient.connect()
    │       ├── ws.on("message", callback)      ← NEVER REMOVED
    │       ├── ws.on("close", callback)        ← NEVER REMOVED
    │       └── ws.on("error", callback)        ← NEVER REMOVED
    │
    └── TranscriptionManager creates streams
            └── SonioxStream.initialize()
                    ├── ws.on("open", callback)     ← NEVER REMOVED
                    ├── ws.on("message", callback)  ← NEVER REMOVED
                    ├── ws.on("error", callback)    ← NEVER REMOVED
                    └── ws.on("close", callback)    ← NEVER REMOVED
```

### Disposal Flow (Current)

```typescript
// UserSession.ts:588-640
async dispose(): Promise<void> {
  // Disposes managers - but they don't remove their event listeners
  if (this.appManager) this.appManager.dispose();
  if (this.liveKitManager) this.liveKitManager.dispose();
  if (this.transcriptionManager) this.transcriptionManager.dispose();
  // ...

  // Clears heartbeat timer - but pong listener still attached!
  this.clearGlassesHeartbeat();

  // Removes from static map
  UserSession.sessions.delete(this.userId);
  
  // Object should be GC'd... but event listeners keep it alive
}
```

### Problem: Reference Chain

```
                    ┌─────────────────────────────────────┐
                    │         V8 Garbage Collector        │
                    │   "Can't collect - still reachable" │
                    └─────────────────────────────────────┘
                                      │
                                      ▼
┌──────────────────────────────────────────────────────────────────┐
│  WebSocket (underlying TCP connection may still be open)         │
│                                                                  │
│  _events: {                                                      │
│    "pong": [Function: bound callback] ──────┐                   │
│    "close": [Function: bound callback] ─────┤                   │
│    "message": [Function: bound callback] ───┤                   │
│  }                                          │                   │
└─────────────────────────────────────────────┼───────────────────┘
                                              │
                    ┌─────────────────────────┘
                    │  Closure captures `this`
                    ▼
┌──────────────────────────────────────────────────────────────────┐
│  UserSession (should be GC'd but isn't)                          │
│                                                                  │
│  this.appManager ──────────► AppManager                          │
│  this.liveKitManager ──────► LiveKitManager ──► LiveKitClient   │
│  this.transcriptionManager ─► TranscriptionManager ──► Streams  │
│  this.websocket ───────────► WebSocket (circular!)              │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Key Code Paths

**UserSession pong handler** - `packages/cloud/src/services/session/UserSession.ts:216-230`
```typescript
// Set up pong handler with timeout detection
this.websocket.on("pong", () => {
  this.lastPongTime = Date.now();
  // ... more logic using `this`
});
```

**LiveKitClient event handlers** - `packages/cloud/src/services/session/livekit/LiveKitClient.ts:119-280`
```typescript
this.ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
  // Uses this.logger, this.userSession, etc.
});

this.ws.on("close", (code: number, reason: Buffer) => {
  this.scheduleReconnect();  // Uses `this`
});

this.ws.on("error", (err) => {
  this.logger.warn({ err }, "Bridge WS error");
});
```

**Soniox stream handlers** - `packages/cloud/src/services/session/transcription/providers/SonioxTranscriptionProvider.ts:403-440`
```typescript
this.ws.on("open", () => { /* uses this */ });
this.ws.on("message", (data: Buffer) => { this.handleMessage(data); });
this.ws.on("error", (error: Error) => { /* uses this */ });
this.ws.on("close", (code: number, reason: Buffer) => { /* uses this */ });
```

## Proposed System

### ResourceTracker Integration

```
UserSession created
    │
    ├── this.resources = new ResourceTracker()
    │
    ├── setupGlassesHeartbeat()
    │       ├── websocket.on("pong", pongHandler)
    │       └── resources.track(() => websocket.off("pong", pongHandler))
    │
    ├── AppManager (has own ResourceTracker)
    │       └── Tracks its WebSocket handlers
    │
    ├── LiveKitClient (has own ResourceTracker)
    │       └── Tracks message/close/error handlers
    │
    └── dispose()
            └── this.resources.dispose()  ← Removes ALL listeners
```

### New Disposal Flow

```typescript
// UserSession.ts - proposed
class UserSession {
  private resources = new ResourceTracker();
  private disposed = false;

  private setupGlassesHeartbeat(): void {
    // Store handler reference for removal
    const pongHandler = () => {
      if (this.disposed) return;  // Guard against stale callback
      this.lastPongTime = Date.now();
    };
    
    this.websocket.on("pong", pongHandler);
    
    // Track for automatic cleanup
    this.resources.track(() => {
      this.websocket.off("pong", pongHandler);
    });
    
    // Track the interval too
    this.glassesHeartbeatInterval = setInterval(() => {
      if (this.disposed) return;
      // ... heartbeat logic
    }, HEARTBEAT_INTERVAL);
    this.resources.trackInterval(this.glassesHeartbeatInterval);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;  // Idempotent
    this.disposed = true;
    
    // Clean up all tracked resources (removes listeners, clears timers)
    this.resources.dispose();
    
    // Then dispose managers
    if (this.appManager) this.appManager.dispose();
    // ...
  }
}
```

### ResourceTracker Pattern

The SDK already has this: `packages/sdk/src/utils/resource-tracker.ts`

```typescript
export class ResourceTracker {
  private cleanupFunctions: CleanupFunction[] = [];
  private isDisposed = false;
  
  // Track arbitrary cleanup function
  track(cleanup: CleanupFunction): CleanupFunction;
  
  // Track object with dispose/close method
  trackDisposable(disposable: Disposable): CleanupFunction;
  
  // Track timers
  trackTimeout(timerId: NodeJS.Timeout): CleanupFunction;
  trackInterval(timerId: NodeJS.Timeout): CleanupFunction;
  
  // Create tracked timers directly
  setTimeout(callback, ms): NodeJS.Timeout;
  setInterval(callback, ms): NodeJS.Timeout;
  
  // Clean up everything
  dispose(): void;
  
  // Check state
  get disposed(): boolean;
}
```

### Helper: trackWebSocketEvents

For common WebSocket pattern, add a helper:

```typescript
// New utility function
function trackWebSocketEvents(
  resources: ResourceTracker,
  ws: WebSocket,
  handlers: {
    message?: (data: WebSocket.RawData) => void;
    close?: (code: number, reason: Buffer) => void;
    error?: (err: Error) => void;
    pong?: () => void;
  }
): void {
  if (handlers.message) {
    ws.on("message", handlers.message);
    resources.track(() => ws.off("message", handlers.message!));
  }
  if (handlers.close) {
    ws.on("close", handlers.close);
    resources.track(() => ws.off("close", handlers.close!));
  }
  if (handlers.error) {
    ws.on("error", handlers.error);
    resources.track(() => ws.off("error", handlers.error!));
  }
  if (handlers.pong) {
    ws.on("pong", handlers.pong);
    resources.track(() => ws.off("pong", handlers.pong!));
  }
}
```

## Implementation Plan

### Phase 1: Core Infrastructure

1. **Import ResourceTracker into cloud package**
   - File: `packages/cloud/src/utils/resource-tracker.ts`
   - Either re-export from SDK or copy (decide in spec)

2. **Add `trackWebSocketEvents` helper**
   - File: `packages/cloud/src/utils/websocket-utils.ts`

### Phase 2: UserSession (Highest Impact)

1. Add `private resources = new ResourceTracker()`
2. Add `private disposed = false`
3. Fix `setupGlassesHeartbeat()`:
   - Store pong handler reference
   - Track with resources.track()
   - Add disposed guard in callback
4. Update `dispose()`:
   - Set `disposed = true` first
   - Call `resources.dispose()`
   - Then dispose managers

### Phase 3: AppSession (Already Partially Fixed)

1. Add ResourceTracker
2. Track the pong handler in `setupHeartbeat()`
3. Close handler already fixed

### Phase 4: LiveKitClient

1. Add ResourceTracker
2. Track message/close/error handlers in `connect()`
3. Add disposed guards in `scheduleReconnect()`

### Phase 5: Transcription/Translation Providers

1. `SonioxTranscriptionStream` - Track all WebSocket handlers
2. `AlibabaTranscriptionStream` - Track all WebSocket handlers
3. `SonioxTranslationStream` - Track all WebSocket handlers
4. `AlibabaTranslationStream` - Track all WebSocket handlers

### Phase 6: Remaining Managers

Audit and fix:
- `LiveKitGrpcClient` - gRPC stream handlers
- `LiveKitManager`
- `TranscriptionManager`
- `TranslationManager`
- `MicrophoneManager`
- `AudioManager`

## File Changes Summary

| File | Changes |
|------|---------|
| `packages/cloud/src/utils/resource-tracker.ts` | New file (import/copy from SDK) |
| `packages/cloud/src/utils/websocket-utils.ts` | New file (helper functions) |
| `packages/cloud/src/services/session/UserSession.ts` | Add ResourceTracker, fix pong handler |
| `packages/cloud/src/services/session/AppSession.ts` | Add ResourceTracker, fix pong handler |
| `packages/cloud/src/services/session/livekit/LiveKitClient.ts` | Add ResourceTracker, fix handlers |
| `packages/cloud/src/services/session/transcription/providers/*.ts` | Fix stream handlers |
| `packages/cloud/src/services/session/translation/providers/*.ts` | Fix stream handlers |

## Testing Strategy

### Memory Leak Detection

```typescript
// Existing: packages/cloud/src/services/debug/MemoryLeakDetector.ts
// Add checks for:
// 1. UserSession finalization within 60s of dispose()
// 2. No lingering WebSocket references after session end
```

### Manual Testing

1. Connect glasses, start transcription
2. Disconnect glasses (simulates battery death)
3. Wait for grace period (30s)
4. Check:
   - No "Session not found" errors in app logs
   - No reconnection loop
   - Heap snapshot shows UserSession was collected

### Unit Tests

```typescript
describe("ResourceTracker", () => {
  it("removes WebSocket listeners on dispose", () => {
    const ws = new MockWebSocket();
    const resources = new ResourceTracker();
    const handler = jest.fn();
    
    ws.on("pong", handler);
    resources.track(() => ws.off("pong", handler));
    
    ws.emit("pong");
    expect(handler).toHaveBeenCalledTimes(1);
    
    resources.dispose();
    ws.emit("pong");
    expect(handler).toHaveBeenCalledTimes(1);  // Not called again
  });
});
```

## Open Questions

1. **Should ResourceTracker be a base class or composition?**
   - Composition (current plan): `private resources = new ResourceTracker()`
   - Inheritance: `class UserSession extends DisposableBase`
   - **Decision**: Composition - less invasive, no class hierarchy changes

2. **What about async dispose?**
   - Some managers have `async dispose()` (e.g., LocationManager)
   - ResourceTracker.dispose() is sync
   - **Decision**: ResourceTracker handles sync cleanup (listeners, timers). Async cleanup (DB writes) remains in manager's dispose().

3. **Order of operations in dispose?**
   - Current: dispose managers, then clear own state
   - Proposed: set disposed flag, clear own resources, then dispose managers
   - **Decision**: Set flag first (prevents new operations), then resources, then managers