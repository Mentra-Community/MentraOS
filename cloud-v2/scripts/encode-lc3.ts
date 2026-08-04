#!/usr/bin/env bun
/**
 * One-shot: PCM (16kHz s16 mono) → LC3 frames, via v1's lc3.service.
 *
 * Usage:
 *   bun scripts/encode-lc3.ts <input.pcm> <output.lc3> [frameBytes=20]
 *
 * Output is a stream of LC3 frames concatenated, no header. Read frame-by-
 * frame at the configured `frameBytes` size to recover individual frames.
 */

const [inputPath, outputPath, frameBytesArg] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  console.error("usage: bun encode-lc3.ts <input.pcm> <output.lc3> [frameBytes=20]");
  process.exit(2);
}
const frameBytes = Number.parseInt(frameBytesArg ?? "20", 10);

// Import v1's LC3 service. It exposes encodePCMChunk which handles all the
// WASM lifecycle.
// @ts-expect-error — reaching across repo boundaries
const { LC3Service } = await import("../../cloud/packages/cloud/src/services/lc3/lc3.service.ts");

const pcmBytes = await Bun.file(inputPath).arrayBuffer();
console.log(`[encode-lc3] input: ${pcmBytes.byteLength} bytes (${(pcmBytes.byteLength / 32000).toFixed(2)}s of audio)`);

const svc = new LC3Service("encode-lc3-tool", frameBytes);
await svc.initialize();

const lc3 = await svc.encodePCMChunk(pcmBytes);
if (!lc3) {
  console.error("[encode-lc3] encode returned null");
  process.exit(1);
}

await Bun.write(outputPath, lc3);
console.log(`[encode-lc3] output: ${(lc3 as ArrayBuffer).byteLength} bytes (${frameBytes}-byte frames; ${(lc3 as ArrayBuffer).byteLength / frameBytes} frames)`);
