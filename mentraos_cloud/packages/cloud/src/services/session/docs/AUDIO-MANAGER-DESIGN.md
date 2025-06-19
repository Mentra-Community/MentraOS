# AudioManager Design Document

## Overview

The AudioManager is a specialized component responsible for handling all audio-related functionality within a user session. It follows the manager pattern established by other components like DisplayManager and MicrophoneManager. The AudioManager encapsulates audio processing, LC3 decoding, buffer management, and audio relay functionality that is currently embedded in the session service.

## Current Implementation Details

### Current Location of Audio Management

Currently, audio management is implemented primarily in the `handleAudioData` method of `session.service.ts`, along with related audio buffer handling:

```typescript
async handleAudioData(userSession: ExtendedUserSession, audioData: ArrayBuffer | any, isLC3 = IS_LC3): Promise<ArrayBuffer | void> {
  // Update the last audio timestamp
  userSession.lastAudioTimestamp = Date.now();

  // --- Maintain recentAudioBuffer for last 10 seconds ---
  if (audioData && userSession.recentAudioBuffer) {
    const now = Date.now();
    // Store the chunk with its timestamp
    userSession.recentAudioBuffer.push({ data: audioData, timestamp: now });
    // Prune to keep only the last 10 seconds
    const tenSecondsAgo = now - 10_000;
    userSession.recentAudioBuffer = userSession.recentAudioBuffer.filter(chunk => chunk.timestamp >= tenSecondsAgo);
  }

  // Lazy initialize the audio writer if it doesn't exist
  if (DEBUG_AUDIO && !userSession.audioWriter) {
    userSession.audioWriter = new AudioWriter(userSession.userId);
  }

  // Write the raw LC3 audio if applicable
  if (DEBUG_AUDIO && isLC3 && audioData) {
    await userSession.audioWriter?.writeLC3(audioData);
  }

  // Process LC3 first if needed
  let processedAudioData = audioData;
  if (isLC3 && userSession.lc3Service) {
    try {
      // The improved LC3Service handles null checks internally
      processedAudioData = await userSession.lc3Service.decodeAudioChunk(audioData);
      
      // ... more LC3 processing ...
    } catch (error) {
      // ... error handling ...
    }
  } else if (processedAudioData) {
    // ... PCM audio handling ...
  }

  transcriptionService.feedAudioToTranscriptionStreams(userSession, processedAudioData);
  
  // Relay audio to TPAs if there are subscribers
  if (processedAudioData && userSession.subscriptionManager.hasAudioSubscribers()) {
    this.relayAudioToTpas(userSession, processedAudioData);
  }
  
  return processedAudioData;
}

// Related audio relay function
relayAudioToTpas(userSession: ExtendedUserSession, audioData: ArrayBuffer): void {
  try {
    const sessionId = userSession.sessionId;
    const subscriptionManager = userSession.subscriptionManager;
    
    // Get all TPAs subscribed to audio
    const subscribedPackageNames = subscriptionManager.getSubscribers(StreamType.AUDIO_CHUNK);
    
    if (subscribedPackageNames.length === 0) {
      return; // No subscribers, nothing to do
    }
    
    // Send binary data to each subscribed TPA
    for (const packageName of subscribedPackageNames) {
      const connection = userSession.appConnections.get(packageName);
      
      if (connection && connection.readyState === WebSocket.OPEN) {
        try {
          connection.send(audioData);
        } catch (sendError) {
          userSession.logger.error(`Error sending audio to ${packageName}:`, sendError);
        }
      }
    }
  } catch (error) {
    userSession.logger.error(`Error relaying audio:`, error);
  }
}
```

### Current Interfaces

The current system uses several interfaces for audio data:

```typescript
export interface SequencedAudioChunk {
  sequenceNumber: number;
  timestamp: number;
  data: ArrayBufferLike;
  isLC3: boolean;
  receivedAt: number;
}

export interface OrderedAudioBuffer {
  chunks: SequencedAudioChunk[];
  lastProcessedSequence: number;
  processingInProgress: boolean;
  expectedNextSequence: number;
  bufferSizeLimit: number;
  bufferTimeWindowMs: number;
  bufferProcessingInterval: NodeJS.Timeout | null;
}
```

### Current Issues

1. **Complex Processing Logic**: Audio processing combines multiple concerns
2. **Scattered Audio Handling**: Audio functions spread across service
3. **LC3 Integration**: LC3 decoding mixed with general audio handling
4. **Error Recovery**: Error handling is mixed with processing logic
5. **Mixed Responsibilities**: Audio processing, buffer management, and relay combined

## Important Implementation Note

**Regarding Subscription Management**: Although our design might suggest using a subscription manager, the implementation should continue using the existing `subscriptionService` instead. The `SubscriptionManager` is not fully implemented yet, and using it would be risky. We should stick with the proven `subscriptionService` to ensure stability during refactoring.

Example of how to use the subscription service:
```typescript
// Instead of using this.userSession.subscriptionManager.hasAudioSubscribers()
const hasAudioSubscriptions = subscriptionService.hasMediaSubscriptions(this.userSession.sessionId);

// Instead of using this.userSession.subscriptionManager.getSubscribers(StreamType.AUDIO_CHUNK)
const subscribedPackageNames = subscriptionService.getSubscribedApps(this.userSession, StreamType.AUDIO_CHUNK);
```

## Proposed Implementation

### AudioManager Class

```typescript
/**
 * Manages audio data processing, buffering, and relaying
 * for a user session
 */
export class AudioManager {
  private userSession: ExtendedUserSession;
  private logger: Logger;
  
  // LC3 decoding service
  private lc3Service?: LC3Service;
  
  // Audio debugging writer
  private audioWriter?: AudioWriter;
  
  // Buffer for recent audio (last 10 seconds)
  private recentAudioBuffer: { data: ArrayBufferLike; timestamp: number }[] = [];
  
  // Ordered buffer for sequenced audio chunks
  private orderedBuffer: OrderedAudioBuffer;
  
  // Configuration
  private readonly LOG_AUDIO = false;
  private readonly DEBUG_AUDIO = false;
  private readonly IS_LC3 = false;
  
  constructor(userSession: ExtendedUserSession) {
    this.userSession = userSession;
    this.logger = userSession.logger.child({ component: 'AudioManager' });
    
    // Initialize ordered buffer
    this.orderedBuffer = {
      chunks: [],
      lastProcessedSequence: -1,
      processingInProgress: false,
      expectedNextSequence: 0,
      bufferSizeLimit: 100,
      bufferTimeWindowMs: 500,
      bufferProcessingInterval: null
    };
    
    // Initialize LC3 service if needed
    this.initializeLc3Service();
    
    this.logger.info('AudioManager initialized');
  }
  
  /**
   * Initialize the LC3 service
   */
  private async initializeLc3Service(): Promise<void> {
    try {
      if (this.IS_LC3) {
        const lc3ServiceInstance = createLC3Service(this.userSession.sessionId);
        await lc3ServiceInstance.initialize();
        this.lc3Service = lc3ServiceInstance;
        this.logger.info(`✅ LC3 Service initialized`);
      }
    } catch (error) {
      this.logger.error(`❌ Failed to initialize LC3 service:`, error);
    }
  }
  
  /**
   * Process incoming audio data
   * 
   * @param audioData The audio data to process
   * @param isLC3 Whether the audio is LC3 encoded
   * @returns Processed audio data
   */
  async processAudioData(audioData: ArrayBuffer | any, isLC3 = this.IS_LC3): Promise<ArrayBuffer | void> {
    try {
      // Update the last audio timestamp
      this.userSession.lastAudioTimestamp = Date.now();
      
      // Add to recent audio buffer
      this.addToRecentBuffer(audioData);
      
      // Lazy initialize the audio writer if needed
      this.initializeAudioWriterIfNeeded();
      
      // Write raw LC3 audio for debugging if applicable
      if (this.DEBUG_AUDIO && isLC3 && audioData) {
        await this.audioWriter?.writeLC3(audioData);
      }
      
      // Process the audio data
      let processedAudioData = await this.processAudioInternal(audioData, isLC3);
      
      // Send to transcription service
      if (processedAudioData) {
        transcriptionService.feedAudioToTranscriptionStreams(this.userSession, processedAudioData);
        
        // Relay to TPAs if there are subscribers
        // Note: Using subscriptionService instead of subscriptionManager
        if (subscriptionService.hasMediaSubscriptions(this.userSession.sessionId)) {
          this.relayAudioToTpas(processedAudioData);
        }
      }
      
      return processedAudioData;
    } catch (error) {
      this.logger.error(`Error processing audio data:`, error);
      return undefined;
    }
  }
  
  /**
   * Process audio data internally
   * 
   * @param audioData The audio data to process
   * @param isLC3 Whether the audio is LC3 encoded
   * @returns Processed audio data
   */
  private async processAudioInternal(audioData: ArrayBuffer | any, isLC3: boolean): Promise<ArrayBuffer | void> {
    // Return early if no data
    if (!audioData) return undefined;
    
    // Process LC3 if needed
    if (isLC3 && this.lc3Service) {
      try {
        // Decode the LC3 audio
        const decodedData = await this.lc3Service.decodeAudioChunk(audioData);
        
        if (!decodedData) {
          if (this.LOG_AUDIO) this.logger.warn(`⚠️ LC3 decode returned null`);
          return undefined;
        }
        
        // Write decoded PCM for debugging
        if (this.DEBUG_AUDIO) {
          await this.audioWriter?.writePCM(decodedData);
        }
        
        return decodedData;
      } catch (error) {
        this.logger.error(`❌ Error decoding LC3 audio:`, error);
        await this.reinitializeLc3Service();
        return undefined;
      }
    } else {
      // Non-LC3 audio
      if (this.DEBUG_AUDIO) {
        await this.audioWriter?.writePCM(audioData);
      }
      return audioData;
    }
  }
  
  /**
   * Add audio data to recent buffer
   * 
   * @param audioData Audio data to add
   */
  private addToRecentBuffer(audioData: ArrayBufferLike): void {
    if (!audioData) return;
    
    const now = Date.now();
    
    // Add to buffer
    this.recentAudioBuffer.push({
      data: audioData,
      timestamp: now
    });
    
    // Prune old data (keep only last 10 seconds)
    const tenSecondsAgo = now - 10_000;
    this.recentAudioBuffer = this.recentAudioBuffer.filter(
      chunk => chunk.timestamp >= tenSecondsAgo
    );
  }
  
  /**
   * Initialize audio writer if needed
   */
  private initializeAudioWriterIfNeeded(): void {
    if (this.DEBUG_AUDIO && !this.audioWriter) {
      this.audioWriter = new AudioWriter(this.userSession.userId);
    }
  }
  
  /**
   * Reinitialize the LC3 service after an error
   */
  private async reinitializeLc3Service(): Promise<void> {
    try {
      if (this.lc3Service) {
        this.logger.warn(`⚠️ Attempting to reinitialize LC3 service`);
        
        // Clean up existing service
        this.lc3Service.cleanup();
        this.lc3Service = undefined;
        
        // Create and initialize new service
        const newLc3Service = createLC3Service(this.userSession.sessionId);
        await newLc3Service.initialize();
        this.lc3Service = newLc3Service;
        
        this.logger.info(`✅ Successfully reinitialized LC3 service`);
      }
    } catch (reinitError) {
      this.logger.error(`❌ Failed to reinitialize LC3 service:`, reinitError);
    }
  }
  
  /**
   * Add a sequenced audio chunk to the ordered buffer
   * 
   * @param chunk Sequenced audio chunk
   */
  addToOrderedBuffer(chunk: SequencedAudioChunk): void {
    try {
      if (!this.orderedBuffer) return;
      
      // Add to buffer
      this.orderedBuffer.chunks.push(chunk);
      
      // Sort by sequence number (in case chunks arrive out of order)
      this.orderedBuffer.chunks.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
      
      // Enforce buffer size limit
      if (this.orderedBuffer.chunks.length > this.orderedBuffer.bufferSizeLimit) {
        // Remove oldest chunks
        this.orderedBuffer.chunks = this.orderedBuffer.chunks.slice(
          this.orderedBuffer.chunks.length - this.orderedBuffer.bufferSizeLimit
        );
      }
    } catch (error) {
      this.logger.error(`Error adding to ordered buffer:`, error);
    }
  }
  
  /**
   * Process chunks in the ordered buffer
   */
  async processOrderedBuffer(): Promise<void> {
    if (this.orderedBuffer.processingInProgress) {
      return; // Already processing
    }
    
    try {
      this.orderedBuffer.processingInProgress = true;
      
      // Skip if buffer is empty
      if (this.orderedBuffer.chunks.length === 0) {
        return;
      }
      
      // Process chunks in order
      for (const chunk of this.orderedBuffer.chunks) {
        // Skip already processed chunks
        if (chunk.sequenceNumber <= this.orderedBuffer.lastProcessedSequence) {
          continue;
        }
        
        // Process the chunk
        await this.processAudioData(chunk.data, chunk.isLC3);
        
        // Update last processed sequence
        this.orderedBuffer.lastProcessedSequence = chunk.sequenceNumber;
        
        // Update expected next sequence
        this.orderedBuffer.expectedNextSequence = chunk.sequenceNumber + 1;
      }
      
      // Remove processed chunks
      this.orderedBuffer.chunks = this.orderedBuffer.chunks.filter(
        chunk => chunk.sequenceNumber > this.orderedBuffer.lastProcessedSequence
      );
    } catch (error) {
      this.logger.error(`Error processing ordered buffer:`, error);
    } finally {
      this.orderedBuffer.processingInProgress = false;
    }
  }
  
  /**
   * Start the ordered buffer processing interval
   * 
   * @param intervalMs Interval in milliseconds
   */
  startOrderedBufferProcessing(intervalMs: number = 100): void {
    // Clear any existing interval
    this.stopOrderedBufferProcessing();
    
    // Start new interval
    this.orderedBuffer.bufferProcessingInterval = setInterval(
      () => this.processOrderedBuffer(),
      intervalMs
    );
    
    this.logger.info(`Started ordered buffer processing with interval ${intervalMs}ms`);
  }
  
  /**
   * Stop the ordered buffer processing interval
   */
  stopOrderedBufferProcessing(): void {
    if (this.orderedBuffer.bufferProcessingInterval) {
      clearInterval(this.orderedBuffer.bufferProcessingInterval);
      this.orderedBuffer.bufferProcessingInterval = null;
      this.logger.info(`Stopped ordered buffer processing`);
    }
  }
  
  /**
   * Relay audio data to TPAs
   * 
   * @param audioData Audio data to relay
   */
  private relayAudioToTpas(audioData: ArrayBuffer): void {
    try {
      // Get subscribers using subscriptionService instead of subscriptionManager
      const subscribedPackageNames = subscriptionService.getSubscribedApps(
        this.userSession, 
        StreamType.AUDIO_CHUNK
      );
      
      // Skip if no subscribers
      if (subscribedPackageNames.length === 0) {
        return;
      }
      
      // Send to each subscriber
      for (const packageName of subscribedPackageNames) {
        const connection = this.userSession.appConnections.get(packageName);
        
        if (connection && connection.readyState === WebSocket.OPEN) {
          try {
            connection.send(audioData);
          } catch (sendError) {
            this.logger.error(`Error sending audio to ${packageName}:`, sendError);
          }
        }
      }
    } catch (error) {
      this.logger.error(`Error relaying audio:`, error);
    }
  }
  
  /**
   * Get recent audio buffer
   * 
   * @returns Recent audio buffer
   */
  getRecentAudioBuffer(): { data: ArrayBufferLike; timestamp: number }[] {
    return [...this.recentAudioBuffer]; // Return a copy
  }
  
  /**
   * Get audio service info for debugging
   * 
   * @returns Audio service info
   */
  getAudioServiceInfo(): object | null {
    if (this.lc3Service) {
      return this.lc3Service.getInfo();
    }
    return null;
  }
  
  /**
   * Clean up all resources
   */
  dispose(): void {
    try {
      this.logger.info('Disposing AudioManager');
      
      // Stop buffer processing
      this.stopOrderedBufferProcessing();
      
      // Clean up LC3 service
      if (this.lc3Service) {
        this.logger.info(`🧹 Cleaning up LC3 service`);
        this.lc3Service.cleanup();
        this.lc3Service = undefined;
      }
      
      // Clear buffers
      this.recentAudioBuffer = [];
      if (this.orderedBuffer) {
        this.orderedBuffer.chunks = [];
      }
      
      // Clean up audio writer
      if (this.audioWriter) {
        // Audio writer doesn't have explicit cleanup
        this.audioWriter = undefined;
      }
    } catch (error) {
      this.logger.error(`Error disposing AudioManager:`, error);
    }
  }
}
```

### ExtendedUserSession Integration

```typescript
export interface ExtendedUserSession extends UserSession {
  // Existing properties...
  
  // Add AudioManager
  audioManager: AudioManager;
  
  // Legacy properties that will be moved to AudioManager
  // These can eventually be removed, but kept for backward compatibility during transition
  lc3Service?: LC3Service;
  audioWriter?: AudioWriter;
  audioBuffer?: OrderedAudioBuffer;
  recentAudioBuffer: { data: ArrayBufferLike; timestamp: number }[];
  lastAudioTimestamp?: number;
}
```

### Session Service Integration

The session service will delegate to the AudioManager:

```typescript
// In createSession
const userSession = partialSession as ExtendedUserSession;
// ...other initialization
userSession.audioManager = new AudioManager(userSession);

// Delegate methods
async handleAudioData(userSession: ExtendedUserSession, audioData: ArrayBuffer | any, isLC3 = IS_LC3): Promise<ArrayBuffer | void> {
  return userSession.audioManager.processAudioData(audioData, isLC3);
}

relayAudioToTpas(userSession: ExtendedUserSession, audioData: ArrayBuffer): void {
  // This is now handled internally by the AudioManager during processAudioData
}

getAudioServiceInfo(sessionId: string): object | null {
  const userSession = this.getSession(sessionId);
  if (userSession) {
    return userSession.audioManager.getAudioServiceInfo();
  }
  return null;
}
```

### Session Cleanup

```typescript
endSession(userSession: ExtendedUserSession): void {
  // ...existing cleanup
  
  // Clean up audio manager
  if (userSession.audioManager) {
    userSession.logger.info(`🧹 Cleaning up audio manager for session ${userSession.sessionId}`);
    userSession.audioManager.dispose();
  }
  
  // ...rest of cleanup
}
```

## Benefits

1. **Improved Audio Processing**: Audio processing is encapsulated and properly structured
2. **Clearer Error Handling**: Specific error handling for audio processing issues
3. **Better LC3 Integration**: LC3 decoding is properly managed
4. **Enhanced Buffer Management**: More sophisticated buffer handling
5. **Reduced Session Service Complexity**: Session service has fewer responsibilities
6. **Consistent Manager Pattern**: Follows the same pattern as other managers

## Implementation Strategy

1. Create the AudioManager class in `src/services/session/AudioManager.ts`
2. Update the ExtendedUserSession interface to include the AudioManager
3. Modify session.service.ts to create and use the AudioManager
4. Update session cleanup to properly dispose of the AudioManager
5. Test the implementation thoroughly alongside the existing code

## Error Handling

The AudioManager implements comprehensive error handling:

1. **Method-level try/catch blocks**: Every public method has its own try/catch
2. **Component-specific error handling**: Errors are handled differently for different components
3. **LC3 service recovery**: Automatic reinitializing of LC3 service on failure
4. **Graceful degradation**: Continue processing when possible, return undefined when not
5. **Buffer integrity**: Ensure buffer state is consistent even after errors

## Additional Features

The AudioManager includes enhanced functionality beyond what's currently in the session service:

1. **Ordered Buffer Processing**: More sophisticated handling of sequenced audio
2. **Configurable Processing Interval**: Adjustable buffer processing rate
3. **Improved Debugging**: Better logging and diagnostic information
4. **Buffer Monitoring**: Ability to monitor buffer state
5. **Enhanced Cleanup**: More thorough resource cleanup during disposal

## Consistency with Other Managers

The AudioManager follows the same patterns as other managers:

1. **Constructor pattern**: Takes userSession and initializes with it
2. **Logging approach**: Creates child logger with component name
3. **Method naming**: Consistent method names (processX, relayX, getX)
4. **Disposal pattern**: Implements dispose() method for cleanup
5. **Error handling**: Consistent error handling approach

By implementing the AudioManager, we further enhance the modularity and maintainability of the session service while providing more robust audio processing capabilities.