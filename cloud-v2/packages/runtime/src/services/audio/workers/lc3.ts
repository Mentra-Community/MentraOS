/**
 * @fileoverview LC3 audio decoder, per-user instance.
 *
 * Wraps the WASM-compiled liblc3 reference codec (Bluetooth SIG) for use in
 * audio workers. Ported from v1 cloud's `lc3.service.ts`, narrowed to
 * decode-only (cloud-v2 doesn't re-encode audio for the glasses path).
 *
 * Fixed parameters:
 *   - Frame duration: 10ms
 *   - Sample rate: 16kHz
 *   - Frame samples: 160 per decoded frame (lc3_frame_samples query)
 *   - Output: Int16 mono PCM
 *
 * Per-instance LC3 decoder state — one instance per user (per worker).
 * The compiled WASM module is shared across instances within a process via
 * a module-level cache.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const FRAME_DURATION_US = 10_000;
const SAMPLE_RATE_HZ = 16_000;
const FRAME_BUFFER_BYTES = 1024; // generous upper bound — real frames are ≤60B
const PCM_FORMAT_S16 = 0; // liblc3 PCM format code for signed 16-bit

/** Supported LC3 frame sizes in bytes. Each maps to a bitrate at 16kHz/10ms. */
export const SUPPORTED_FRAME_BYTES = new Set([20, 40, 60]);

interface Lc3Exports {
  memory: WebAssembly.Memory;
  lc3_frame_samples(durationUs: number, sampleRate: number): number;
  lc3_decoder_size(durationUs: number, sampleRate: number): number;
  lc3_setup_decoder(
    durationUs: number,
    sampleRate: number,
    srPcm: number,
    decoderPtr: number,
  ): void;
  lc3_decode(
    decoderPtr: number,
    framePtr: number,
    frameBytes: number,
    format: number,
    samplePtr: number,
    stride: number,
  ): number;
}

/** WASM module compiled once per process, shared across decoder instances. */
let cachedWasmModule: WebAssembly.Module | null = null;

async function getWasmModule(): Promise<WebAssembly.Module> {
  if (cachedWasmModule) return cachedWasmModule;
  const wasmPath = join(import.meta.dir, "liblc3.wasm");
  const wasmBytes = readFileSync(wasmPath);
  cachedWasmModule = await WebAssembly.compile(new Uint8Array(wasmBytes));
  return cachedWasmModule;
}

export class LC3Decoder {
  private exports!: Lc3Exports;
  private decoderPtr = 0;
  private samplePtr = 0;
  private framePtr = 0;
  private frameSamples = 0;
  private framesView!: Uint8Array;
  private samplesView!: Int16Array;

  private constructor(public readonly frameBytes: number) {
    if (!SUPPORTED_FRAME_BYTES.has(frameBytes)) {
      throw new Error(
        `LC3Decoder: unsupported frameBytes ${frameBytes} (must be 20, 40, or 60)`,
      );
    }
  }

  /**
   * Create + initialize a decoder. Async because WASM compile/instantiate
   * is async. Default `frameBytes` = 20 (16kbps) matches v1's default.
   */
  static async create(frameBytes = 20): Promise<LC3Decoder> {
    const d = new LC3Decoder(frameBytes);
    await d.init();
    return d;
  }

  private async init(): Promise<void> {
    const wasmModule = await getWasmModule();
    const instance = await WebAssembly.instantiate(wasmModule, {});
    this.exports = instance.exports as unknown as Lc3Exports;

    this.frameSamples = this.exports.lc3_frame_samples(
      FRAME_DURATION_US,
      SAMPLE_RATE_HZ,
    );
    const decoderSize = this.exports.lc3_decoder_size(
      FRAME_DURATION_US,
      SAMPLE_RATE_HZ,
    );

    // Layout in WASM memory: [decoder_state | sample_buffer | frame_buffer].
    const memory = this.exports.memory;
    const basePtr = memory.buffer.byteLength;
    const allocSize =
      decoderSize + this.frameSamples * 2 + FRAME_BUFFER_BYTES;

    const pagesNeeded = Math.ceil((basePtr + allocSize) / (64 * 1024));
    const currentPages = memory.buffer.byteLength / (64 * 1024);
    if (pagesNeeded > currentPages) {
      memory.grow(pagesNeeded - currentPages);
    }

    this.decoderPtr = basePtr;
    this.samplePtr = this.decoderPtr + decoderSize;
    this.framePtr = this.samplePtr + this.frameSamples * 2;

    this.exports.lc3_setup_decoder(
      FRAME_DURATION_US,
      SAMPLE_RATE_HZ,
      PCM_FORMAT_S16,
      this.decoderPtr,
    );

    // Persistent views into WASM memory — these point at our allocated
    // regions so we can read/write samples and frames without re-slicing.
    this.framesView = new Uint8Array(
      memory.buffer,
      this.framePtr,
      FRAME_BUFFER_BYTES,
    );
    this.samplesView = new Int16Array(
      memory.buffer,
      this.samplePtr,
      this.frameSamples,
    );
  }

  /**
   * Decode an LC3 payload containing one or more whole frames. Returns null
   * if the input is empty or smaller than one frame. Bad frames within a
   * multi-frame payload yield silence for that frame; we never throw.
   */
  decode(lc3Bytes: Uint8Array): Int16Array | null {
    if (lc3Bytes.byteLength === 0) return null;

    const numFrames = Math.floor(lc3Bytes.byteLength / this.frameBytes);
    if (numFrames === 0) return null;

    const out = new Int16Array(numFrames * this.frameSamples);

    for (let i = 0; i < numFrames; i++) {
      try {
        this.framesView.set(
          lc3Bytes.subarray(i * this.frameBytes, (i + 1) * this.frameBytes),
        );
        this.exports.lc3_decode(
          this.decoderPtr,
          this.framePtr,
          this.frameBytes,
          PCM_FORMAT_S16,
          this.samplePtr,
          1, // stride
        );
        out.set(this.samplesView, i * this.frameSamples);
      } catch {
        // Per-frame failure → silence. Continue with the next frame.
        out.fill(0, i * this.frameSamples, (i + 1) * this.frameSamples);
      }
    }

    return out;
  }

  /** Samples produced per frame (160 at 10ms / 16kHz). */
  get samplesPerFrame(): number {
    return this.frameSamples;
  }
}
