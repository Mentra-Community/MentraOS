# SDK Reconnection Bug - Architecture

## Root Cause

Modules store closure-captured `send` callbacks at construction time. After reconnection, AppSession creates a new WebSocket, but modules still reference the old closed WebSocket via their captured closures.

## Current Architecture (Broken)

```
┌─────────────────────────────────────────────────────────────┐
│ AppSession Constructor (Initial Connection)                 │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  this.ws = new WebSocket()  ←─ WebSocket #1                │
│                                                              │
│  this.audio = new AudioManager(..., this.send.bind(this))   │
│                                      ↓                       │
│                                   Captures closure           │
│                                   with WebSocket #1          │
│                                                              │
│  this.camera = new CameraModule(..., this.send.bind(this))  │
│  this.led = new LedModule(..., this.send.bind(this))        │
│  this.location = new LocationManager(..., this.send.bind(this)) │
│  this.dashboard = new DashboardManager(..., this.send.bind(this)) │
│                                                              │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ Module Storage (All 8 Modules)                              │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  constructor(..., send: (msg: any) => void) {               │
│    this.send = send;  // ❌ Stored at construction          │
│  }                                                           │
│                                                              │
│  someMethod() {                                              │
│    this.send(message);  // ❌ Uses captured closure          │
│  }                                                           │
│                                                              │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ After Reconnection                                           │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  this.ws.close()  ←─ Close WebSocket #1                    │
│  this.ws = new WebSocket()  ←─ Create WebSocket #2         │
│                                                              │
│  ❌ Modules still reference WebSocket #1 via closure        │
│                                                              │
│  session.audio.playAudio()                                   │
│    → this.send(message)                                      │
│    → AppSession.send() checks this.ws.readyState             │
│    → Sees WebSocket #1 (CLOSED)                             │
│    → throws "WebSocket not connected (current state: CLOSED)" │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Affected Code Locations

### AppSession Constructor

**File**: `cloud/packages/sdk/src/app/session/index.ts`
**Lines**: ~315-350

```typescript
// ❌ Current (broken)
this.audio = new AudioManager(
  this.config.packageName,
  this.sessionId || "unknown-session-id",
  this.send.bind(this),  // Closure-captured
  this,
  this.logger.child({module: "audio"}),
)

this.camera = new CameraModule(...)
this.led = new LedModule(...)
this.location = new LocationManager(this, this.send.bind(this))
this.dashboard = new DashboardManager(this, this.send.bind(this))
```

### Module Constructors (8 Modules)

#### 1. AudioManager

**File**: `modules/audio.ts` (L82-119)

```typescript
constructor(packageName, sessionId, send, session?, logger?) {
  this.send = send;  // ❌ Stored
}
```

#### 2. CameraModule

**File**: `modules/camera.ts` (L121-130)

```typescript
constructor(packageName, sessionId, send, session?, logger?) {
  this.send = send;  // ❌ Stored
  this.managedExtension = new CameraManagedExtension(..., send, ...)  // ❌ Passed stale
}
```

#### 3. CameraManagedExtension

**File**: `modules/camera-managed-extension.ts` (L117-127)

```typescript
constructor(packageName, sessionId, send, logger, session?) {
  this.send = send;  // ❌ Stored
}
```

#### 4. LedModule

**File**: `modules/led.ts` (L61-69)

```typescript
constructor(packageName, sessionId, send, logger?) {
  this.send = send;  // ❌ Stored
}
```

#### 5. LocationManager

**File**: `modules/location.ts` (L12-14)

```typescript
constructor(private session: AppSession, private send: (msg: any) => void) {}
// Uses this.send in getLatestLocation() ❌
```

#### 6. DashboardContentManager

**File**: `dashboard.ts` (L90-95)

```typescript
constructor(session, packageName, send, events) {
  this.send = send;  // ❌ Stored
}
```

#### 7. DashboardSystemManager

**File**: `dashboard.ts` (L34-38)

```typescript
constructor(session, packageName, send) {
  this.send = send;  // ❌ Stored
}
```

#### 8. DashboardManager

**File**: `dashboard.ts` (L174-193)

```typescript
constructor(session, send) {
  this.content = new DashboardContentManager(..., send, ...)  // ❌ Passes stale
  this.system = new DashboardSystemManager(..., send)  // ❌ Passes stale
}
```

## Fixed Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ AppSession Constructor (Initial Connection)                 │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  this.ws = new WebSocket()  ←─ WebSocket #1                │
│                                                              │
│  this.audio = new AudioManager(this, ...)  ✅               │
│                                    ↓                         │
│                              Pass session reference          │
│                                                              │
│  this.camera = new CameraModule(this, ...)  ✅              │
│  this.led = new LedModule(this, ...)  ✅                    │
│  this.location = new LocationManager(this)  ✅              │
│  this.dashboard = new DashboardManager(this)  ✅            │
│                                                              │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ Module Storage (Fixed)                                       │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  constructor(session: AppSession, ...) {                     │
│    this.session = session;  ✅ Store session reference      │
│  }                                                           │
│                                                              │
│  someMethod() {                                              │
│    this.session.sendMessage(message);  ✅ Always current    │
│  }                                                           │
│                                                              │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ After Reconnection (Fixed)                                   │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  this.ws = new WebSocket()  ←─ Create WebSocket #2         │
│                                                              │
│  ✅ Modules call session.sendMessage()                      │
│     → Always uses current this.ws                            │
│                                                              │
│  session.audio.playAudio()                                   │
│    → this.session.sendMessage(message)                       │
│    → AppSession.sendMessage() → AppSession.send()            │
│    → Checks this.ws (WebSocket #2)                          │
│    → WebSocket #2 is OPEN                                   │
│    → ✅ Success!                                            │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Implementation Changes

### 1. Add AppSession.sendMessage() Method

**File**: `cloud/packages/sdk/src/app/session/index.ts`

```typescript
/**
 * Public API for modules to send messages
 * Always uses current WebSocket connection
 */
public sendMessage(message: AppToCloudMessage): void {
  return this.send(message);
}
```

### 2. Update Module Constructors

**Pattern for all modules:**

```typescript
// Before ❌
constructor(packageName, sessionId, send, session?, logger?) {
  this.send = send;
  this.session = session;
}

// After ✅
constructor(session, packageName, sessionId, logger?) {
  this.session = session;
  // No this.send storage
}
```

### 3. Update Module Methods

**Pattern for all modules:**

```typescript
// Before ❌
async playAudio(options) {
  this.send(message);
}

// After ✅
async playAudio(options) {
  this.session.sendMessage(message);
}
```

### 4. Update AppSession Instantiation

**File**: `cloud/packages/sdk/src/app/session/index.ts`

```typescript
// Before ❌
this.audio = new AudioManager(
  this.config.packageName,
  this.sessionId || "unknown-session-id",
  this.send.bind(this),
  this,
  this.logger.child({module: "audio"}),
)

// After ✅
this.audio = new AudioManager(
  this,
  this.config.packageName,
  this.sessionId || "unknown-session-id",
  this.logger.child({module: "audio"}),
)
```

## Module-Specific Notes

### AudioManager

- Update: constructor, `playAudio()`, `stopAudio()`, `speak()`
- Already has session reference (was optional, make required)

### CameraModule

- Update: constructor, `requestPhoto()`, `startStream()`, `stopStream()`
- Must also update CameraManagedExtension instantiation

### CameraManagedExtension

- Update: constructor, `startManagedStream()`, `stopManagedStream()`, `checkManagedStream()`
- Created by CameraModule, receives session from parent

### LedModule

- Update: constructor, `turnOn()`, `turnOff()`, `pattern()`

### LocationManager

- Remove `send` parameter from constructor (already has session)
- Update: `getLatestLocation()` to use `this.session.sendMessage()`
- Other methods already use `this.session.subscribe()` (safe)

### DashboardContentManager

- Update: constructor, `write()`, `writeToMain()`, `writeToExpanded()`

### DashboardSystemManager

- Update: constructor, `setTopLeft()`, `setTopRight()`, `setBottomLeft()`, `setBottomRight()`, `setViewMode()`

### DashboardManager

- Update: constructor to not receive `send` parameter
- Pass only session to child managers (DashboardContentManager, DashboardSystemManager)

## Testing Strategy

### Unit Tests

```typescript
describe("Module reconnection", () => {
  it("AudioManager works after reconnect", async () => {
    const session = new AppSession(config)
    await session.connect("session-1")

    await session.audio.playAudio({audioUrl: "test.mp3"})

    // Simulate reconnect
    await session.reconnect()

    // Should work
    await session.audio.playAudio({audioUrl: "test2.mp3"})
  })

  // Repeat for all 8 modules
})
```

### Integration Tests

1. Connect session
2. Verify each module works pre-reconnect
3. Trigger reconnection (close WebSocket)
4. Wait for CONNECTION_ACK
5. Verify each module works post-reconnect
6. Assert no "WebSocket not connected" errors

## Migration Notes

- **Breaking Change**: Module constructor signatures change
- **Mitigation**: Apps don't construct modules directly (AppSession does)
- **Impact**: Zero app code changes required
- **SDK Version**: Bump minor version (internal API change)

## Performance Impact

- **Negligible**: One extra method call (`sendMessage()` wrapper)
- **No allocations**: Session reference already stored in most modules
- **No closure overhead**: Direct method calls instead of bound functions

## Rollout Plan

1. Apply fixes to all 8 modules
2. Test locally with dev.mira.local
3. Deploy SDK update
4. Monitor Better Stack for "WebSocket not connected" errors (expect zero)
5. Collect user feedback

## Success Criteria

- ✅ All 8 modules work after reconnection
- ✅ Zero "WebSocket not connected (current state: CLOSED)" errors
- ✅ Multiple reconnect cycles work correctly
- ✅ No app code changes required
- ✅ Reconnection tests pass in CI
