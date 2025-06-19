// augmentos_cloud/packages/utils/src/LC3Service.ts

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger';

/**
 * LC3 decoder/encoder instance with Int16 samples (from working implementation)
 */
interface LC3Instance {
  samples: Int16Array;
  frame: Uint8Array;
  decode(frameBytes: number): void;
  encode(frameBytes: number): void;
  lastUsed: number;
}

/**
 * LC3 audio service that handles encoding and decoding of LC3 audio frames
 */
export class LC3Service {
  private instance: WebAssembly.Instance | null = null;
  private codec: LC3Instance | null = null;
  private initialized = false;
  private sessionId: string;

  // LC3 parameters
  private readonly frameDurationUs = 10000; // 10ms per frame
  private readonly sampleRateHz = 16000;    // 16kHz
  private readonly frameBytes = 20;         // Default, can be overridden
  
  // Memory management
  private frameSamples = 0;
  private codecSize = 0;
  private allocationSize = 0;
  private lc3Module: LC3Module | null = null;
  
  // Sequence tracking for continuity detection
  private lastProcessedSequence: number = -1;
  private sequenceDiscontinuities: number = 0;
  private lastDecodeTimestamp: number = 0;

  // Static WASM module caching
  private static wasmModule: WebAssembly.Module | null = null;
  private static instanceCounter = 0;

  /**
   * Create a new LC3Service instance
   * @param sessionId Optional session ID for the user
   * @param frameBytes Optional frame size in bytes (determines bitrate)
   */
  constructor(sessionId: string = `session_${Date.now()}_${LC3Service.instanceCounter++}`) {
    this.sessionId = sessionId;
    // if (frameBytes) {
    //   this.frameBytes = frameBytes;
    // }
    logger.info(`Creating new LC3Service instance for session: ${this.sessionId}`);
  }

  /**
   * Initialize the LC3 codec
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    
    try {
      // Load WASM module (shared across instances)
      if (!LC3Service.wasmModule) {
        const wasmPath = path.resolve(__dirname, 'liblc3.wasm');
        logger.info(`Loading WASM from: ${wasmPath}`);
        const wasmBuffer = fs.readFileSync(wasmPath);
        LC3Service.wasmModule = await WebAssembly.compile(new Uint8Array(wasmBuffer));
        logger.info('✅ LC3 WASM module compiled successfully');
      }
      
      // Create a new instance from the shared module
      const wasmInstance = await WebAssembly.instantiate(LC3Service.wasmModule, {});
      this.instance = wasmInstance;
      
      // Initialize LC3Module helper
      this.lc3Module = new LC3Module(wasmInstance, this.frameDurationUs, this.sampleRateHz);
      this.frameSamples = this.lc3Module.getFrameSamples();
      
      // Create the codec instance
      this.codec = this.lc3Module.create();
      this.initialized = true;
      logger.info(`✅ LC3 Service initialized for session: ${this.sessionId}, frame samples: ${this.frameSamples}`);
    } catch (error) {
      logger.error(`❌ Failed to initialize LC3 Service for session ${this.sessionId}:`, error);
      throw error;
    }
  }

  /**
   * Encode PCM audio to LC3 format
   * @param pcmData 16-bit PCM audio data
   * @param sequenceNumber Optional sequence number for tracking chunk order
   * @returns LC3 encoded audio data or null on error
   */
  async encodePCMChunk(pcmData: ArrayBufferLike, sequenceNumber?: number): Promise<ArrayBuffer | null> {
    if (!this.initialized || !this.codec) {
      await this.initialize();
      
      if (!this.codec) {
        logger.error(`Failed to initialize codec for session ${this.sessionId}`);
        return null;
      }
    }
    
    try {
      // Basic input validation
      if (!pcmData || pcmData.byteLength === 0) {
        return null;
      }
      
      // Track sequence continuity if provided (similar to decoding)
      if (sequenceNumber !== undefined) {
        const expectedSequence = this.lastProcessedSequence + 1;
        
        // If this isn't the first chunk and sequence doesn't match expected
        if (this.lastProcessedSequence !== -1 && sequenceNumber !== expectedSequence) {
          this.sequenceDiscontinuities++;
          logger.warn(`Session ${this.sessionId}: LC3 encoder sequence discontinuity - expected ${expectedSequence}, got ${sequenceNumber}. Total discontinuities: ${this.sequenceDiscontinuities}`);
        }
        
        this.lastProcessedSequence = sequenceNumber;
      }
      
      // Convert ArrayBufferLike to a proper ArrayBuffer for safety
      const actualArrayBuffer = (pcmData instanceof ArrayBuffer) 
        ? pcmData 
        : pcmData.slice(0, pcmData.byteLength);
      
      // Calculate frames based on PCM data length
      const bytesPerSample = 2; // 16-bit PCM
      const bytesPerFrame = this.frameSamples * bytesPerSample;
      const numFrames = Math.floor(actualArrayBuffer.byteLength / bytesPerFrame);
      
      if (numFrames === 0) {
        logger.warn(`Session ${this.sessionId}: PCM data too short for even one frame`);
        return null;
      }
      
      // Create output buffer for encoded LC3 data
      const outputBuffer = new ArrayBuffer(numFrames * this.frameBytes);
      const outputView = new Uint8Array(outputBuffer);
      const inputData = new Int16Array(actualArrayBuffer);
      
      // Encode each frame
      for (let i = 0; i < numFrames; i++) {
        try {
          const frameOffset = i * this.frameSamples;
          
          // Copy PCM data to codec buffer
          this.codec.samples.set(
            inputData.subarray(frameOffset, frameOffset + this.frameSamples)
          );
          
          // Encode the frame
          this.codec.encode(this.frameBytes);
          
          // Copy encoded data to output buffer
          outputView.set(
            this.codec.frame.subarray(0, this.frameBytes),
            i * this.frameBytes
          );
        } catch (frameError) {
          logger.warn(`Session ${this.sessionId}: Error encoding frame ${i}: ${frameError}`);
          // Fill with zeros for this frame
          outputView.fill(0, i * this.frameBytes, (i + 1) * this.frameBytes);
        }
      }
      
      // Update last used timestamp
      this.codec.lastUsed = Date.now();
      
      return outputBuffer;
    } catch (error) {
      logger.error(`❌ Session ${this.sessionId}: Error encoding PCM audio:`, error);
      return null;
    }
  }

  /**
   * Decode LC3 audio to PCM format
   * @param audioData The LC3 encoded audio data
   * @param sequenceNumber Optional sequence number for tracking chunk order
   * @returns Decoded PCM audio data or null on error
   */
  async decodeAudioChunk(audioData: ArrayBufferLike, sequenceNumber?: number): Promise<ArrayBuffer | null> {
    if (!this.initialized || !this.codec) {
      await this.initialize();
      
      if (!this.codec) {
        logger.error(`Failed to initialize codec for session ${this.sessionId}`);
        return null;
      }
    }
    
    try {
      // Basic input validation
      if (!audioData || audioData.byteLength === 0) {
        return null;
      }
      
      // Track sequence continuity if provided
      if (sequenceNumber !== undefined) {
        const expectedSequence = this.lastProcessedSequence + 1;
        
        // If this isn't the first chunk and sequence doesn't match expected
        if (this.lastProcessedSequence !== -1 && sequenceNumber !== expectedSequence) {
          this.sequenceDiscontinuities++;
          // logger.warn(`Session ${this.sessionId}: LC3 decoder sequence discontinuity - expected ${expectedSequence}, got ${sequenceNumber}. Total discontinuities: ${this.sequenceDiscontinuities}`);
        }
        
        this.lastProcessedSequence = sequenceNumber;
      }
      
      // Track timing between chunks for diagnostics
      const now = Date.now();
      if (this.lastDecodeTimestamp > 0) {
        const timeSinceLastChunk = now - this.lastDecodeTimestamp;
        if (timeSinceLastChunk > 100) { // Log only significant gaps (>100ms)
          // logger.debug(`Session ${this.sessionId}: LC3 decoding gap of ${timeSinceLastChunk}ms between chunks`);
        }
      }
      this.lastDecodeTimestamp = now;
      
      // Process frames
      // Convert ArrayBufferLike to a proper ArrayBuffer for safety
      const actualArrayBuffer = (audioData instanceof ArrayBuffer) 
        ? audioData 
        : audioData.slice(0, audioData.byteLength);
      
      const numFrames = Math.floor(actualArrayBuffer.byteLength / this.frameBytes);
      const totalSamples = numFrames * this.frameSamples;
      const outputBuffer = new ArrayBuffer(totalSamples * 2); // 16-bit PCM
      const outputView = new Int16Array(outputBuffer);
      const inputData = new Uint8Array(actualArrayBuffer);
      
      // Process each frame
      for (let i = 0; i < numFrames; i++) {
        try {
          // Copy frame data
          this.codec.frame.set(
            inputData.subarray(i * this.frameBytes, (i + 1) * this.frameBytes)
          );
          
          // Decode frame
          this.codec.decode(this.frameBytes);
          
          // Copy decoded samples directly (already in Int16 format)
          outputView.set(this.codec.samples, i * this.frameSamples);
        } catch (frameError) {
          // Error handling
          logger.warn(`Session ${this.sessionId}: Error decoding frame ${i}: ${frameError}`);
          // Fill with silence for this frame
          outputView.fill(0, i * this.frameSamples, (i + 1) * this.frameSamples);
        }
      }
      
      // Update last used timestamp
      this.codec.lastUsed = Date.now();
      
      return outputBuffer;
    } catch (error) {
      logger.error(`❌ Session ${this.sessionId}: Error decoding LC3 audio:`, error);
      return null;
    }
  }

  /**
   * Get audio bitrate based on frame size
   */
  getBitrate(): number {
    return Math.floor(this.frameBytes * 8 * (1000000 / this.frameDurationUs));
  }

  /**
   * Create a WAV header for a PCM buffer
   */
  createWAVHeader(sampleCount: number): ArrayBuffer {
    const headerSize = 44;
    const dataSize = sampleCount * 2; // 16-bit samples
    const buffer = new ArrayBuffer(headerSize);
    const view = new DataView(buffer);
    
    // RIFF chunk
    view.setUint8(0, 'R'.charCodeAt(0));
    view.setUint8(1, 'I'.charCodeAt(0));
    view.setUint8(2, 'F'.charCodeAt(0));
    view.setUint8(3, 'F'.charCodeAt(0));
    view.setUint32(4, 36 + dataSize, true);
    view.setUint8(8, 'W'.charCodeAt(0));
    view.setUint8(9, 'A'.charCodeAt(0));
    view.setUint8(10, 'V'.charCodeAt(0));
    view.setUint8(11, 'E'.charCodeAt(0));
    
    // fmt chunk
    view.setUint8(12, 'f'.charCodeAt(0));
    view.setUint8(13, 'm'.charCodeAt(0));
    view.setUint8(14, 't'.charCodeAt(0));
    view.setUint8(15, ' '.charCodeAt(0));
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM format
    view.setUint16(22, 1, true); // Mono
    view.setUint32(24, this.sampleRateHz, true);
    view.setUint32(28, this.sampleRateHz * 2, true);
    view.setUint16(32, 2, true); // Block align
    view.setUint16(34, 16, true); // Bits per sample
    
    // data chunk
    view.setUint8(36, 'd'.charCodeAt(0));
    view.setUint8(37, 'a'.charCodeAt(0));
    view.setUint8(38, 't'.charCodeAt(0));
    view.setUint8(39, 'a'.charCodeAt(0));
    view.setUint32(40, dataSize, true);
    
    return buffer;
  }

  /**
   * Convert PCM data to a WAV file
   */
  pcmToWAV(pcmData: ArrayBuffer): ArrayBuffer {
    const samples = pcmData.byteLength / 2; // 16-bit samples
    const header = this.createWAVHeader(samples);
    
    // Combine header and PCM data
    const wavBuffer = new ArrayBuffer(header.byteLength + pcmData.byteLength);
    const wavView = new Uint8Array(wavBuffer);
    wavView.set(new Uint8Array(header), 0);
    wavView.set(new Uint8Array(pcmData), header.byteLength);
    
    return wavBuffer;
  }

  /**
   * Get information about this codec instance
   */
  getInfo(): object {
    return {
      sessionId: this.sessionId,
      initialized: this.initialized,
      frameDurationUs: this.frameDurationUs,
      sampleRateHz: this.sampleRateHz,
      frameBytes: this.frameBytes,
      frameSamples: this.frameSamples,
      bitrate: this.getBitrate(),
      lastUsed: this.codec?.lastUsed || 0,
      // Sequence tracking info
      lastProcessedSequence: this.lastProcessedSequence,
      sequenceDiscontinuities: this.sequenceDiscontinuities,
      lastDecodeTimestamp: this.lastDecodeTimestamp,
      // Time since last audio
      timeSinceLastAudio: this.lastDecodeTimestamp ? (Date.now() - this.lastDecodeTimestamp) : -1
    };
  }

  /**
   * Clean up resources
   */
  cleanup(): void {
    try {
      if (this.codec) {
        // Clear references to WASM memory
        this.codec.samples = new Int16Array(0);
        this.codec.frame = new Uint8Array(0);
      }
    } catch (error) {
      logger.error(`Error during LC3Service cleanup for session ${this.sessionId}:`, error);
    } finally {
      this.initialized = false;
      this.instance = null;
      this.codec = null;
    }
  }
}

/**
 * Helper class for managing LC3 module and memory
 */
class LC3Module {
  private instance: WebAssembly.Instance;
  private frameDurationUs: number;
  private sampleRateHz: number;
  private frameSamples: number;
  private decoderSize: number;
  private encoderSize: number;
  private allocationSize: number;

  constructor(instance: WebAssembly.Instance, frameDurationUs: number, sampleRateHz: number) {
    this.instance = instance;
    this.frameDurationUs = frameDurationUs;
    this.sampleRateHz = sampleRateHz;

    // Calculate sizes
    this.frameSamples = (this.instance.exports.lc3_frame_samples as Function)(
      frameDurationUs,
      sampleRateHz
    );

    this.decoderSize = (this.instance.exports.lc3_decoder_size as Function)(
      frameDurationUs,
      sampleRateHz
    );
    
    this.encoderSize = (this.instance.exports.lc3_encoder_size as Function)(
      frameDurationUs,
      sampleRateHz
    );

    // Calculate total memory needed: encoder + decoder + samples + frame buffer
    this.allocationSize = this.encoderSize + 
                          this.decoderSize + 
                          (this.frameSamples * 2) + // Int16 samples (2 bytes each)
                          1024;                      // Max frame buffer size (generous)
    
    // Align to 4 bytes
    this.allocationSize = Math.ceil(this.allocationSize / 4) * 4;
  }

  create(): LC3Instance {
    const memory = this.instance.exports.memory as WebAssembly.Memory;
    const basePtr = memory.buffer.byteLength;
    
    // Ensure we have enough memory
    const pagesNeeded = Math.ceil((basePtr + this.allocationSize) / (64 * 1024));
    const currentPages = memory.buffer.byteLength / (64 * 1024);
    
    if (pagesNeeded > currentPages) {
      memory.grow(pagesNeeded - currentPages);
    }

    // Layout memory regions
    const decoderPtr = basePtr;
    const encoderPtr = decoderPtr + this.decoderSize;
    const samplePtr = encoderPtr + this.encoderSize;
    const framePtr = samplePtr + (this.frameSamples * 2); // Int16 = 2 bytes per sample

    // Initialize decoder - using 0 for third param to match working implementation
    (this.instance.exports.lc3_setup_decoder as Function)(
      this.frameDurationUs,
      this.sampleRateHz,
      0,  // PCM format for output (S16)
      decoderPtr
    );

    // Initialize encoder
    (this.instance.exports.lc3_setup_encoder as Function)(
      this.frameDurationUs,
      this.sampleRateHz,
      0,  // PCM format for input (S16)
      encoderPtr
    );

    const instance: LC3Instance = {
      samples: new Int16Array(memory.buffer, samplePtr, this.frameSamples),
      frame: new Uint8Array(memory.buffer, framePtr, 1024),
      decode: (frameBytes: number) => {
        (this.instance.exports.lc3_decode as Function)(
          decoderPtr,
          framePtr,
          frameBytes,
          0,  // S16 format (0) instead of Float (3)
          samplePtr,
          1   // Stride
        );
      },
      encode: (frameBytes: number) => {
        (this.instance.exports.lc3_encode as Function)(
          encoderPtr,
          0,  // S16 format (0)
          samplePtr,
          1,  // Stride
          frameBytes,
          framePtr
        );
      },
      lastUsed: Date.now()
    };

    return instance;
  }

  getFrameSamples(): number {
    return this.frameSamples;
  }
}

/**
 * Factory function to create a new LC3Service instance
 */
export function createLC3Service(sessionId?: string, frameBytes?: number): LC3Service {
  return new LC3Service(sessionId);
}

export default LC3Service;