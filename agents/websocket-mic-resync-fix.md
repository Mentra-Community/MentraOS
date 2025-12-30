# WebSocket Reconnection Mic State Resync Fix

## Problem

When the phone's WebSocket connection to the cloud closes and reconnects, the microphone state can get out of sync. This manifests as:

- **Symptom**: Phone mic appears off (no audio being captured), but the cloud thinks mic should be on
- **Result**: Transcription/captions stop working silently
- **User sees**: Mic icon shows off on phone, no captions appearing

## Root Cause

The issue occurs during the following sequence:

1. Phone WebSocket disconnects (e.g., network hiccup, app backgrounding)
2. App SDK reconnects quickly during grace period
3. `SubscriptionManager.updateSubscriptions()` triggers `MicrophoneManager.handleSubscriptionChange()`
4. `MicrophoneManager.sendStateChangeToGlasses()` attempts to send mic ON command
5. **BUG**: WebSocket is still closed at this point, so send fails with "Cannot send microphone state change: WebSocket not open"
6. Phone WebSocket reconnects ~5 seconds later
7. **BUG**: No resync happens - `UserSession.updateWebSocket()` only updated the WebSocket reference and heartbeat
8. Phone continues thinking mic is off, cloud continues thinking mic is on

## Timeline from logs (2025-12-19 20:24:57 - 20:25:03)

| Time         | Event                                                                                  |
| ------------ | -------------------------------------------------------------------------------------- |
| 20:24:57.730 | Glasses WebSocket closed (code 1006)                                                   |
| 20:24:58.940 | App SDK reconnected during grace period                                                |
| 20:24:58.997 | Subscription update triggers mic state change                                          |
| 20:24:59.037 | **MicrophoneManager fails**: "Cannot send microphone state change: WebSocket not open" |
| 20:25:00.101 | MicrophoneManager internal state updated (but never sent to phone!)                    |
| 20:25:03.113 | Glasses WebSocket finally reconnects                                                   |
| 20:25:03.116 | CONNECTION_ACK sent, but **no mic resync triggered**                                   |

## Fix

Added `MicrophoneManager.forceResync()` call to `UserSession.updateWebSocket()`:

```typescript
// In UserSession.updateWebSocket()
if (this.microphoneManager) {
  this.logger.info(`[UserSession:updateWebSocket] Scheduling mic state resync after WebSocket reconnect`)
  setTimeout(() => {
    if (this.microphoneManager && this.websocket?.readyState === WebSocketReadyState.OPEN) {
      this.logger.info(`[UserSession:updateWebSocket] Forcing mic state resync after WebSocket reconnect`)
      this.microphoneManager.forceResync()
    } else {
      this.logger.warn(`[UserSession:updateWebSocket] Skipping mic resync - WebSocket not ready or manager disposed`)
    }
  }, 100) // Small delay to ensure WebSocket is fully ready
}
```

## Why the delay?

A 100ms delay is added to ensure:

1. WebSocket is fully established and ready to receive messages
2. Any pending operations from the reconnection are complete
3. The `readyState` has transitioned to `OPEN`

## Related Code Paths

`MicrophoneManager.forceResync()` is now called from multiple places to handle various edge cases:

1. **`DeviceManager.updateDeviceState()`** - when device state updates
2. **`DeviceManager.handleGlassesConnectionState()`** - when `GLASSES_CONNECTION_STATE` message received
3. **`MicrophoneManager.handleConnectionStateChange()`** - when connection state changes
4. **`MicrophoneManager.updateKeepAliveTimer()`** - when keep-alive detects state drift
5. **`MicrophoneManager.onAudioReceived()`** - when audio received but mic was thought to be off
6. **`UserSession.updateWebSocket()`** - **NEW**: when WebSocket reconnects

## Testing

To verify the fix:

1. Connect glasses and start an app that uses transcription
2. Verify captions are working
3. Force a WebSocket disconnect (toggle airplane mode briefly, or kill network)
4. Wait for reconnection
5. Verify captions continue working without manual intervention

## Files Changed

- `MentraOS/cloud/packages/cloud/src/services/session/UserSession.ts`
  - Added `forceResync()` call in `updateWebSocket()` method

## Related Bugs

- Previous fix in `MicrophoneManager.handleConnectionStateChange()` handled the case when `GLASSES_CONNECTION_STATE` message was received
- This fix handles the case when the WebSocket reconnects without a `GLASSES_CONNECTION_STATE` message
