# Azure Speech Recognition Error Code 4 Not Retried - Causing Stream Failures

## Overview

Azure Speech Recognition streams are failing after 5-minute idle periods due to error code 4 (WebSocket connection timeout) not being included in the retry logic. This causes permanent loss of transcription capability until manual intervention.

## Root Cause

In `transcription.service.ts:448-449`, the retry logic excludes error code 4:

```typescript
// If the error is a temporary issue (not authentication or invalid operation), schedule a retry
if (event.errorCode !== 1 && event.errorCode !== 2 && event.errorCode !== 7) {
```

**Error code 4 = Azure WebSocket connection idle timeout** - this should be retried, not treated as permanent failure.

## Error Details

User experiencing this error log:
```json
{
  "dt": "2025-06-04T20:22:59.319Z",
  "level": "error",
  "env": "debug", 
  "server": "cloud-debug",
  "userId": "isaiahballah@gmail.com",
  "service": "transcription.service",
  "subscription": "translation:en-US-to-es-MX",
  "reason": 0,
  "errorCode": 4,
  "errorDetails": "Exceeded maximum websocket connection idle duration(> 300000ms) websocket error code: 1000",
  "isInvalidOperation": false,
  "streamAge": 2402321,
  "wasReady": true,
  "azureErrorMapping": "UNKNOWN",
  "message": "Recognition canceled"
}
```

## Impact

When error code 4 occurs:
1. Azure stream gets deleted (line 446: `userSession.transcriptionStreams?.delete(subscription)`)
2. NO retry is scheduled because error code 4 is excluded from retry logic
3. System continues with no active transcription streams
4. Audio data flows but goes nowhere
5. Next timeout occurs in another 5 minutes, repeating the cycle

## System Comparison

Investigation of old vs new system revealed they are **architecturally nearly identical**:

### Audio Flow (Both Systems)
- Glasses → WebSocket → AudioManager → transcriptionService.feedAudioToTranscriptionStreams() → Azure

### VAD Handling (Both Systems) 
- VAD messages properly start/stop transcription streams
- Implementation is functionally identical

### Stream Lifecycle (Both Systems)
- Started on connection init
- Started/stopped by VAD detection
- Started/stopped by microphone state changes

**The only difference:** Error code 4 retry exclusion preventing recovery.

## Azure Error Code 4 Details

Based on Microsoft documentation:
- **Error Code 4**: WebSocket connection issues, specifically idle timeout
- **300000ms = 5 minutes**: Azure's default idle timeout for Speech Recognition
- **Normal behavior**: Azure automatically closes idle connections after 5 minutes
- **Expected handling**: Should be retried as temporary connectivity issue

## Solution

### Option 1: Include Error Code 4 in Retry Logic
```typescript
// Current (broken)
if (event.errorCode !== 1 && event.errorCode !== 2 && event.errorCode !== 7) {

// Fixed
if (event.errorCode !== 1 && event.errorCode !== 2) { // Allow code 4 and 7 to retry
```

### Option 2: Explicit Error Code 4 Handling
```typescript
// Add specific handling for timeout errors
if (event.errorCode === 4) {
  sessionLogger.info({ subscription }, 'Azure connection timeout, scheduling immediate retry');
  setTimeout(() => {
    // Immediate retry for timeout errors
    const currentSubscriptions = subscriptionService.getMinimalLanguageSubscriptions(userSession.sessionId);
    if (currentSubscriptions.includes(subscription as ExtendedStreamType) && 
        !userSession.transcriptionStreams?.has(subscription)) {
      sessionLogger.info({ subscription }, 'Retrying after Azure timeout');
      try {
        const retryStream = this.createASRStreamForSubscription(subscription, userSession);
        userSession.transcriptionStreams?.set(subscription, retryStream);
      } catch (retryError) {
        sessionLogger.error({ subscription, error: retryError }, 'Timeout retry failed');
      }
    }
  }, 1000); // 1 second delay instead of 3 seconds
}
```

### Option 3: Keep-Alive Implementation
Implement periodic audio to prevent 5-minute idle timeouts:
- Send minimal audio data during silent periods
- Use Azure's silence detection instead of full timeout

## Risk Assessment

**Low Risk Fix**: Option 1 (include error code 4 in existing retry logic)
- Minimal code change
- Uses existing retry mechanism  
- 3-second delay already implemented

**Medium Risk**: Option 2 (explicit handling)
- More code but better control
- Faster recovery (1 second vs 3 seconds)
- Better logging for timeout scenarios

**High Risk**: Option 3 (keep-alive)
- Significant architectural change
- May affect audio processing pipeline
- Requires thorough testing

## Recommended Fix

**Use Option 1** for immediate fix:
- Change line 449 in `transcription.service.ts`
- Remove error code 4 from exclusion list
- Test with 5+ minute silent periods

## Files Involved

- `/src/services/processing/transcription.service.ts` - Lines 448-449 (retry logic)
- `/src/services/session/docs/issues/TPA-CONNECTION-STATE-MANAGEMENT-ISSUES.md` - Related connection issues

## Testing Plan

1. **Reproduce Issue**: Set up translation stream, wait 6+ minutes in silence
2. **Verify Fix**: Confirm error code 4 triggers retry after fix
3. **End-to-End Test**: Verify transcription resumes after timeout
4. **Regression Test**: Ensure other error codes (1, 2, 7) still behave correctly

## Status

- **Discovered**: 2025-06-04
- **Priority**: High (impacts core transcription functionality)
- **Assigned**: Pending
- **Estimated Fix Time**: 15 minutes (Option 1)