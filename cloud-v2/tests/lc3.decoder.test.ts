/**
 * @fileoverview LC3Decoder unit tests.
 *
 * Direct exercise of the WASM-backed decoder without any of the audio
 * pipeline machinery. Verifies frame-count math, output buffer sizing,
 * and graceful handling of garbage input.
 *
 * No external deps — these run without Mongo or Redis.
 */

import { describe, expect, test } from "bun:test";
import { LC3Decoder } from "../packages/runtime/src/services/audio/workers/lc3";

describe("LC3Decoder", () => {
  test("20-byte frame decodes to 160 samples (320 bytes PCM)", async () => {
    const decoder = await LC3Decoder.create(20);
    const oneFrame = new Uint8Array(20).fill(0x42);
    const pcm = decoder.decode(oneFrame);
    expect(pcm).not.toBeNull();
    expect(pcm!.length).toBe(160); // 160 Int16 samples (10ms at 16kHz)
    expect(pcm!.byteLength).toBe(320);
  });

  test("multi-frame payload returns concatenated PCM", async () => {
    const decoder = await LC3Decoder.create(20);
    const threeFrames = new Uint8Array(60).fill(0x99);
    const pcm = decoder.decode(threeFrames);
    expect(pcm).not.toBeNull();
    expect(pcm!.length).toBe(160 * 3);
    expect(pcm!.byteLength).toBe(320 * 3);
  });

  test("partial trailing data is silently truncated to whole frames", async () => {
    const decoder = await LC3Decoder.create(20);
    // 50 bytes = 2 whole frames + 10 leftover.
    const sloppy = new Uint8Array(50).fill(0x33);
    const pcm = decoder.decode(sloppy);
    expect(pcm).not.toBeNull();
    expect(pcm!.length).toBe(160 * 2);
  });

  test("empty input returns null", async () => {
    const decoder = await LC3Decoder.create(20);
    expect(decoder.decode(new Uint8Array(0))).toBeNull();
  });

  test("input smaller than one frame returns null", async () => {
    const decoder = await LC3Decoder.create(20);
    expect(decoder.decode(new Uint8Array(10))).toBeNull();
  });

  test("rejects unsupported frame sizes", async () => {
    await expect(LC3Decoder.create(15)).rejects.toThrow(/frameBytes/);
    await expect(LC3Decoder.create(100)).rejects.toThrow(/frameBytes/);
  });

  test("40-byte frames (32kbps) work", async () => {
    const decoder = await LC3Decoder.create(40);
    const pcm = decoder.decode(new Uint8Array(40).fill(0xaa));
    expect(pcm).not.toBeNull();
    expect(pcm!.length).toBe(160);
  });

  test("60-byte frames (48kbps) work", async () => {
    const decoder = await LC3Decoder.create(60);
    const pcm = decoder.decode(new Uint8Array(60).fill(0xbb));
    expect(pcm).not.toBeNull();
    expect(pcm!.length).toBe(160);
  });

  test("instances are independent (separate WASM state, same compiled module)", async () => {
    const [a, b] = await Promise.all([
      LC3Decoder.create(20),
      LC3Decoder.create(40),
    ]);
    expect(a.frameBytes).toBe(20);
    expect(b.frameBytes).toBe(40);
    expect(a.decode(new Uint8Array(20))).not.toBeNull();
    expect(b.decode(new Uint8Array(40))).not.toBeNull();
  });
});
