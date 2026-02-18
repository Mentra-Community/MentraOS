// cloud/packages/utils/src/LC3Service.ts

import * as fs from "fs";
import * as path from "path";
import { logger } from "../logging/pino-logger";

/**
 * LC3 decoder instance
 */
interface LC3Instance {
  samples: Float32Array;
  frame: Uint8Array;
  decode(): void;
  lastUsed: number;
}

/**
 * LC3 audio decoder service that handles decoding of LC3 audio frames
 */
export class LC3Service {
  private instance: WebAssembly.Instance | null = null;
  private decoder: LC3Instance | null = null;
  private initialized = false;
  private sessionId: string;

  // LC3 decoding parameters
  private readonly frameDurationUs = 10000; // 10ms per frame
  private readonly sampleRateHz = 16000; // 16kHz
  private readonly frameBytes = 20; // Fixed for our case

  // Memory management
  private frameSamples = 0;
  private decoderSize = 0;
  private allocationSize = 0;

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
   */
  constructor(
    sessionId: string = `session_${Date.now()}_${LC3Service.instanceCounter++}`,
  ) {
    this.sessionId = sessionId;
    logger.info(
      `Creating new LC3Service instance for session: ${this.sessionId}`,
    );
  }

  /**
   * Initialize the LC3 decoder
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      // Load WASM module (shared across instances)
      if (!LC3Service.wasmModule) {
        const wasmPath = path.resolve(__dirname, "liblc3.wasm");
        logger.info(`Loading WASM from: ${wasmPath}`);
        const wasmBuffer = fs.readFileSync(wasmPath);
        LC3Service.wasmModule = await WebAssembly.compile(
          new Uint8Array(wasmBuffer),
        );
        logger.info("✅ LC3 WASM module compiled successfully");
      }

      // Create a new instance from the shared module
      const wasmInstance = await WebAssembly.instantiate(
        LC3Service.wasmModule,
        {},
      );
      this.instance = wasmInstance;

      // Calculate frame samples
      this.frameSamples = (wasmInstance.exports as any).lc3_frame_samples(
        this.frameDurationUs,
        this.sampleRateHz,
      );

      // Calculate decoder size
      this.decoderSize = (wasmInstance.exports as any).lc3_decoder_size(
        this.frameDurationUs,
        this.sampleRateHz,
      );

      // Calculate allocation size - EXACTLY as in the real working script
      this.allocationSize =
        this.decoderSize +
        this.frameSamples * 4 + // Float32 samples
        this.frameBytes; // frame buffer

      // Align to 4 bytes - EXACTLY as in the real working script
      this.allocationSize = Math.ceil(this.allocationSize / 4) * 4;

      // Create the decoder instance
      this.decoder = this.createDecoderInstance();
      this.initialized = true;
      logger.info(`✅ LC3 Service initialized for session: ${this.sessionId}`);
    } catch (error) {
      logger.error(
        error,
        `❌ Failed to initialize LC3 Service for session ${this.sessionId}:`,
      );
      throw error;
    }
  }

  /**
   * Create a new LC3 decoder instance
   */
  private createDecoderInstance(): LC3Instance {
    if (!this.instance) throw new Error("LC3 not initialized");

    // Get memory and current size - EXACTLY as in the real working script
    const memory = this.instance.exports.memory as WebAssembly.Memory;
    const basePtr = memory.buffer.byteLength;

    // Grow memory if needed - EXACTLY as in the real working script
    const pagesNeeded = Math.ceil(
      (basePtr + this.allocationSize) / (64 * 1024),
    );
    const currentPages = memory.buffer.byteLength / (64 * 1024);

    if (pagesNeeded > currentPages) {
      memory.grow(pagesNeeded - currentPages);
    }

    // Memory layout - EXACTLY as in the real working script
    const decoderPtr = basePtr;
    const samplePtr = decoderPtr + this.decoderSize;
    const framePtr = samplePtr + this.frameSamples * 4;

    // Initialize decoder - EXACTLY as in the real working script
    (this.instance.exports as any).lc3_setup_decoder(
      this.frameDurationUs,
      this.sampleRateHz,
      this.sampleRateHz,
      decoderPtr,
    );

    // Return instance - EXACTLY as in the real working script, adding only lastUsed
    return {
      samples: new Float32Array(memory.buffer, samplePtr, this.frameSamples),
      frame: new Uint8Array(memory.buffer, framePtr, this.frameBytes),
      decode: () => {
        if (!this.instance) throw new Error("LC3 not initialized");
        // EXACTLY as in the real working script
        (this.instance.exports as any).lc3_decode(
          decoderPtr,
          framePtr,
          this.frameBytes,
          3, // Using float format (3) as in the real working script
          samplePtr,
          1,
        );
      },
      lastUsed: Date.now(),
    };
  }

  /**
   * Decode a chunk of LC3 audio data
   * @param audioData The LC3 encoded audio data
   * @param sequenceNumber Optional sequence number for tracking chunk order
   * @returns Decoded PCM audio data or null on error
   */
  async decodeAudioChunk(
    audioData: ArrayBufferLike,
    sequenceNumber?: number,
  ): Promise<ArrayBuffer | null> {
    if (!this.initialized || !this.decoder) {
      await this.initialize();

      if (!this.decoder) {
        logger.error(
          `Failed to initialize decoder for session ${this.sessionId}`,
        );
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
        if (
          this.lastProcessedSequence !== -1 &&
          sequenceNumber !== expectedSequence
        ) {
          this.sequenceDiscontinuities++;
          logger.warn(
            `Session ${this.sessionId}: LC3 decoder sequence discontinuity - expected ${expectedSequence}, got ${sequenceNumber}. Total discontinuities: ${this.sequenceDiscontinuities}`,
          );
        }

        this.lastProcessedSequence = sequenceNumber;
      }

      // Track timing between chunks for diagnostics
      const now = Date.now();
      if (this.lastDecodeTimestamp > 0) {
        const timeSinceLastChunk = now - this.lastDecodeTimestamp;
        if (timeSinceLastChunk > 100) {
          // Log only significant gaps (>100ms)
          logger.debug(
            `Session ${this.sessionId}: LC3 decoding gap of ${timeSinceLastChunk}ms between chunks`,
          );
        }
      }
      this.lastDecodeTimestamp = now;

      // Process frames
      // Convert ArrayBufferLike to a proper ArrayBuffer for safety
      const actualArrayBuffer =
        audioData instanceof ArrayBuffer
          ? audioData
          : audioData.slice(0, audioData.byteLength);

      const numFrames = Math.floor(
        actualArrayBuffer.byteLength / this.frameBytes,
      );
      const totalSamples = numFrames * this.frameSamples;
      const outputBuffer = new ArrayBuffer(totalSamples * 2); // 16-bit PCM
      const outputView = new DataView(outputBuffer);
      const inputData = new Uint8Array(actualArrayBuffer);
      let outputOffset = 0;

      // Process each frame
      for (let i = 0; i < numFrames; i++) {
        try {
          // Copy frame data
          this.decoder.frame.set(
            inputData.subarray(i * this.frameBytes, (i + 1) * this.frameBytes),
          );

          // Decode frame
          this.decoder.decode();

          // Convert samples to PCM
          for (let j = 0; j < this.frameSamples; j++) {
            const pcmValue = Math.max(
              -32768,
              Math.min(32767, Math.floor(this.decoder.samples[j] * 32768)),
            );
            outputView.setInt16(outputOffset, pcmValue, true);
            outputOffset += 2;
          }
        } catch (frameError) {
          // Error handling for frame-level errors
          logger.warn(
            `Session ${this.sessionId}: Error decoding frame ${i}: ${frameError}`,
          );
          // Fill with silence for the errored frame
          for (let j = 0; j < this.frameSamples; j++) {
            outputView.setInt16(outputOffset, 0, true);
            outputOffset += 2;
          }
        }
      }

      // Update last used timestamp
      this.decoder.lastUsed = Date.now();

      return outputBuffer;
    } catch (error) {
      logger.error(
        error,
        `❌ Session ${this.sessionId}: Error decoding LC3 audio:`,
      );
      return null;
    }
  }

  /**
   * Get information about this decoder instance
   */
  getInfo(): object {
    return {
      sessionId: this.sessionId,
      initialized: this.initialized,
      frameDurationUs: this.frameDurationUs,
      sampleRateHz: this.sampleRateHz,
      frameBytes: this.frameBytes,
      frameSamples: this.frameSamples,
      decoderSize: this.decoderSize,
      allocationSize: this.allocationSize,
      lastUsed: this.decoder?.lastUsed || 0,
      // Sequence tracking info
      lastProcessedSequence: this.lastProcessedSequence,
      sequenceDiscontinuities: this.sequenceDiscontinuities,
      lastDecodeTimestamp: this.lastDecodeTimestamp,
    };
  }

  /**
   * Clean up resources
   */
  cleanup(): void {
    try {
      if (this.decoder) {
        this.decoder.samples = new Float32Array(0);
        this.decoder.frame = new Uint8Array(0);
      }
    } catch (error) {
      logger.error(
        error,
        `Error during LC3Service cleanup for session ${this.sessionId}:`,
      );
    } finally {
      this.initialized = false;
      this.instance = null;
      this.decoder = null;
    }
  }
}

/**
 * Factory function to create a new LC3Service instance
 */
export function createLC3Service(sessionId?: string): LC3Service {
  return new LC3Service(sessionId);
}

export default LC3Service;
