/**
 * Soniox transcription bug reproduction harness.
 *
 * Feeds a pre-recorded WAV file (16kHz mono PCM) into the actual
 * SonioxSdkStream and captures all interim/FINAL events. Used to reproduce
 * the "endpoint fires mid-utterance, producing split FINALs" bug seen in
 * staging and prod logs.
 *
 * Usage:
 *   SONIOX_API_KEY=... bun run src/scripts/soniox-repro.ts <path-to-wav>
 *
 * Expected bug pattern:
 *   - Multiple FINAL events close together for what is one logical utterance
 *   - Some FINALs ending mid-word (e.g., "I'")
 *
 * Exit code 0 if no bug detected, 1 if bug pattern observed.
 */

import * as fs from "fs";
import * as path from "path";
import pino from "pino";
import { SonioxNodeClient } from "@soniox/node";

import { SonioxSdkStream } from "../services/session/transcription/providers/SonioxSdkStream";
import type { StreamCallbacks } from "../services/session/transcription/types";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const audioPath = process.argv[2];
if (!audioPath) {
  console.error("usage: bun run src/scripts/soniox-repro.ts <path-to-wav>");
  process.exit(2);
}
if (!fs.existsSync(audioPath)) {
  console.error(`audio file not found: ${audioPath}`);
  process.exit(2);
}

const apiKey = process.env.SONIOX_API_KEY;
if (!apiKey) {
  console.error("SONIOX_API_KEY env var required");
  process.exit(2);
}

// Pino logger - quiet by default; SONIOX_REPRO_VERBOSE=1 for debug
const logger = pino({
  level: process.env.SONIOX_REPRO_VERBOSE ? "debug" : "info",
  transport: {
    target: "pino-pretty",
    options: { colorize: true, ignore: "pid,hostname,time", singleLine: true },
  },
});

// Minimal stub for SonioxTranscriptionProvider — we only need recordSuccess /
// recordFailure / name fields used by SonioxSdkStream.
const stubProvider: any = {
  name: "soniox",
  recordSuccess: () => {},
  recordFailure: () => {},
};

const client = new SonioxNodeClient({ apiKey });

// ---------------------------------------------------------------------------
// Event capture
// ---------------------------------------------------------------------------

type CapturedEvent = {
  t: number;
  kind: "interim" | "FINAL" | "ready" | "error" | "closed";
  text?: string;
  utteranceId?: string;
  speakerId?: string;
  msg?: string;
};

const events: CapturedEvent[] = [];
let t0 = 0;

const callbacks: StreamCallbacks = {
  onReady: () => {
    const t = Date.now() - t0;
    events.push({ t, kind: "ready" });
    console.log(`[${t.toString().padStart(5)}ms] READY`);
  },
  onData: (data: any) => {
    const t = Date.now() - t0;
    const kind = data.isFinal ? "FINAL" : "interim";
    events.push({ t, kind, text: data.text, utteranceId: data.utteranceId, speakerId: data.speakerId });
    const tag = kind === "FINAL" ? "\x1b[33mFINAL  \x1b[0m" : "interim";
    console.log(`[${t.toString().padStart(5)}ms] ${tag} (${data.utteranceId?.slice(-6) ?? "------"}) "${data.text}"`);
  },
  onError: (err: Error) => {
    const t = Date.now() - t0;
    events.push({ t, kind: "error", msg: err.message });
    console.error(`[${t.toString().padStart(5)}ms] ERROR ${err.message}`);
  },
  onClosed: (code: number) => {
    const t = Date.now() - t0;
    events.push({ t, kind: "closed", msg: String(code) });
    console.log(`[${t.toString().padStart(5)}ms] CLOSED ${code}`);
  },
};

// ---------------------------------------------------------------------------
// WAV reader
// ---------------------------------------------------------------------------

function readWavPcm16(filePath: string): { pcm: Buffer; sampleRate: number; channels: number } {
  const buf = fs.readFileSync(filePath);
  if (buf.slice(0, 4).toString() !== "RIFF" || buf.slice(8, 12).toString() !== "WAVE") {
    throw new Error("not a WAV file");
  }
  // Walk chunks to find fmt and data
  let offset = 12;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let dataOffset = 0;
  let dataLength = 0;
  while (offset < buf.length - 8) {
    const chunkId = buf.slice(offset, offset + 4).toString();
    const chunkSize = buf.readUInt32LE(offset + 4);
    if (chunkId === "fmt ") {
      channels = buf.readUInt16LE(offset + 10);
      sampleRate = buf.readUInt32LE(offset + 12);
      bitsPerSample = buf.readUInt16LE(offset + 22);
    } else if (chunkId === "data") {
      dataOffset = offset + 8;
      dataLength = chunkSize;
      break;
    }
    // RIFF requires odd-sized chunks to be followed by a pad byte to
    // keep subsequent chunks word-aligned.
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  if (sampleRate !== 16000 || channels !== 1 || bitsPerSample !== 16) {
    throw new Error(
      `unsupported WAV (need 16000Hz mono 16-bit, got ${sampleRate}Hz ${channels}ch ${bitsPerSample}bit)`,
    );
  }
  return { pcm: buf.subarray(dataOffset, dataOffset + dataLength), sampleRate, channels };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Loading: ${path.resolve(audioPath)}`);
  const { pcm, sampleRate, channels } = readWavPcm16(audioPath);
  const durationMs = (pcm.length / 2 / sampleRate) * 1000;
  console.log(`Audio: ${sampleRate}Hz ${channels}ch ${pcm.length} bytes (${durationMs.toFixed(0)}ms)`);

  const stream = new SonioxSdkStream(
    "repro-" + Date.now(),
    "transcription:en-US",
    stubProvider,
    "en-US",
    undefined,
    callbacks,
    logger as any,
    {
      model: "stt-rt-v4",
      // Override Soniox's `max_endpoint_delay_ms` via env to simulate
      // aggressive endpoint detection (500ms = min, 3000ms = max,
      // Soniox default = 2000ms).
      maxEndpointDelayMs: process.env.SONIOX_MAX_ENDPOINT_DELAY_MS
        ? Number(process.env.SONIOX_MAX_ENDPOINT_DELAY_MS)
        : undefined,
      // Override the post-endpoint debounce window. Default in our code
      // is 500ms.
      endpointDebounceMs: process.env.SONIOX_ENDPOINT_DEBOUNCE_MS
        ? Number(process.env.SONIOX_ENDPOINT_DEBOUNCE_MS)
        : undefined,
    } as any,
    client,
  );

  t0 = Date.now();
  console.log(`[${"0".padStart(5)}ms] init…`);
  await stream.initialize();

  // Feed audio in real-time chunks
  // 16kHz mono 16-bit = 32000 bytes/sec = 1600 bytes per 50ms
  const chunkSize = 1600; // 50ms of audio
  const chunkInterval = 50; // ms

  for (let i = 0; i < pcm.length; i += chunkSize) {
    const chunk = pcm.subarray(i, Math.min(i + chunkSize, pcm.length));
    // Copy into a new ArrayBuffer to satisfy writeAudio signature
    const ab = new ArrayBuffer(chunk.length);
    new Uint8Array(ab).set(chunk);
    await stream.writeAudio(ab);
    await sleep(chunkInterval);
  }

  // Drain: wait for any trailing events. 4 seconds is enough to let any
  // pending Soniox endpoint / finalized events surface.
  console.log(`[${(Date.now() - t0).toString().padStart(5)}ms] done feeding audio; draining 4s…`);
  await sleep(4000);

  await stream.close();
  await sleep(500);

  // -------------------------------------------------------------------------
  // Analyze
  // -------------------------------------------------------------------------
  console.log("\n=== Summary ===");
  const finals = events.filter((e) => e.kind === "FINAL");
  const interims = events.filter((e) => e.kind === "interim");
  console.log(`Total interims: ${interims.length}`);
  console.log(`Total FINALs:   ${finals.length}`);
  console.log();

  // Detect bug: consecutive FINALs within 800ms of each other.
  // This is the signature of a single utterance being split.
  let bugDetected = false;
  for (let i = 1; i < finals.length; i++) {
    const gap = finals[i].t - finals[i - 1].t;
    if (gap < 800) {
      bugDetected = true;
      console.log(`\x1b[31mBUG: FINAL #${i} at ${finals[i].t}ms is ${gap}ms after FINAL #${i - 1}\x1b[0m`);
      console.log(`     prev: "${finals[i - 1].text}"`);
      console.log(`     next: "${finals[i].text}"`);
    }
  }

  // The "consecutive FINALs within 800ms" check above is the load-bearing
  // diagnostic. We deliberately don't try heuristics like "ends in single
  // letter" or "ends in letter+apostrophe": those produce false positives
  // on legitimate words ("I", "a") or transcribed hesitations ("uh, I'")
  // and don't add coverage beyond the timing-based check.

  console.log();
  console.log("Final transcript chain:");
  finals.forEach((f, i) => console.log(`  ${i + 1}. [${f.t}ms] "${f.text}"`));

  process.exit(bugDetected ? 1 : 0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(2);
});
