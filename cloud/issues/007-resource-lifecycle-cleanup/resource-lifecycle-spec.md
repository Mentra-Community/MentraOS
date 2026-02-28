# Resource Lifecycle Spec

## Overview

Cloud session managers have memory leaks and stale callback issues. Event listeners are registered but never removed, preventing garbage collection and causing callbacks to fire on disposed objects.

## Problem

### 1. Event Listener Leaks

WebSocket event handlers capture `this` in closures but are never removed:

```typescript
// UserSession.ts:216-220
this.websocket.on("pong", () => {
  this.lastPongTime = Date.now();  // `this` captured forever
});
```

This pattern exists across the codebase:

| Component | Events Never Removed |
|-----------|---------------------|
| `UserSession` | `pong` |
| `AppSession` | `pong` (heartbeat) |
| `LiveKitClient` | `message`, `close`, `error` |
| `LiveKitGrpcClient` | `data`, `error`, `end` |
| `SonioxTranscriptionStream` | `open`, `message`, `error`, `close` |
| `AlibabaTranscriptionStream` | `open`, `message`, `error`, `close` |
| `SonioxTranslationStream` | `open`, `message`, `error`, `close` |
| `AlibabaTranslationStream` | `open`, `message`, `error`, `close` |

### 2. Stale Callbacks After Disposal

Without `disposed` flags, callbacks execute on disposed objects:

```
23:52:39 - UserSession.dispose() runs, clears this.apps Map
23:53:00 - WebSocket close event fires (20 sec network delay)
23:53:00 - handleAppConnectionClosed() creates NEW AppSession
23:53:05 - Grace period expires, tries to resurrect dead session
```

This caused an infinite reconnection loop in production.

### 3. Reference Chain Preventing GC

```
WebSocket (listeners attached)
    │
    └── on("pong") ──► closure ──► UserSession
                                        │
                                        ├── appManager ──► AppSessions
                                        ├── transcriptionManager ──► Streams
                                        ├── liveKitManager ──► LiveKitClient
                                        └── ... (entire object graph)
```

Even after `dispose()`, the WebSocket's event listeners keep everything alive.

### 4. Inconsistent Dispose Patterns

| Component | Has `dispose()`? | Has `disposed` flag? | Removes listeners? |
|-----------|-----------------|---------------------|-------------------|
| `UserSession` | ✅ | ❌ | ❌ |
| `AppManager` | ✅ | ✅ (added) | N/A |
| `AppSession` | ✅ | ❌ | ✅ (added for close) |
| `LiveKitClient` | ✅ | ✅ | ❌ |
| `TranscriptionManager` | ✅ | ❌ | ❌ |
| `SonioxTranscriptionStream` | ✅ (`close()`) | ❌ | ❌ |

### Constraints

- **Can't break existing API**: Managers are instantiated throughout codebase
- **Must be incremental**: Can't rewrite everything at once
- **Performance**: ResourceTracker adds minimal overhead (array of functions)
- **SDK has solution**: `ResourceTracker` already exists, proven pattern

## Goals

1. **Zero event listener leaks** - All `.on()` calls have corresponding cleanup
2. **Disposed guards everywhere** - Callbacks check `disposed` before executing
3. **Consistent pattern** - All managers use ResourceTracker
4. **Prevent zombie operations** - No operations on disposed objects

## Non-Goals

- Rewriting manager architecture
- Changing the dispose() call order in UserSession
- Adding complex lifecycle state machines
- TypeScript strict mode compliance (separate effort)

## Success Criteria

1. `memoryLeakDetector` shows no lingering UserSession references after grace period
2. No "Session not found" errors from apps trying to reconnect to disposed sessions
3. Heap snapshots show UserSession objects are GC'd within 60 seconds of disposal
4. No console errors from operations on disposed managers

## Open Questions

1. **Import ResourceTracker from SDK or duplicate in cloud?**
   - Pro SDK import: Single source of truth
   - Pro duplicate: No cross-package dependency
   - **Leaning**: Import from SDK, it's already a dependency

2. **Add ResourceTracker to UserSession directly or create base class?**
   - Direct: Simpler, incremental
   - Base class: Cleaner for new managers
   - **Leaning**: Direct first, refactor to base class later

3. **Fix all managers at once or incrementally?**
   - All at once: Consistent, but large PR
   - Incremental: Safer, but inconsistent temporarily
   - **Decision**: Incremental, prioritize by impact (UserSession → LiveKit → Transcription)