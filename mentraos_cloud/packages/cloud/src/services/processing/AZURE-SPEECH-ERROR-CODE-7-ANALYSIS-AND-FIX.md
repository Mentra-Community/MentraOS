# Azure Speech Recognition Error Code 7: Root Cause Analysis and Comprehensive Fix

## **Executive Summary**

Users experience intermittent Azure Speech Recognition failures with **error code 7 (SPXERR_INVALID_OPERATION)** that create infinite retry loops, breaking transcription/translation functionality. The root cause is a **race condition** where audio data is fed to Azure streams before they're fully initialized, combined with inadequate retry logic and poor error diagnostics.

## **Current Problem Statement**

### **Symptoms**
- Users get "stuck" in a state where transcription/translation stops working
- Error code 7 occurs repeatedly every 3 seconds in infinite loops
- Some users work fine, others consistently fail
- No recovery without manual intervention
- Zero diagnostic insight into the actual timing issues

### **Impact**
- **Functional**: Core transcription/translation features broken
- **Performance**: Infinite retry loops waste CPU and Azure API calls
- **Cost**: Unnecessary Azure Speech API charges
- **User Experience**: Features appear broken with no user feedback
- **Debugging**: Logs provide no actionable insights

## **Dependency Analysis**

### **Primary Dependencies Chain**
```
Smart Glasses WebSocket Audio Data
    ↓
AudioManager.handleAudioData()
    ↓
transcriptionService.feedAudioToTranscriptionStreams()
    ↓
Azure Speech SDK (microsoft-cognitiveservices-speech-sdk@^1.44.1)
    ↓
pushStream.write() → Azure ConversationTranscriber/TranslationRecognizer
    ↓
Azure Speech Recognition Service (Cloud)
```

### **Service Dependencies**

#### **1. AudioManager Dependencies**
- **UserSession**: Container for audio state and transcription streams
- **LC3Service**: Audio decoding (when IS_LC3 enabled)
- **AudioWriter**: Debug audio output (when DEBUG_AUDIO enabled)
- **subscriptionService**: Determines which TPAs need audio data
- **transcriptionService**: Target for processed audio

#### **2. TranscriptionService Dependencies**
- **Azure Speech SDK**: Core recognition functionality
  - `ConversationTranscriber`: For pure transcription
  - `TranslationRecognizer`: For translation workflows
  - `AudioInputStream.createPushStream()`: Audio input mechanism
  - `SpeechConfig`/`SpeechTranslationConfig`: Configuration
- **subscriptionService**: Determines required language streams
- **UserSession.transcriptionStreams**: Map storing active streams
- **Environment Variables**: `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`

#### **3. Subscription Management Dependencies**
- **websocket-tpa.service**: Triggers stream updates when TPAs subscribe/unsubscribe
- **subscriptionService**: Calculates minimal required language subscriptions
- **UserSession**: Stores subscription state per user

### **Critical Dependency Relationships**

#### **Audio Flow Lifecycle**
```
1. Glasses sends WebSocket audio message
2. AudioManager.handleAudioData() receives binary data
3. AudioManager processes (LC3 decode if needed)
4. AudioManager calls transcriptionService.feedAudioToTranscriptionStreams()
5. transcriptionService iterates userSession.transcriptionStreams
6. For each stream: pushStream.write(audioData) → Azure SDK
7. Azure SDK processes audio through recognizer
8. Recognition results trigger callbacks → broadcast to TPAs
```

#### **Stream Lifecycle**
```
1. TPA subscribes to transcription/translation stream
2. websocket-tpa.service detects subscription change
3. subscriptionService.getMinimalLanguageSubscriptions() calculates needs
4. transcriptionService.updateTranscriptionStreams() called
5. For new streams: createASRStreamForSubscription() creates Azure components
6. Azure recognizer.startContinuousRecognitionAsync() called (ASYNC!)
7. Stream added to userSession.transcriptionStreams immediately
8. Audio starts flowing to stream before step 6 completes → ERROR CODE 7
```

## **Root Cause Analysis**

### **Primary Issue: Race Condition**
```typescript
// Current problematic sequence:
const streamInstance = {
  recognizer: new ConversationTranscriber(speechConfig, audioConfig),
  pushStream: pushStream,
  isReady: false,  // ← Set to false initially
  startTime: Date.now()
};

// Start recognition (ASYNC - takes time to establish Azure session)
recognizer.startContinuousRecognitionAsync(
  () => {
    sessionLogger.info('Recognition started');
    // ❌ BUG: isReady never set to true here!
  },
  (error) => {
    sessionLogger.error('Failed to start recognition');
    // Error handling...
  }
);

// ❌ PROBLEM: Stream immediately added to map
userSession.transcriptionStreams.set(subscription, streamInstance);

// ❌ PROBLEM: Audio immediately starts flowing
// AudioManager continuously calls feedAudioToTranscriptionStreams()
// which calls pushStream.write() before Azure session is ready
```

### **Secondary Issues**

#### **1. Inadequate Ready State Management**
```typescript
// Current logic in feedAudioToTranscriptionStreams():
if (!instance.isReady) {
  // Only warns after 5 seconds, doesn't properly block audio
  const streamAge = Date.now() - (instance.startTime || 0);
  if (streamAge > 5000) {
    sessionLogger.warn('Stream not ready after 5 seconds, skipping audio data');
  }
  return; // ← Good intention, but isReady is never set to true!
}
```

**Problems:**
- `isReady` is never actually set to `true` in the current code
- No synchronization with Azure's actual session state
- 5-second warning is arbitrary and not based on Azure feedback

#### **2. Poor Error Diagnostics**
```typescript
// Current error logging (lines 428-442):
sessionLogger.error({
  subscription,
  reason: event.reason,
  errorCode: event.errorCode,
  errorDetails: event.errorDetails,
  isInvalidOperation,
  streamAge: Date.now() - (instance.startTime || 0),
  wasReady: instance.isReady,
  azureErrorMapping: isInvalidOperation ? 'SPXERR_INVALID_OPERATION' : 'UNKNOWN'
}, 'Recognition canceled');
```

**Missing diagnostics:**
- No indication of audio flow timing relative to stream readiness
- No Azure session state information
- No correlation between audio feed attempts and stream state
- No insight into race condition occurrence

#### **3. Inappropriate Retry Logic**
```typescript
// Current retry logic (lines 450-465):
if (event.errorCode !== 1 && event.errorCode !== 2) {
  // ❌ Includes error code 7, but doesn't fix root cause
  setTimeout(() => {
    const retryStream = this.createASRStreamForSubscription(subscription, userSession);
    userSession.transcriptionStreams?.set(subscription, retryStream);
  }, 3000);
}
```

**Problems:**
- Retries error code 7 without fixing the timing issue
- No exponential backoff or retry limits
- Recreates the exact same race condition
- No enhanced setup for retry attempts

## **Azure Speech SDK Behavior Analysis**

### **Azure Session Lifecycle**
```typescript
// Azure Speech Recognition internal flow:
1. new ConversationTranscriber(speechConfig, audioConfig)
   → Creates recognizer object (synchronous)
   
2. recognizer.startContinuousRecognitionAsync(callback)
   → Initiates WebSocket connection to Azure (asynchronous)
   → Establishes authentication
   → Configures recognition parameters
   → Prepares for audio input
   
3. recognizer.sessionStarted event fires
   → Azure session is fully ready for audio input
   
4. pushStream.write(audioData) can now be called safely
   → Audio data flows to Azure recognition service
```

### **Error Code 7 Trigger Conditions**
Based on Azure documentation and observed behavior:
- **Error Code 7 = SPXERR_INVALID_OPERATION**
- Occurs when `pushStream.write()` is called before step 3 completes
- Azure SDK validates session state before accepting audio data
- Not a network issue - it's a state/timing validation failure

### **Azure Event Sequence**
```typescript
// Proper Azure event handling sequence:
recognizer.sessionStarted = (sender, event) => {
  // ✅ Azure session is ready for audio input
  streamInstance.isReady = true;
};

recognizer.sessionStopped = (sender, event) => {
  // ✅ Azure session is no longer accepting audio
  streamInstance.isReady = false;
};

recognizer.canceled = (sender, event) => {
  // ✅ Error occurred, session is terminated
  streamInstance.isReady = false;
  // Handle different error codes appropriately
};
```

## **Environmental Factors**

### **Why Some Users Work vs. Others Fail**

#### **Users Who Work Fine:**
- **Fast network to Azure region**: Session establishment completes quickly
- **Low audio volume**: Less frequent audio chunks, more time between writes
- **Simple subscriptions**: Single language streams initialize faster
- **Good timing luck**: Azure session ready before first audio chunk arrives

#### **Users Who Get Stuck:**
- **Network latency to Azure**: Session establishment takes longer
- **High audio volume**: Continuous audio chunks arrive before session ready
- **Multiple language subscriptions**: Complex stream setup increases timing window
- **CPU/memory pressure**: Slower processing increases race condition window
- **Once error 7 occurs**: Infinite retry loop prevents recovery

### **Azure Service Dependencies**
- **Region performance**: `AZURE_SPEECH_REGION` affects initialization latency
- **API rate limiting**: Multiple simultaneous stream creation may be throttled
- **Service availability**: Azure Speech service outages cause failures
- **Authentication latency**: `AZURE_SPEECH_KEY` validation timing

## **Proposed Comprehensive Fix**

### **1. Fix Race Condition with Proper Azure Event Synchronization**

```typescript
interface ASRStreamInstance {
  recognizer: ConversationTranscriber | azureSpeechSDK.TranslationRecognizer;
  pushStream: AudioInputStream;
  
  // Enhanced state tracking
  isReady: boolean;           // Azure session fully ready for audio
  isInitializing: boolean;    // Stream setup in progress
  startTime: number;          // Creation timestamp
  readyTime?: number;         // When Azure session became ready
  retryCount: number;         // Retry attempt counter
  
  // Diagnostics
  audioChunksReceived: number;    // Total audio chunks attempted
  audioChunksWritten: number;     // Successfully written to Azure
  lastAudioTime?: number;         // Last successful audio write
  sessionId?: string;             // Azure session identifier
}

private createASRStreamForSubscription(subscription: ExtendedStreamType, userSession: UserSession): ASRStreamInstance {
  const pushStream = azureSpeechSDK.AudioInputStream.createPushStream();
  const audioConfig = AudioConfig.fromStreamInput(pushStream);
  
  // Create stream instance with proper initial state
  const streamInstance: ASRStreamInstance = {
    recognizer: null!, // Will be set below
    pushStream,
    isReady: false,
    isInitializing: true,
    startTime: Date.now(),
    retryCount: 0,
    audioChunksReceived: 0,
    audioChunksWritten: 0
  };

  // Enhanced logging for creation
  sessionLogger.info({
    subscription,
    retryCount: streamInstance.retryCount,
    operation: 'createStream'
  }, 'Creating Azure Speech Recognition stream');

  // Set up recognizer based on stream type
  if (languageInfo.type === StreamType.TRANSLATION) {
    const translationConfig = azureSpeechSDK.SpeechTranslationConfig.fromSubscription(AZURE_SPEECH_KEY, AZURE_SPEECH_REGION);
    translationConfig.speechRecognitionLanguage = languageInfo.transcribeLanguage;
    translationConfig.addTargetLanguage(languageInfo.translateLanguage);
    translationConfig.setProfanity(ProfanityOption.Raw);
    streamInstance.recognizer = new azureSpeechSDK.TranslationRecognizer(translationConfig, audioConfig);
  } else {
    const speechConfig = azureSpeechSDK.SpeechConfig.fromSubscription(AZURE_SPEECH_KEY, AZURE_SPEECH_REGION);
    speechConfig.speechRecognitionLanguage = languageInfo.transcribeLanguage;
    speechConfig.setProfanity(ProfanityOption.Raw);
    streamInstance.recognizer = new ConversationTranscriber(speechConfig, audioConfig);
  }

  // ✅ CRITICAL: Proper Azure session event handling
  streamInstance.recognizer.sessionStarted = (sender: any, event: SessionEventArgs) => {
    streamInstance.isReady = true;
    streamInstance.isInitializing = false;
    streamInstance.readyTime = Date.now();
    streamInstance.sessionId = event.sessionId;
    
    const initializationTime = streamInstance.readyTime - streamInstance.startTime;
    
    sessionLogger.info({
      subscription,
      sessionId: event.sessionId,
      initializationTime,
      retryCount: streamInstance.retryCount,
      operation: 'sessionReady'
    }, `Azure Speech session ready after ${initializationTime}ms - audio flow enabled`);
  };

  streamInstance.recognizer.sessionStopped = (sender: any, event: SessionEventArgs) => {
    streamInstance.isReady = false;
    
    sessionLogger.info({
      subscription,
      sessionId: event.sessionId,
      audioChunksWritten: streamInstance.audioChunksWritten,
      operation: 'sessionStopped'
    }, 'Azure Speech session stopped - audio flow disabled');
  };

  // Enhanced error handling with detailed diagnostics
  streamInstance.recognizer.canceled = (sender: any, event: SpeechRecognitionCanceledEventArgs) => {
    streamInstance.isReady = false;
    streamInstance.isInitializing = false;
    
    const sessionAge = Date.now() - streamInstance.startTime;
    const timeSinceReady = streamInstance.readyTime ? Date.now() - streamInstance.readyTime : null;
    
    // Enhanced error diagnostics
    const errorDiagnostics = {
      subscription,
      sessionId: streamInstance.sessionId,
      errorCode: event.errorCode,
      errorDetails: event.errorDetails,
      reason: event.reason,
      
      // Timing diagnostics
      sessionAge,
      timeSinceReady,
      wasEverReady: !!streamInstance.readyTime,
      initializationTime: streamInstance.readyTime ? streamInstance.readyTime - streamInstance.startTime : null,
      
      // Audio flow diagnostics
      audioChunksReceived: streamInstance.audioChunksReceived,
      audioChunksWritten: streamInstance.audioChunksWritten,
      audioWriteSuccessRate: streamInstance.audioChunksReceived > 0 ? 
        (streamInstance.audioChunksWritten / streamInstance.audioChunksReceived * 100).toFixed(1) + '%' : 'N/A',
      
      // Retry context
      retryCount: streamInstance.retryCount,
      
      // Azure context
      azureRegion: AZURE_SPEECH_REGION,
      recognizerType: languageInfo.type === StreamType.TRANSLATION ? 'TranslationRecognizer' : 'ConversationTranscriber',
      
      // Root cause indicators
      likelyRacCondition: event.errorCode === 7 && !streamInstance.readyTime && streamInstance.audioChunksReceived > 0,
      likelyNetworkIssue: event.errorCode === 4 || event.reason === 'Error',
      likelyAuthIssue: event.errorCode === 1 || event.errorCode === 2
    };

    // Contextual error logging
    if (event.errorCode === 7) {
      if (!streamInstance.readyTime && streamInstance.audioChunksReceived > 0) {
        sessionLogger.error(errorDiagnostics, 
          '🔥 RACE CONDITION: Audio fed to Azure stream before session ready (Error Code 7)');
      } else {
        sessionLogger.error(errorDiagnostics, 
          '⚠️ Azure Invalid Operation (Error Code 7) - stream was ready but operation failed');
      }
    } else {
      sessionLogger.error(errorDiagnostics, 
        `Azure Speech Recognition canceled (Error Code ${event.errorCode})`);
    }

    // Handle retry logic with proper categorization
    this.handleStreamError(streamInstance, subscription, userSession, event);
  };

  // Start recognition and handle setup errors
  const startRecognition = () => {
    sessionLogger.debug({
      subscription,
      retryCount: streamInstance.retryCount,
      operation: 'startRecognition'
    }, 'Starting Azure Speech Recognition');

    if (languageInfo.type === StreamType.TRANSLATION) {
      (streamInstance.recognizer as azureSpeechSDK.TranslationRecognizer).startContinuousRecognitionAsync(
        () => {
          sessionLogger.debug({
            subscription,
            operation: 'recognitionStarted'
          }, 'Azure Translation Recognition started - waiting for session ready event');
        },
        (error) => {
          streamInstance.isInitializing = false;
          sessionLogger.error({
            subscription,
            error,
            retryCount: streamInstance.retryCount,
            operation: 'startRecognitionFailed'
          }, 'Failed to start Azure Translation Recognition');
          
          // Trigger retry logic through error handling
          this.handleStreamError(streamInstance, subscription, userSession, {
            errorCode: 999, // Custom error code for start failures
            errorDetails: error,
            reason: 'StartRecognitionFailed'
          });
        }
      );
    } else {
      (streamInstance.recognizer as ConversationTranscriber).startTranscribingAsync(
        () => {
          sessionLogger.debug({
            subscription,
            operation: 'transcriptionStarted'
          }, 'Azure Transcription started - waiting for session ready event');
        },
        (error) => {
          streamInstance.isInitializing = false;
          sessionLogger.error({
            subscription,
            error,
            retryCount: streamInstance.retryCount,
            operation: 'startTranscriptionFailed'
          }, 'Failed to start Azure Transcription');
          
          // Trigger retry logic through error handling
          this.handleStreamError(streamInstance, subscription, userSession, {
            errorCode: 999,
            errorDetails: error,
            reason: 'StartTranscriptionFailed'
          });
        }
      );
    }
  };

  startRecognition();
  return streamInstance;
}
```

### **2. Enhanced Audio Feed with Strict Readiness Gating**

```typescript
feedAudioToTranscriptionStreams(userSession: UserSession, audioData: Uint8Array) {
  if (!userSession.transcriptionStreams) {
    const sessionLogger = userSession.logger.child({ service: SERVICE_NAME });
    sessionLogger.error({ operation: 'feedAudio' }, 'No transcription streams found for session');
    return;
  }

  let totalStreams = 0;
  let readyStreams = 0;
  let audioWriteSuccesses = 0;
  let audioWriteFailures = 0;

  userSession.transcriptionStreams.forEach((instance, key) => {
    totalStreams++;
    instance.audioChunksReceived++;
    
    try {
      // ✅ STRICT READINESS CHECK: Only feed audio to fully ready streams
      if (!instance.isReady) {
        const sessionAge = Date.now() - instance.startTime;
        const status = instance.isInitializing ? 'initializing' : 'failed';
        
        // Enhanced logging for not-ready streams
        if (sessionAge > 2000 && sessionAge % 5000 < 100) { // Log every 5 seconds after 2 second grace period
          const sessionLogger = userSession.logger.child({ service: SERVICE_NAME });
          sessionLogger.warn({
            streamKey: key,
            sessionAge,
            status,
            audioChunksReceived: instance.audioChunksReceived,
            audioChunksWritten: instance.audioChunksWritten,
            retryCount: instance.retryCount,
            operation: 'audioSkipped'
          }, `Skipping audio for ${status} stream (${sessionAge}ms old)`);
        }
        return;
      }

      readyStreams++;

      // ✅ ENHANCED STREAM VALIDATION: Check if stream is closed before writing
      if ((instance.pushStream as any)?._readableState?.destroyed ||
          (instance.pushStream as any)?._readableState?.ended) {
        const sessionLogger = userSession.logger.child({ service: SERVICE_NAME });
        sessionLogger.warn({
          streamKey: key,
          operation: 'streamDestroyed'
        }, 'Skipping write to destroyed/ended stream');
        return;
      }

      // ✅ WRITE AUDIO WITH ENHANCED ERROR HANDLING
      (instance.pushStream as any).write(audioData);
      instance.audioChunksWritten++;
      instance.lastAudioTime = Date.now();
      audioWriteSuccesses++;

    } catch (error: unknown) {
      audioWriteFailures++;
      const sessionLogger = userSession.logger.child({ service: SERVICE_NAME });

      // Enhanced error diagnostics
      const errorDiagnostics = {
        streamKey: key,
        userId: userSession.userId,
        operation: 'feedAudio',
        
        // Audio context
        audioDataSize: audioData.length,
        audioDataType: audioData.constructor.name,
        
        // Stream state context
        streamAge: Date.now() - instance.startTime,
        isReady: instance.isReady,
        isInitializing: instance.isInitializing,
        audioChunksReceived: instance.audioChunksReceived,
        audioChunksWritten: instance.audioChunksWritten,
        retryCount: instance.retryCount,
        sessionId: instance.sessionId,
        
        // Error details
        errorCode: (error as any)?.code || (error as any)?.errorCode,
        errorDetails: (error as any)?.errorDetails || (error as any)?.details,
        errorName: (error as any)?.name,
        errorMessage: (error as any)?.message,
        
        // Stream state diagnostics
        pushStreamState: {
          exists: !!instance.pushStream,
          closed: (instance.pushStream as any)?._readableState?.ended,
          destroyed: (instance.pushStream as any)?._readableState?.destroyed,
          readable: (instance.pushStream as any)?._readableState?.readable
        },
        
        // Potential root cause indicators
        potentialRaceCondition: !instance.isReady && instance.audioChunksReceived > 0,
        potentialStreamClosed: (instance.pushStream as any)?._readableState?.ended || 
                              (instance.pushStream as any)?._readableState?.destroyed
      };

      // Contextual error logging
      if ((error as any)?.message === "Stream closed") {
        sessionLogger.warn(errorDiagnostics, 'Audio write failed - stream closed, removing from active streams');
        userSession.transcriptionStreams?.delete(key);
      } else if ((error as any)?.name === "InvalidOperation") {
        sessionLogger.error(errorDiagnostics, '🔥 Audio write failed - Invalid Operation (likely race condition)');
        userSession.transcriptionStreams?.delete(key);
      } else {
        sessionLogger.error(errorDiagnostics, 'Unexpected error writing audio to stream');
      }
    }
  });

  // Periodic summary logging (every 100 audio chunks)
  const audioChunkCounter = (userSession as any)._audioChunkCounter || 0;
  (userSession as any)._audioChunkCounter = audioChunkCounter + 1;
  
  if (audioChunkCounter % 100 === 0) {
    const sessionLogger = userSession.logger.child({ service: SERVICE_NAME });
    sessionLogger.debug({
      totalStreams,
      readyStreams,
      audioWriteSuccesses,
      audioWriteFailures,
      audioChunkNumber: audioChunkCounter,
      operation: 'audioFeedSummary'
    }, `Audio feed summary: ${readyStreams}/${totalStreams} streams ready, ${audioWriteSuccesses} writes succeeded`);
  }
}
```

### **3. Smart Retry Logic with Error Classification**

```typescript
private handleStreamError(
  instance: ASRStreamInstance,
  subscription: string,
  userSession: UserSession,
  errorEvent: any
): void {
  const sessionLogger = userSession.logger.child({ service: SERVICE_NAME });
  
  // Remove failed stream immediately
  userSession.transcriptionStreams?.delete(subscription);
  
  // Classify error types
  const errorCode = errorEvent.errorCode;
  const isRetryable = this.isRetryableError(errorCode, instance);
  const maxRetries = this.getMaxRetries(errorCode);
  
  if (!isRetryable) {
    sessionLogger.error({
      subscription,
      errorCode,
      reason: 'non_retryable',
      operation: 'giveUp'
    }, `Non-retryable error ${errorCode}, abandoning stream`);
    return;
  }
  
  if (instance.retryCount >= maxRetries) {
    sessionLogger.error({
      subscription,
      errorCode,
      retryCount: instance.retryCount,
      maxRetries,
      reason: 'max_retries_exceeded',
      operation: 'giveUp'
    }, `Max retries (${maxRetries}) exceeded for error ${errorCode}, abandoning stream`);
    return;
  }
  
  // Calculate retry delay with exponential backoff
  const baseDelay = this.getBaseRetryDelay(errorCode);
  const retryDelay = Math.min(baseDelay * Math.pow(2, instance.retryCount), 30000);
  
  sessionLogger.warn({
    subscription,
    errorCode,
    retryCount: instance.retryCount + 1,
    maxRetries,
    retryDelay,
    operation: 'scheduleRetry'
  }, `Scheduling retry ${instance.retryCount + 1}/${maxRetries} after ${retryDelay}ms for error ${errorCode}`);
  
  setTimeout(() => {
    // Check if subscription is still needed
    const currentSubscriptions = subscriptionService.getMinimalLanguageSubscriptions(userSession.sessionId);
    if (!currentSubscriptions.includes(subscription as ExtendedStreamType)) {
      sessionLogger.info({
        subscription,
        reason: 'no_longer_needed',
        operation: 'skipRetry'
      }, 'Skipping retry - subscription no longer needed');
      return;
    }
    
    // Check if stream was already recreated
    if (userSession.transcriptionStreams?.has(subscription)) {
      sessionLogger.info({
        subscription,
        reason: 'already_exists',
        operation: 'skipRetry'
      }, 'Skipping retry - stream already exists');
      return;
    }
    
    sessionLogger.info({
      subscription,
      retryCount: instance.retryCount + 1,
      operation: 'executeRetry'
    }, `Executing retry ${instance.retryCount + 1} for subscription ${subscription}`);
    
    try {
      // Create new stream with incremented retry count
      const retryStream = this.createASRStreamForSubscription(subscription, userSession);
      retryStream.retryCount = instance.retryCount + 1;
      userSession.transcriptionStreams?.set(subscription, retryStream);
    } catch (retryError) {
      sessionLogger.error({
        subscription,
        error: retryError,
        retryCount: instance.retryCount + 1,
        operation: 'retryFailed'
      }, 'Failed to create retry stream');
    }
  }, retryDelay);
}

private isRetryableError(errorCode: number, instance: ASRStreamInstance): boolean {
  switch (errorCode) {
    case 1: // Authentication error
    case 2: // Authorization error  
      return false; // Don't retry auth issues
      
    case 7: // Invalid operation - retryable if it's a race condition
      return true; // We'll fix the race condition with proper timing
      
    case 4: // Network timeout
    case 999: // Start recognition failed
    default:
      return true; // Retry other errors
  }
}

private getMaxRetries(errorCode: number): number {
  switch (errorCode) {
    case 7: return 5; // More retries for timing issues
    case 4: return 3; // Network timeouts
    case 999: return 2; // Start failures
    default: return 3;
  }
}

private getBaseRetryDelay(errorCode: number): number {
  switch (errorCode) {
    case 7: return 1000; // Quick retry for race conditions
    case 4: return 2000; // Longer delay for network issues
    case 999: return 1500; // Medium delay for start failures
    default: return 2000;
  }
}
```

## **Testing and Validation Plan**

### **1. Unit Tests**
- Stream lifecycle timing under various conditions
- Error code classification and retry logic
- Audio gating with different readiness states
- Retry limit enforcement

### **2. Integration Tests**
- High audio volume during stream initialization
- Multiple simultaneous subscription changes
- Network interruption scenarios
- Azure service timeout simulation

### **3. Load Tests**
- Multiple concurrent users with translation streams
- Rapid subscription change patterns
- Memory and CPU impact measurement
- Azure API call volume monitoring

### **4. Monitoring Points**
- Stream initialization success rate
- Error code 7 occurrence frequency
- Retry attempt distribution
- Audio write success rates
- Performance impact metrics

## **Expected Outcomes**

### **Immediate Improvements**
- ✅ Eliminate infinite retry loops
- ✅ Fix race condition with proper Azure event synchronization
- ✅ Provide actionable error diagnostics
- ✅ Maintain transcription functionality for transient issues

### **Long-term Benefits**
- 📈 Improved user experience with reliable transcription/translation
- 💰 Reduced Azure API costs from eliminated infinite loops
- 🔧 Better debugging capabilities with detailed logging
- 🚀 More robust system that handles edge cases gracefully

### **Key Success Metrics**
- **Error code 7 occurrences**: Should drop by 90%+
- **Stream initialization success rate**: Should reach 95%+
- **Translation feature availability**: Should maintain 99%+
- **Azure API call volume**: Should decrease significantly
- **Support tickets**: Fewer transcription-related issues

## **Implementation Priority**

### **Phase 1: Critical Race Condition Fix**
1. Implement proper Azure session event handling
2. Add strict audio readiness gating
3. Enhanced error diagnostics for root cause identification

### **Phase 2: Robust Retry Logic**
1. Smart error classification system
2. Exponential backoff with retry limits
3. Comprehensive retry logging

### **Phase 3: Monitoring and Optimization**
1. Performance metrics collection
2. Health monitoring dashboards
3. Automated alerting for stream failures
4. Cost optimization analysis

This comprehensive fix addresses the root cause while maintaining system reliability and providing the diagnostic tools needed to prevent future issues.