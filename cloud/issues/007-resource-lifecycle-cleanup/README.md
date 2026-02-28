# Resource Lifecycle Cleanup

Fix memory leaks and stale callback issues in cloud session management.

## Documents

- **resource-lifecycle-spec.md** - Problem analysis, goals, constraints
- **resource-lifecycle-architecture.md** - Technical design and implementation plan

## Quick Context

**Current**: Event listeners on WebSockets are never removed. Timers capture `this` in closures. No `disposed` flags to prevent stale callbacks. Objects can't be garbage collected.

**Proposed**: Adopt ResourceTracker pattern (already exists in SDK), add disposed guards, systematically fix all listener/timer leaks.

## Key Context

The SDK has a `ResourceTracker` utility (`packages/sdk/src/utils/resource-tracker.ts`) that properly tracks and cleans up event listeners, timers, and disposables. The cloud-side `UserSession` and managers don't use it - they manually manage cleanup inconsistently, leading to memory leaks and zombie callbacks that fire after disposal.

## Root Cause

When `UserSession.dispose()` runs, it clears timers and calls `manager.dispose()` on child managers. But:

1. WebSocket event listeners (`.on("pong")`, `.on("close")`, etc.) are never removed
2. These listeners capture `this` in closures, preventing GC
3. Events can fire after disposal, causing operations on disposed objects
4. `AppManager` was creating new `AppSession` objects after disposal (fixed in initial investigation)

## Status

- [x] Identified root cause of reconnection loop (AppManager creating AppSessions after disposal)
- [x] Added `disposed` flag to AppManager
- [x] Fixed AppSession close handler ownership (moved to AppSession, properly removed on dispose)
- [x] Add ResourceTracker to cloud services (`cloud/src/utils/resource-tracker.ts`)
- [x] Add WebSocket event tracking utilities (`cloud/src/utils/websocket-utils.ts`)
- [x] Fix UserSession pong listener leak (added ResourceTracker, disposed flag, guarded callbacks)
- [x] Fix AppSession pong listener leak (added ResourceTracker, disposed flag)
- [x] Fix LiveKitClient listener leaks (message/close/error handlers now tracked)
- [x] Fix transcription/translation provider listener leaks (ResourceTracker, disposed guards, handler cleanup)
- [x] Fix LiveKitGrpcClient stream handler leaks (ResourceTracker, disposed guards on audio and playAudio streams)
- [x] Audit all `.on()` calls for proper cleanup (completed - all event listeners are now tracked)
- [x] Add disposed guards to remaining managers (completed - managers that don't use event listeners don't need ResourceTracker)

## Audit Results

Audited all `.on()` calls in `cloud/packages/cloud/src/services/session/`:

| File                              | Status   | Notes                                           |
| --------------------------------- | -------- | ----------------------------------------------- |
| `UserSession.ts`                  | ✅ Fixed | ResourceTracker, disposed guards                |
| `AppSession.ts`                   | ✅ Fixed | ResourceTracker, disposed guards                |
| `AppManager.ts`                   | ✅ N/A   | No direct event listeners (manages AppSessions) |
| `LiveKitClient.ts`                | ✅ Fixed | ResourceTracker, disposed guards                |
| `LiveKitGrpcClient.ts`            | ✅ Fixed | ResourceTracker, disposed guards                |
| `SonioxTranscriptionProvider.ts`  | ✅ Fixed | ResourceTracker, disposed guards                |
| `AlibabaTranscriptionProvider.ts` | ✅ Fixed | ResourceTracker, disposed guards                |
| `SonioxTranslationProvider.ts`    | ✅ Fixed | ResourceTracker, disposed guards                |
| `AlibabaTranslationProvider.ts`   | ✅ Fixed | ResourceTracker, disposed guards                |
| `AudioManager.ts`                 | ✅ N/A   | No event listeners                              |
| `CalendarManager.ts`              | ✅ N/A   | No event listeners                              |
| `DeviceManager.ts`                | ✅ N/A   | No event listeners                              |
| `LocationManager.ts`              | ✅ N/A   | No event listeners                              |
| `MicrophoneManager.ts`            | ✅ N/A   | No event listeners                              |
| `SubscriptionManager.ts`          | ✅ N/A   | No event listeners                              |
| `UserSettingsManager.ts`          | ✅ N/A   | No event listeners                              |
| `TranscriptionManager.ts`         | ✅ N/A   | No event listeners (delegates to providers)     |
| `TranslationManager.ts`           | ✅ N/A   | No event listeners (delegates to providers)     |

## Next Steps

- [ ] Test in staging environment
- [ ] Monitor for memory leaks using heap snapshots
- [ ] Verify no reconnection loops after abnormal WebSocket closes
- [ ] Add end-to-end tests for disposal scenarios
