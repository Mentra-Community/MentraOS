# Azure Speech Recognition Infinite Retry Loop Issue

## **CRITICAL ISSUE: Azure Speech Recognition Error Code 7 Infinite Retry Loop**

### **Issue Description**

The transcription service is experiencing an infinite retry loop where Azure Speech Recognition streams immediately fail with error code 7 (SPXERR_INVALID_OPERATION) and continuously retry every 3 seconds, causing:

- Excessive Azure Speech API calls and costs
- High CPU usage from constant retry attempts  
- Degraded system performance
- Log spam making debugging difficult
- User experience degradation (translation features broken)

### **Error Pattern**

```
[2025-06-04 06:39:22.927] DEBUG: Starting translation stream
[2025-06-04 06:39:23.198] INFO: Recognition session started
[2025-06-04 06:39:23.198] INFO: Translation stream started
[2025-06-04 06:39:23.200] ERROR: Recognition canceled
    reason: 0
    errorCode: 7
    errorDetails: {"name": "InvalidOperation"}
[2025-06-04 06:39:23.201] INFO: Scheduling retry for canceled recognition stream
[2025-06-04 06:39:26.202] INFO: Retrying canceled transcription stream
```

**Cycle repeats every 3 seconds indefinitely**

### **Root Cause Analysis**

#### **1. Azure Error Code 7 = SPXERR_INVALID_OPERATION**
- Indicates the operation is not valid in the current state
- Usually means the stream received audio data before being fully initialized
- This error should NOT be retried as it indicates a fundamental setup problem

#### **2. Current Retry Logic Flaw**
```typescript
// In transcription.service.ts - Current problematic logic
if (event.errorCode !== 1 && event.errorCode !== 2) {
  // Schedules retry for error code 7, causing infinite loop
  setTimeout(() => {
    this.createAndStartRecognizer(userSession, subscription);
  }, 3000);
}
```

**Problem**: Error code 7 is being treated as retryable when it should be terminal.

#### **3. Timing Issues**
- Audio data may be fed to `pushStream` before Azure recognition session is ready
- No synchronization between stream initialization and audio feed start
- Race condition between `recognizer.startContinuousRecognitionAsync()` and audio data arrival

#### **4. Missing Stream State Management**
- No tracking of when streams are actually ready to receive audio
- No validation that recognition session is fully initialized before use
- No mechanism to detect if stream setup failed vs. runtime error

### **Technical Analysis**

#### **Azure Speech SDK Error Codes**
- **Error 1**: Authentication failure (retryable with new credentials)
- **Error 2**: Network/timeout issues (retryable)  
- **Error 7**: Invalid operation (NOT retryable - indicates setup problem)
- **Other codes**: Various runtime errors (case-by-case retry logic needed)

#### **Stream Lifecycle Issues**
1. **Stream Creation**: `AudioInputStream.createPushStream()` - immediate
2. **Recognizer Setup**: Configure speech config, audio config - immediate  
3. **Recognition Start**: `startContinuousRecognitionAsync()` - **asynchronous**
4. **Audio Feed**: `pushStream.write()` - immediate

**Race Condition**: Step 4 can happen before Step 3 completes, causing error code 7.

### **Impact Assessment**

#### **Current Impact**
- ❌ Translation features completely broken for affected users
- ❌ High Azure Speech API costs from endless retry attempts
- ❌ System performance degradation from continuous failed operations
- ❌ Log pollution making debugging other issues difficult
- ❌ Poor user experience with non-functional features

#### **Business Impact**
- **Cost**: Potentially hundreds of unnecessary Azure API calls per user per hour
- **Performance**: CPU and memory waste from failed operations
- **Reliability**: Core translation features unavailable
- **Support**: Increased support tickets for broken translation

### **Proposed Solutions**

#### **Solution 1: Fix Retry Logic (Immediate - High Priority)**
```typescript
// Add error code 7 to non-retryable errors
if (event.errorCode !== 1 && event.errorCode !== 2 && event.errorCode !== 7) {
  // Only retry for retryable errors
  setTimeout(() => {
    userSession.logger.info('Retrying canceled transcription stream after retryable error');
    this.createAndStartRecognizer(userSession, subscription);
  }, 3000);
} else if (event.errorCode === 7) {
  // Log and stop for invalid operation errors
  userSession.logger.error({
    subscription,
    errorCode: event.errorCode,
    errorDetails: event.errorDetails
  }, 'Azure Speech Recognition - Invalid Operation error, stopping retries. Check stream setup timing.');
}
```

#### **Solution 2: Add Stream State Tracking (Medium Priority)**
```typescript
interface ASRStreamInstance {
  recognizer: ConversationTranscriber | azureSpeechSDK.TranslationRecognizer;
  pushStream: AudioInputStream;
  isReady?: boolean;        // New: Track if stream is ready for audio
  startTime?: number;       // New: Track initialization time
  errorCount?: number;      // New: Track retry attempts
}

// In stream initialization
recognizer.sessionStarted = () => {
  instance.isReady = true;  // Mark stream as ready
  userSession.logger.info('Azure Speech Recognition session fully initialized');
};
```

#### **Solution 3: Improve Audio Feed Timing (Medium Priority)**
```typescript
// In audio feed method - check stream readiness
public feedAudioToStream(userSession: UserSession, audioData: Buffer): void {
  for (const [subscription, instance] of userSession.transcriptionStreams!) {
    // Only feed audio to ready streams
    if (!instance.isReady) {
      userSession.logger.debug(`Skipping audio feed for ${subscription} - stream not ready`);
      continue;
    }
    
    try {
      instance.pushStream.write(audioData);
    } catch (error) {
      userSession.logger.error(`Error feeding audio to ${subscription}:`, error);
    }
  }
}
```

#### **Solution 4: Enhanced Error Diagnostics (Low Priority)**
```typescript
// Add detailed Azure Speech diagnostics
recognizer.canceled = (s, e) => {
  const diagnostics = {
    errorCode: e.errorCode,
    errorDetails: e.errorDetails,
    reason: e.reason,
    streamAge: Date.now() - (instance.startTime || 0),
    totalAudioFed: instance.totalAudioBytes || 0,
    azureRegion: AZURE_SPEECH_REGION,
    hasValidCredentials: !!AZURE_SPEECH_KEY
  };
  
  userSession.logger.error({
    subscription,
    diagnostics
  }, 'Azure Speech Recognition canceled with enhanced diagnostics');
};
```

#### **Solution 5: Circuit Breaker Pattern (Future Enhancement)**
```typescript
// Implement circuit breaker to prevent cascading failures
class AzureSpeechCircuitBreaker {
  private failureCount = 0;
  private lastFailureTime = 0;
  private readonly maxFailures = 5;
  private readonly resetTimeoutMs = 60000; // 1 minute
  
  canAttempt(): boolean {
    if (this.failureCount < this.maxFailures) return true;
    
    const timeSinceLastFailure = Date.now() - this.lastFailureTime;
    if (timeSinceLastFailure > this.resetTimeoutMs) {
      this.failureCount = 0; // Reset after timeout
      return true;
    }
    
    return false; // Circuit is open
  }
  
  recordFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();
  }
  
  recordSuccess(): void {
    this.failureCount = 0;
  }
}
```

### **Implementation Priority**

#### **Phase 1: Immediate Fixes (Deploy ASAP)**
1. ✅ **Fix retry logic** to exclude error code 7 - stops infinite loop
2. ✅ **Add enhanced logging** for error code 7 diagnostics
3. ✅ **Basic stream state tracking** to prevent timing issues

#### **Phase 2: Robustness Improvements (This Week)**
1. **Comprehensive stream state management** with ready flags
2. **Improved audio feed timing** with readiness checks  
3. **Better error categorization** for different retry strategies
4. **Monitoring and alerting** for Azure Speech service health

#### **Phase 3: Advanced Features (Next Sprint)**
1. **Circuit breaker pattern** to prevent cascading failures
2. **Exponential backoff** for retryable errors
3. **Health checks** for Azure Speech service availability
4. **Performance metrics** and cost monitoring

### **Testing Strategy**

#### **Test Cases**
1. **Rapid subscription changes** - ensure no error code 7 loops
2. **High audio load** - verify stream timing under stress
3. **Network interruptions** - test legitimate retry scenarios
4. **Azure service outages** - verify graceful degradation
5. **Multiple concurrent users** - check resource management

#### **Validation Criteria**
- ✅ No infinite retry loops in logs
- ✅ Error code 7 properly logged and stopped
- ✅ Translation features working reliably
- ✅ Reduced Azure API call volume
- ✅ Improved system performance metrics

### **Monitoring and Alerting**

#### **Key Metrics to Track**
- **Error Code 7 occurrences** - should drop to near zero
- **Azure Speech API call volume** - should decrease significantly  
- **Stream initialization success rate** - should improve
- **Translation feature availability** - should reach near 100%
- **System CPU/memory usage** - should decrease

#### **Alert Conditions**
- **Error code 7 > 5 instances in 5 minutes** - investigate timing issues
- **Total Azure Speech errors > 50/hour** - check service health
- **Translation success rate < 90%** - escalate to engineering
- **Retry loop detected** - immediate intervention required

### **Root Cause Prevention**

#### **Code Review Requirements**
- **Always check Azure error codes** for retry eligibility
- **Implement proper stream state management** for async operations
- **Add comprehensive error handling** with specific error type handling
- **Test timing-sensitive operations** under various load conditions

#### **Documentation Updates**
- **Azure Speech integration guide** with timing best practices
- **Error handling patterns** for external service integration
- **Monitoring playbook** for Azure Speech service issues
- **Troubleshooting guide** for transcription service problems

### **Lessons Learned**

1. **External service error codes** must be properly categorized for retry logic
2. **Asynchronous operation timing** requires careful synchronization  
3. **Infinite retry loops** can cause significant cost and performance impact
4. **Proper monitoring** is essential for detecting service degradation early
5. **Circuit breaker patterns** are valuable for external service reliability