# SDK Reconnection Bug - Specification

## Problem

After WebSocket reconnection, **8 SDK modules** fail with "WebSocket not connected (current state: CLOSED)" because they store closure-captured `send()` callbacks that reference the old, closed WebSocket.

### Affected Modules

| Module                  | Methods Impacted                                  | Priority |
| ----------------------- | ------------------------------------------------- | -------- |
| AudioManager            | `playAudio()`, `stopAudio()`, `speak()`           | P0       |
| CameraModule            | `requestPhoto()`, `startStream()`, `stopStream()` | P0       |
| CameraManagedExtension  | `startManagedStream()`, `stopManagedStream()`     | P0       |
| LedModule               | `turnOn()`, `turnOff()`, `pattern()`              | P1       |
| LocationManager         | `getLatestLocation()`                             | P1       |
| DashboardContentManager | `write()`, `writeToMain()`, `writeToExpanded()`   | P1       |
| DashboardSystemManager  | `setTopLeft()`, `setTopRight()`, etc.             | P2       |
| DashboardManager        | Parent container (passes stale send to children)  | P1       |

### Evidence

**Production error from dev.mira.local:**

```json
{
  "dt": "2025-11-14T20:28:45.176Z",
  "level": "error",
  "app": "dev.mira.local",
  "service": "app-session",
  "err": {
    "type": "Error",
    "message": "WebSocket not connected (current state: CLOSED)"
  }
}
```

### Root Cause

Modules receive and store `send` callback at construction time:

```typescript
// AppSession constructor
this.audio = new AudioManager(..., this.send.bind(this), ...)
                                    ^^^^^^^^^^^^^^^^^^^
                                    Binds to WebSocket #1

// AudioManager constructor
constructor(..., send: (message: any) => void) {
  this.send = send;  // ❌ Captures closure with WebSocket #1
}

// After reconnection
AppSession creates WebSocket #2, but modules still reference WebSocket #1
```

### Reproduction

1. Connect: `await session.connect('session-123')`
2. Request works: `await session.audio.playAudio({ audioUrl: '...' })` ✅
3. Simulate disconnect (network drop, backgrounding, etc.)
4. SDK auto-reconnects (sees `CONNECTION_ACK`)
5. Request fails: `await session.audio.playAudio({ audioUrl: '...' })` ❌
6. Error: "WebSocket not connected (current state: CLOSED)"

## Solution

**Pass AppSession reference instead of send callback.**

Modules call `session.sendMessage()` directly, which always uses the current WebSocket.

### Before (Broken)

```typescript
// AppSession constructor
this.audio = new AudioManager(
  packageName,
  sessionId,
  this.send.bind(this),  // ❌ Closure-captured
  this,
  logger
)

// AudioManager
constructor(packageName, sessionId, send, session?, logger?) {
  this.send = send;  // ❌ Stale after reconnect
}

playAudio(options) {
  this.send(message);  // ❌ Uses old WebSocket
}
```

### After (Fixed)

```typescript
// AppSession constructor
this.audio = new AudioManager(
  this,  // ✅ Pass session first
  packageName,
  sessionId,
  logger
)

// AudioManager
constructor(session, packageName, sessionId, logger?) {
  this.session = session;  // ✅ Store session reference
}

playAudio(options) {
  this.session.sendMessage(message);  // ✅ Always uses current WebSocket
}
```

## Constraints

- SDK auto-reconnection must continue working
- Cannot break existing app code (modules are internal to AppSession)
- Fix must apply to all current and future modules
- Maintain encapsulation (modules shouldn't access `AppSession.ws` directly)

## Success Metrics

| Metric                          | Before     | After        |
| ------------------------------- | ---------- | ------------ |
| Modules failing after reconnect | 8/8 (100%) | 0/8 (0%)     |
| Post-reconnect requests         | 0% success | 100% success |
| "WebSocket CLOSED" errors       | Frequent   | Zero         |
| App code changes required       | N/A        | 0            |

## Implementation Checklist

### Phase 1: Core Modules (P0)

- [ ] Fix AudioManager constructor and methods
- [ ] Fix CameraModule constructor and methods
- [ ] Fix CameraManagedExtension constructor and methods
- [ ] Update AppSession instantiation for above modules

### Phase 2: Secondary Modules (P1)

- [ ] Fix LedModule
- [ ] Fix LocationManager (remove send param, already has session)
- [ ] Fix DashboardContentManager
- [ ] Fix DashboardSystemManager
- [ ] Fix DashboardManager (parent)
- [ ] Update AppSession instantiation for above modules

### Phase 3: Testing & Deployment

- [ ] Add reconnection unit tests for each module
- [ ] Add integration tests for reconnection scenarios
- [ ] Verify no "WebSocket not connected" errors
- [ ] Test multiple reconnect cycles
- [ ] Deploy SDK update
- [ ] Monitor Better Stack logs

## Non-Goals

- Changing reconnection logic (works correctly)
- Buffering requests during reconnection (separate feature)
- Breaking app-facing API (modules are internal to AppSession)
