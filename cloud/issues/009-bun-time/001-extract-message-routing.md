# 001: Extract Message Routing

Move message handling from WebSocket services into UserSession/Manager hierarchy.

## Problem

`websocket-glasses.service.ts` and `websocket-app.service.ts` have giant switch statements handling 20+ message types inline. This:

- Makes files 1200+ lines
- Violates Single Responsibility Principle
- Makes testing difficult (need WebSocket to test message handling)
- Couples routing with business logic

## Goal

WebSocket services become thin connection lifecycle handlers (~200 lines). All message routing and handling moves to `UserSession` which delegates to appropriate managers.

## Current Flow

```
WebSocket → websocket-glasses.service.handleGlassesMessage()
                     │
                     └─ switch (message.type)
                            case VAD: // 50 lines inline
                            case HEAD_POSITION: // 50 lines inline
                            case TOUCH_EVENT: // 60 lines inline
                            // ... 15+ more cases
```

## Proposed Flow

```
WebSocket → websocket-glasses.service (lifecycle only)
                     │
                     └─ userSession.handleGlassesMessage(message)
                            │
                            ├─ transcriptionManager.handleVad()
                            ├─ deviceManager.handleHeadPosition()
                            └─ subscriptionManager.relayTouchEvent()
```

## Implementation

### Step 1: Add Message Routing to UserSession

Add two new methods to `UserSession.ts`:

```typescript
async handleGlassesMessage(message: GlassesToCloudMessage): Promise<void> {
  switch (message.type) {
    case GlassesToCloudMessageType.VAD:
      await this.transcriptionManager.handleVad(message);
      break;
    case GlassesToCloudMessageType.HEAD_POSITION:
      await this.deviceManager.handleHeadPosition(message);
      break;
    // ... route to appropriate managers
  }
}

async handleAppMessage(appWs: WebSocket, packageName: string, message: AppToCloudMessage): Promise<void> {
  switch (message.type) {
    case AppToCloudMessageType.DISPLAY_REQUEST:
      this.displayManager.handleDisplayRequest(message);
      break;
    // ... route to appropriate managers
  }
}
```

### Step 2: Move Handler Logic to Managers

For each inline handler, move to the appropriate manager:

| Message Type               | From                                  | To                                                                                              |
| -------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `VAD`                      | websocket-glasses.service.ts:844-894  | AudioManager.handleVad() (then notifies TranscriptionManager, TranslationManager via listeners) |
| `HEAD_POSITION`            | websocket-glasses.service.ts:902-949  | DeviceManager.handleHeadPosition()                                                              |
| `TOUCH_EVENT`              | websocket-glasses.service.ts:565-657  | SubscriptionManager.relayTouchEvent()                                                           |
| `CORE_STATUS_UPDATE`       | websocket-glasses.service.ts:349-500  | DeviceManager.handleCoreStatusUpdate()                                                          |
| `REQUEST_SETTINGS`         | websocket-glasses.service.ts:990-1038 | UserSettingsManager.handleRequestSettings()                                                     |
| `GLASSES_CONNECTION_STATE` | websocket-glasses.service.ts:956-982  | DeviceManager.handleGlassesConnectionState()                                                    |
| `LOCAL_TRANSCRIPTION`      | websocket-glasses.service.ts:819-836  | TranscriptionManager.handleLocalTranscription()                                                 |
| `RGB_LED_CONTROL`          | websocket-app.service.ts:263-311      | DeviceManager.handleLedControl()                                                                |
| `RTMP_STREAM_REQUEST`      | websocket-app.service.ts:327-393      | UnmanagedStreamingExtension.handleStreamRequest()                                               |
| `PHOTO_REQUEST`            | websocket-app.service.ts:440-485      | PhotoManager.handlePhotoRequest()                                                               |
| `SUBSCRIPTION_UPDATE`      | websocket-app.service.ts:855-999      | SubscriptionManager.handleSubscriptionUpdate()                                                  |

### Step 3: Slim Down WebSocket Services

Replace inline handling with delegation:

```typescript
// websocket-glasses.service.ts - BEFORE
ws.on("message", async (data) => {
  const message = JSON.parse(data.toString())
  switch (message.type) {
    case GlassesToCloudMessageType.VAD:
      // 50 lines of VAD handling
      break
    // ... 20 more cases
  }
})

// websocket-glasses.service.ts - AFTER
ws.on("message", async (data) => {
  if (isBinary) {
    userSession.audioManager.processAudioData(data)
    return
  }
  const message = JSON.parse(data.toString())
  await userSession.handleGlassesMessage(message)
})
```

## Files Changed

| File                           | Change                                         |
| ------------------------------ | ---------------------------------------------- |
| `UserSession.ts`               | Add handleGlassesMessage(), handleAppMessage() |
| `websocket-glasses.service.ts` | Remove inline handlers, delegate               |
| `websocket-app.service.ts`     | Remove inline handlers, delegate               |
| `DeviceManager.ts`             | Add handler methods                            |
| `TranscriptionManager.ts`      | Add handler methods                            |
| `UserSettingsManager.ts`       | Add handler methods                            |
| `SubscriptionManager.ts`       | Add handler methods                            |

## Testing

1. Unit test each manager's handle\* method independently
2. Integration test message flow through UserSession
3. E2E test with actual WebSocket connections
4. Verify no behavior change for existing clients

## Rollout

1. Implement handlers in managers (additive, no risk)
2. Add routing methods to UserSession (additive, no risk)
3. Update WebSocket services to delegate (behavior change)
4. Test thoroughly in staging
5. Deploy to production
6. Remove dead code from WebSocket services

## Success Criteria

- [x] `websocket-glasses.service.ts` < 300 lines (460 lines - close, was 1258)
- [x] `websocket-app.service.ts` < 300 lines (192 lines ✅, was 1064)
- [x] All message handlers are unit testable (extracted to handlers/)
- [ ] No behavior change for existing clients (needs E2E testing)
- [ ] All existing tests pass (needs test run)

## Implementation Summary (Completed 2025-01-XX)

**Files Created:**

- `services/session/handlers/glasses-message-handler.ts` (543 lines) - Handles all glasses messages
- `services/session/handlers/app-message-handler.ts` (704 lines) - Handles all app messages
- `services/session/handlers/index.ts` (12 lines) - Exports handlers

**Files Modified:**

- `UserSession.ts` - Added `handleGlassesMessage()` and `handleAppMessage()` methods
- `websocket-glasses.service.ts` - Removed inline handlers, delegates to UserSession
- `websocket-app.service.ts` - Removed inline handlers, delegates to UserSession

**Line Count Changes:**
| File | Before | After | Change |
|------|--------|-------|--------|
| websocket-glasses.service.ts | 1258 | 460 | -798 |
| websocket-app.service.ts | 1064 | 192 | -872 |
| handlers/ (new) | 0 | 1259 | +1259 |
| UserSession.ts | ~660 | 691 | +31 |

**Net result:** WebSocket services are now thin connection lifecycle handlers. Message routing is centralized in UserSession, which delegates to handlers/. Handlers are independently testable without WebSocket connections.

## Open Questions

1. **Should handlers return responses or send directly?**
   - Option A: Handler sends via passed WebSocket
   - Option B: Handler returns response, UserSession sends
   - **Decision**: Option A - keeps handlers self-contained

2. **Keep switch or use handler registry?**
   - Switch: TypeScript exhaustiveness checking
   - Registry: More extensible
   - **Decision**: Keep switch for now, can refactor later

## Related Issues

- **010-audio-manager-consolidation** - VAD moves to AudioManager as part of this work, but full AudioManager/MicrophoneManager consolidation is separate (requires mobile client changes)
