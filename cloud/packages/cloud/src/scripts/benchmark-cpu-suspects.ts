/**
 * benchmark-cpu-suspects.ts
 *
 * Benchmarks the two leading suspects for the 5-core CPU spike before pod kill:
 *
 *   1. LC3 WASM decode throughput — how many synchronous decode calls/sec
 *      can a single thread sustain, and at what session count does it saturate?
 *
 *   2. Incident storage JSON processing — how long does JSON.parse / JSON.stringify
 *      block the event loop when processing large incident payloads (the
 *      read-modify-write cycle in incident-storage.service.ts)?
 *
 * Usage:
 *   bun run src/scripts/benchmark-cpu-suspects.ts
 *   bun run src/scripts/benchmark-cpu-suspects.ts --lc3-only
 *   bun run src/scripts/benchmark-cpu-suspects.ts --json-only
 *   bun run src/scripts/benchmark-cpu-suspects.ts --sessions 80
 *   bun run src/scripts/benchmark-cpu-suspects.ts --verbose
 *
 * Context:
 *   Issue 055 confirmed crashes are liveness probe failures (not OOM).
 *   Issue 056 is investigating what causes CPU to spike from 0.5 → 5.02 cores.
 *   The incident system was added Feb 22, touched again March 22 — 3 days before
 *   the March 25 crash. WASM decode has been stable for months. This script
 *   helps us rule one in and the other out.
 */

import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

const args = new Set(process.argv.slice(2));
const flagValue = (flag: string): string | undefined => {
  const arr = process.argv.slice(2);
  const idx = arr.indexOf(flag);
  return idx !== -1 && idx + 1 < arr.length ? arr[idx + 1] : undefined;
};

const RUN_LC3 = !args.has("--json-only");
const RUN_JSON = !args.has("--lc3-only");
const VERBOSE = args.has("--verbose");
const MAX_SESSIONS = parseInt(flagValue("--sessions") || "80", 10);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hrMs(start: [number, number]): number {
  const diff = process.hrtime(start);
  return diff[0] * 1000 + diff[1] / 1e6;
}

function fmt(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(1)}µs`;
  if (ms < 1000) return `${ms.toFixed(2)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function separator(title: string): void {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`  ${title}`);
  console.log("=".repeat(70));
}

// ---------------------------------------------------------------------------
// BENCHMARK 1: LC3 WASM Decode
// ---------------------------------------------------------------------------

async function benchmarkLC3() {
  separator("LC3 WASM Decode Benchmark");

  const wasmPath = path.resolve(__dirname, "../services/lc3/liblc3.wasm");
  if (!fs.existsSync(wasmPath)) {
    console.error(`  ❌ WASM file not found at: ${wasmPath}`);
    console.error(`     Run this script from the cloud package root.`);
    return;
  }

  // ---- Compile WASM (one-time cost) ----
  console.log("\n  Compiling WASM module...");
  const compileStart = process.hrtime();
  const wasmBuffer = fs.readFileSync(wasmPath);
  const wasmModule = await WebAssembly.compile(new Uint8Array(wasmBuffer));
  const compileMs = hrMs(compileStart);
  console.log(`  ✅ WASM compiled in ${fmt(compileMs)}`);

  // ---- Instantiate one instance to get codec parameters ----
  const instStart = process.hrtime();
  const instance = await WebAssembly.instantiate(wasmModule, {});
  const instMs = hrMs(instStart);
  console.log(`  ✅ Single WASM instantiation: ${fmt(instMs)}`);

  const exports = instance.exports as any;
  const frameDurationUs = 10000; // 10ms
  const sampleRateHz = 16000;
  const frameBytes = 20; // 16kbps — the most common setting

  const frameSamples = exports.lc3_frame_samples(frameDurationUs, sampleRateHz);
  const decoderSize = exports.lc3_decoder_size(frameDurationUs, sampleRateHz);
  const encoderSize = exports.lc3_encoder_size(frameDurationUs, sampleRateHz);

  console.log(`  Frame samples: ${frameSamples}, decoder size: ${decoderSize}, encoder size: ${encoderSize}`);

  // ---- Helper: create a codec instance from a WASM instance ----
  function createCodec(wasmInst: WebAssembly.Instance) {
    const exp = wasmInst.exports as any;
    const memory = exp.memory as WebAssembly.Memory;
    const basePtr = memory.buffer.byteLength;
    const allocationSize = decoderSize + encoderSize + frameSamples * 2 + 1024;
    const pagesNeeded = Math.ceil((basePtr + allocationSize) / (64 * 1024));
    const currentPages = memory.buffer.byteLength / (64 * 1024);
    if (pagesNeeded > currentPages) {
      memory.grow(pagesNeeded - currentPages);
    }

    const decoderPtr = basePtr;
    const samplePtr = decoderPtr + decoderSize + encoderSize;
    const framePtr = samplePtr + frameSamples * 2;

    exp.lc3_setup_decoder(frameDurationUs, sampleRateHz, 0, decoderPtr);

    return {
      samples: new Int16Array(memory.buffer, samplePtr, frameSamples),
      frame: new Uint8Array(memory.buffer, framePtr, 1024),
      decode(fb: number) {
        exp.lc3_decode(decoderPtr, framePtr, fb, 0, samplePtr, 1);
      },
    };
  }

  // ---- Generate fake LC3 frames (random bytes — the codec won't crash, just produces noise) ----
  function generateFakeChunk(numFrames: number): Uint8Array {
    const data = new Uint8Array(numFrames * frameBytes);
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.floor(Math.random() * 256);
    }
    return data;
  }

  // ---- Benchmark: single decode call timing ----
  console.log("\n  --- Single decode call timing ---");
  const codec = createCodec(instance);
  const singleChunk = generateFakeChunk(1);
  codec.frame.set(singleChunk);

  // Warmup
  for (let i = 0; i < 1000; i++) {
    codec.decode(frameBytes);
  }

  const SINGLE_ITERS = 10000;
  const singleStart = process.hrtime();
  for (let i = 0; i < SINGLE_ITERS; i++) {
    codec.decode(frameBytes);
  }
  const singleTotalMs = hrMs(singleStart);
  const singleAvgUs = (singleTotalMs / SINGLE_ITERS) * 1000;
  console.log(`  ${SINGLE_ITERS} single-frame decodes: ${fmt(singleTotalMs)} total, ${singleAvgUs.toFixed(2)}µs avg`);

  // ---- Benchmark: full decodeAudioChunk simulation (multi-frame) ----
  console.log("\n  --- Full chunk decode simulation (mimics AudioManager.processAudioData) ---");

  // Typical: client sends 60ms of audio → 6 frames of 10ms each at 20 bytes/frame = 120 bytes
  const framesPerChunk = 6;
  const fakeChunk = generateFakeChunk(framesPerChunk);
  const CHUNK_ITERS = 5000;

  const chunkStart = process.hrtime();
  for (let iter = 0; iter < CHUNK_ITERS; iter++) {
    // Simulate decodeAudioChunk: loop over frames, copy in, decode, copy out
    const outputBuffer = new ArrayBuffer(framesPerChunk * frameSamples * 2);
    const outputView = new Int16Array(outputBuffer);
    const inputData = fakeChunk;

    for (let i = 0; i < framesPerChunk; i++) {
      codec.frame.set(inputData.subarray(i * frameBytes, (i + 1) * frameBytes));
      codec.decode(frameBytes);
      outputView.set(codec.samples, i * frameSamples);
    }
  }
  const chunkTotalMs = hrMs(chunkStart);
  const chunkAvgMs = chunkTotalMs / CHUNK_ITERS;
  const chunksPerSec = 1000 / chunkAvgMs;
  console.log(`  ${CHUNK_ITERS} chunk decodes (${framesPerChunk} frames each): ${fmt(chunkTotalMs)} total`);
  console.log(`  Per-chunk avg: ${fmt(chunkAvgMs)}, max throughput: ${chunksPerSec.toFixed(0)} chunks/sec`);

  // ---- Benchmark: multi-session simulation ----
  console.log("\n  --- Multi-session decode throughput (1 second of real-time audio) ---");
  console.log(`  Simulating 10 → ${MAX_SESSIONS} sessions, each sending 16 chunks/sec (60ms intervals)`);
  console.log();

  const sessionCounts = [];
  for (let n = 10; n <= MAX_SESSIONS; n += 10) sessionCounts.push(n);
  if (!sessionCounts.includes(MAX_SESSIONS)) sessionCounts.push(MAX_SESSIONS);

  // Pre-instantiate all WASM instances we'll need
  console.log(`  Pre-instantiating ${MAX_SESSIONS} WASM instances...`);
  const preInstStart = process.hrtime();
  const codecs: ReturnType<typeof createCodec>[] = [];
  for (let i = 0; i < MAX_SESSIONS; i++) {
    const inst = await WebAssembly.instantiate(wasmModule, {});
    codecs.push(createCodec(inst));
  }
  const preInstMs = hrMs(preInstStart);
  console.log(`  ✅ ${MAX_SESSIONS} instances in ${fmt(preInstMs)} (${fmt(preInstMs / MAX_SESSIONS)} each)`);

  console.log();
  console.log(
    `  ${"Sessions".padEnd(10)} ${"Chunks".padEnd(10)} ${"Decode Time".padEnd(14)} ${"% of 1s budget".padEnd(16)} ${"Event Loop Left".padEnd(16)} Verdict`,
  );
  console.log(
    `  ${"-".repeat(10)} ${"-".repeat(10)} ${"-".repeat(14)} ${"-".repeat(16)} ${"-".repeat(16)} ${"─".repeat(12)}`,
  );

  for (const numSessions of sessionCounts) {
    const chunksPerSecPerSession = 16; // ~60ms send interval
    const totalChunks = numSessions * chunksPerSecPerSession;
    const chunk = generateFakeChunk(framesPerChunk);

    const simStart = process.hrtime();
    for (let c = 0; c < totalChunks; c++) {
      const codecIdx = c % numSessions;
      const cc = codecs[codecIdx];
      // Simulate full decodeAudioChunk pipeline
      const outputBuffer = new ArrayBuffer(framesPerChunk * frameSamples * 2);
      const outputView = new Int16Array(outputBuffer);
      for (let i = 0; i < framesPerChunk; i++) {
        cc.frame.set(chunk.subarray(i * frameBytes, (i + 1) * frameBytes));
        cc.decode(frameBytes);
        outputView.set(cc.samples, i * frameSamples);
      }
    }
    const simMs = hrMs(simStart);
    const pctBudget = (simMs / 1000) * 100;
    const remaining = 1000 - simMs;

    let verdict = "✅ Fine";
    if (pctBudget > 90) verdict = "🔴 SATURATED";
    else if (pctBudget > 70) verdict = "🟡 Warning";
    else if (pctBudget > 50) verdict = "🟠 Elevated";

    console.log(
      `  ${String(numSessions).padEnd(10)} ${String(totalChunks).padEnd(10)} ${fmt(simMs).padEnd(14)} ${(pctBudget.toFixed(1) + "%").padEnd(16)} ${fmt(Math.max(0, remaining)).padEnd(16)} ${verdict}`,
    );
  }

  // ---- Benchmark: WASM instantiation burst (thundering herd) ----
  console.log("\n  --- WASM instantiation burst (simulates thundering herd after restart) ---");

  for (const burstSize of [10, 20, 40]) {
    const burstStart = process.hrtime();
    const promises = [];
    for (let i = 0; i < burstSize; i++) {
      promises.push(WebAssembly.instantiate(wasmModule, {}));
    }
    await Promise.all(promises);
    const burstMs = hrMs(burstStart);
    console.log(`  ${burstSize} concurrent instantiations: ${fmt(burstMs)} (${fmt(burstMs / burstSize)} each)`);
  }
}

// ---------------------------------------------------------------------------
// BENCHMARK 2: Incident JSON Processing (main-thread blocking)
// ---------------------------------------------------------------------------

async function benchmarkIncidentJSON() {
  separator("Incident JSON Processing Benchmark");
  console.log("\n  Simulates the read-modify-write cycle in incident-storage.service.ts");
  console.log("  (JSON.parse full doc → array spread → JSON.stringify with pretty-print)\n");

  // ---- Generate fake log entries ----
  function generateLogEntry(idx: number): Record<string, unknown> {
    return {
      timestamp: new Date(Date.now() - idx * 1000).toISOString(),
      level: idx % 5 === 0 ? "error" : idx % 3 === 0 ? "warn" : "info",
      message: `Log message ${idx}: something happened in the system that we need to track for debugging purposes. userId=user${idx % 20}@example.com sessionId=sess-${idx}`,
      service: ["cloud", "transcription", "audio", "app-manager", "ws"][idx % 5],
      userId: `user${idx % 20}@example.com`,
      context: {
        requestId: `req-${idx}-${Math.random().toString(36).slice(2)}`,
        duration: Math.random() * 1000,
        status: [200, 201, 400, 401, 500][idx % 5],
        path: `/api/${["health", "client/audio/configure", "incidents", "apps", "settings"][idx % 5]}`,
      },
    };
  }

  function generateIncidentLogs(
    cloudLogCount: number,
    phoneLogCount: number,
    appLogCount: number,
  ): Record<string, unknown> {
    return {
      incidentId: `inc-${Math.random().toString(36).slice(2)}`,
      userId: "testuser@example.com",
      feedback: {
        type: "bug",
        expectedBehavior: "Captions should display in real time with <1s latency",
        actualBehavior: "Captions stopped appearing after ~30 seconds of use. Audio continued flowing.",
        severityRating: 4,
        systemInfo: {
          appVersion: "1.2.3",
          device: "Mentra Live G1",
          os: "Android 14",
          firmwareVersion: "2.1.0",
        },
      },
      cloudLogs: Array.from({ length: cloudLogCount }, (_, i) => generateLogEntry(i)),
      phoneLogs: Array.from({ length: phoneLogCount }, (_, i) => ({
        ...generateLogEntry(i),
        source: "phone",
      })),
      glassesLogs: [],
      glassesFirmwareLogs: [],
      appTelemetry: Array.from({ length: appLogCount }, (_, i) => ({
        packageName: `com.example.app${i % 5}`,
        logs: Array.from({ length: Math.floor(appLogCount / 5) }, (_, j) => generateLogEntry(j)),
        uploadedAt: new Date().toISOString(),
      })),
      createdAt: new Date().toISOString(),
    };
  }

  // ---- Benchmark: JSON.stringify at various sizes ----
  console.log("  --- JSON.stringify blocking time (pretty-print vs compact) ---\n");
  console.log(
    `  ${"Cloud Logs".padEnd(12)} ${"Phone Logs".padEnd(12)} ${"App Logs".padEnd(12)} ${"Doc Size".padEnd(12)} ${"Pretty".padEnd(14)} ${"Compact".padEnd(14)} ${"Ratio".padEnd(8)} Verdict`,
  );
  console.log(
    `  ${"-".repeat(12)} ${"-".repeat(12)} ${"-".repeat(12)} ${"-".repeat(12)} ${"-".repeat(14)} ${"-".repeat(14)} ${"-".repeat(8)} ${"─".repeat(12)}`,
  );

  const scenarios = [
    { cloud: 100, phone: 100, app: 0, label: "small (no apps)" },
    { cloud: 500, phone: 500, app: 0, label: "medium" },
    { cloud: 1000, phone: 500, app: 0, label: "BetterStack max" },
    { cloud: 1000, phone: 500, app: 100, label: "with 1 app" },
    { cloud: 1000, phone: 500, app: 500, label: "with 5 apps" },
    { cloud: 1000, phone: 1000, app: 1000, label: "heavy" },
    { cloud: 2000, phone: 1000, app: 2000, label: "extreme" },
  ];

  const stringifyResults: { label: string; prettyMs: number; compactMs: number; size: number }[] = [];

  for (const scenario of scenarios) {
    const doc = generateIncidentLogs(scenario.cloud, scenario.phone, scenario.app);

    // Pretty-print (what the actual code does: JSON.stringify(logs, null, 2))
    const prettyStart = process.hrtime();
    const prettyStr = JSON.stringify(doc, null, 2);
    const prettyMs = hrMs(prettyStart);

    // Compact (what it should do)
    const compactStart = process.hrtime();
    const compactStr = JSON.stringify(doc);
    const compactMs = hrMs(compactStart);

    const ratio = prettyMs / Math.max(compactMs, 0.001);

    let verdict = "✅ Fine";
    if (prettyMs > 100) verdict = "🔴 BLOCKS >100ms";
    else if (prettyMs > 50) verdict = "🟡 BLOCKS >50ms";
    else if (prettyMs > 10) verdict = "🟠 Noticeable";

    stringifyResults.push({ label: scenario.label, prettyMs, compactMs, size: prettyStr.length });

    console.log(
      `  ${String(scenario.cloud).padEnd(12)} ${String(scenario.phone).padEnd(12)} ${String(scenario.app).padEnd(12)} ${fmtBytes(prettyStr.length).padEnd(12)} ${fmt(prettyMs).padEnd(14)} ${fmt(compactMs).padEnd(14)} ${(ratio.toFixed(1) + "x").padEnd(8)} ${verdict}`,
    );
  }

  // ---- Benchmark: JSON.parse of large documents ----
  console.log("\n  --- JSON.parse blocking time ---\n");
  console.log(`  ${"Scenario".padEnd(22)} ${"Doc Size".padEnd(12)} ${"Parse Time".padEnd(14)} Verdict`);
  console.log(`  ${"-".repeat(22)} ${"-".repeat(12)} ${"-".repeat(14)} ${"─".repeat(12)}`);

  for (const scenario of scenarios) {
    const doc = generateIncidentLogs(scenario.cloud, scenario.phone, scenario.app);
    const jsonStr = JSON.stringify(doc, null, 2); // pretty-print like the real code stores

    const parseStart = process.hrtime();
    JSON.parse(jsonStr);
    const parseMs = hrMs(parseStart);

    let verdict = "✅ Fine";
    if (parseMs > 100) verdict = "🔴 BLOCKS >100ms";
    else if (parseMs > 50) verdict = "🟡 BLOCKS >50ms";
    else if (parseMs > 10) verdict = "🟠 Noticeable";

    console.log(
      `  ${scenario.label.padEnd(22)} ${fmtBytes(jsonStr.length).padEnd(12)} ${fmt(parseMs).padEnd(14)} ${verdict}`,
    );
  }

  // ---- Benchmark: Full read-modify-write cycle (what appendLogs actually does) ----
  console.log("\n  --- Full read-modify-write cycle (simulates appendLogs) ---");
  console.log("  Each cycle: JSON.parse(existing) → array spread → JSON.stringify(result, null, 2)\n");

  // Start with a moderate-size document and append logs 5 times (simulating 5 apps uploading)
  let currentDoc = generateIncidentLogs(1000, 500, 0);
  const appendBatchSize = 200; // Each app uploads ~200 log entries

  console.log(`  Starting doc: ${fmtBytes(JSON.stringify(currentDoc, null, 2).length)}`);
  console.log(`  Each append adds ${appendBatchSize} log entries\n`);

  let cumulativeMs = 0;

  for (let append = 1; append <= 6; append++) {
    const serialized = JSON.stringify(currentDoc, null, 2);
    const newLogs = Array.from({ length: appendBatchSize }, (_, i) => generateLogEntry(i));

    // Simulate the full read-modify-write cycle
    const cycleStart = process.hrtime();

    // 1. Parse existing (simulates download from R2 + JSON.parse)
    const existing = JSON.parse(serialized) as Record<string, unknown>;

    // 2. Array spread (what the actual code does)
    (existing as any).cloudLogs = [...((existing as any).cloudLogs || []), ...newLogs];

    // 3. Pretty-print stringify (what the actual code does)
    const result = JSON.stringify(existing, null, 2);

    const cycleMs = hrMs(cycleStart);
    cumulativeMs += cycleMs;

    let verdict = "✅ Fine";
    if (cycleMs > 100) verdict = "🔴 BLOCKS >100ms";
    else if (cycleMs > 50) verdict = "🟡 BLOCKS >50ms";
    else if (cycleMs > 10) verdict = "🟠 Noticeable";

    console.log(
      `  Append #${append}: doc=${fmtBytes(result.length)}, cycle=${fmt(cycleMs)}, cumulative=${fmt(cumulativeMs)} ${verdict}`,
    );

    // Update for next iteration
    currentDoc = JSON.parse(result);
  }

  console.log(`\n  Total blocking time for 6 append cycles: ${fmt(cumulativeMs)}`);
  if (cumulativeMs > 500) {
    console.log(`  🔴 This ALONE could block the event loop for ${fmt(cumulativeMs)} — enough to fail health probes`);
  } else if (cumulativeMs > 100) {
    console.log(`  🟡 Significant event loop blocking — compounds with other work`);
  } else {
    console.log(`  ✅ Unlikely to cause health probe failure on its own`);
  }

  // ---- Benchmark: BetterStack query log parsing (3000 JSON.parse ops) ----
  console.log("\n  --- BetterStack log parsing (simulates betterstack-query.service.ts) ---");
  console.log("  Parses 1000 lines: JSON.parse(line) → JSON.parse(raw) per line\n");

  // Generate fake BetterStack JSONEachRow output
  const lines: string[] = [];
  for (let i = 0; i < 1000; i++) {
    const logObj = generateLogEntry(i);
    const line = JSON.stringify({
      dt: logObj.timestamp,
      raw: JSON.stringify(logObj), // double-encoded like BetterStack returns
    });
    lines.push(line);
  }
  const fullText = lines.join("\n");

  console.log(`  Response size: ${fmtBytes(fullText.length)}`);

  const bsStart = process.hrtime();
  const parsedLines = fullText.trim().split("\n").filter(Boolean);
  const splitMs = hrMs(bsStart);

  const parseStart2 = process.hrtime();
  const parsed = parsedLines.map((line) => {
    const { dt, raw } = JSON.parse(line);
    const obj = typeof raw === "string" ? JSON.parse(raw) : raw;
    return {
      timestamp: dt,
      level: obj.level || "info",
      message: obj.msg || obj.message || JSON.stringify(obj),
      service: obj.service || "cloud",
    };
  });
  const parseMs2 = hrMs(parseStart2);

  console.log(`  Split ${parsedLines.length} lines: ${fmt(splitMs)}`);
  console.log(`  Parse all lines (2× JSON.parse each): ${fmt(parseMs2)}`);
  console.log(`  Total blocking time: ${fmt(splitMs + parseMs2)}`);

  if (parseMs2 > 50) {
    console.log(`  🟡 BetterStack parsing blocks event loop for ${fmt(parseMs2)}`);
  } else {
    console.log(`  ✅ BetterStack parsing is fast enough`);
  }
}

// ---------------------------------------------------------------------------
// BENCHMARK 3: Event loop blocking simulation
// ---------------------------------------------------------------------------

async function benchmarkEventLoopBlocking() {
  separator("Event Loop Blocking Measurement");
  console.log("\n  Measures actual event loop starvation during heavy operations.");
  console.log("  A healthy event loop resolves setTimeout(0) in <5ms.\n");

  // Helper: measure how long the event loop is blocked
  async function measureEventLoopLag(label: string, work: () => void): Promise<{ workMs: number; lagMs: number }> {
    // Schedule a timer BEFORE starting the work
    let timerFired = false;
    let timerScheduledAt = 0;
    let timerFiredAt = 0;

    const timerPromise = new Promise<void>((resolve) => {
      timerScheduledAt = performance.now();
      setTimeout(() => {
        timerFiredAt = performance.now();
        timerFired = true;
        resolve();
      }, 0);
    });

    // Do the synchronous work (this blocks the timer)
    const workStart = performance.now();
    work();
    const workEnd = performance.now();

    // Wait for the timer to fire
    await timerPromise;

    const workMs = workEnd - workStart;
    const lagMs = timerFiredAt - timerScheduledAt;

    return { workMs, lagMs };
  }

  // Test 1: LC3-like synchronous WASM decode burst
  const wasmPath = path.resolve(__dirname, "../services/lc3/liblc3.wasm");
  if (fs.existsSync(wasmPath)) {
    const wasmBuffer = fs.readFileSync(wasmPath);
    const wasmModule = await WebAssembly.compile(new Uint8Array(wasmBuffer));
    const inst = await WebAssembly.instantiate(wasmModule, {});
    const exp = inst.exports as any;

    const frameDurationUs = 10000;
    const sampleRateHz = 16000;
    const frameBytes = 20;
    const frameSamples = exp.lc3_frame_samples(frameDurationUs, sampleRateHz);
    const decoderSize = exp.lc3_decoder_size(frameDurationUs, sampleRateHz);
    const encoderSize = exp.lc3_encoder_size(frameDurationUs, sampleRateHz);

    const memory = exp.memory as WebAssembly.Memory;
    const basePtr = memory.buffer.byteLength;
    const allocationSize = decoderSize + encoderSize + frameSamples * 2 + 1024;
    const pagesNeeded = Math.ceil((basePtr + allocationSize) / (64 * 1024));
    const currentPages = memory.buffer.byteLength / (64 * 1024);
    if (pagesNeeded > currentPages) memory.grow(pagesNeeded - currentPages);

    const decoderPtr = basePtr;
    const samplePtr = decoderPtr + decoderSize + encoderSize;
    const framePtr = samplePtr + frameSamples * 2;

    exp.lc3_setup_decoder(frameDurationUs, sampleRateHz, 0, decoderPtr);

    const fakeFrame = new Uint8Array(frameBytes);
    for (let i = 0; i < frameBytes; i++) fakeFrame[i] = Math.floor(Math.random() * 256);
    new Uint8Array(memory.buffer, framePtr, frameBytes).set(fakeFrame);

    for (const numDecodes of [640, 1280, 3200]) {
      const { workMs, lagMs } = await measureEventLoopLag(`${numDecodes} LC3 decodes`, () => {
        for (let i = 0; i < numDecodes; i++) {
          exp.lc3_decode(decoderPtr, framePtr, frameBytes, 0, samplePtr, 1);
        }
      });
      const lagVerdict = lagMs > 1000 ? "🔴 HEALTH PROBE FAIL" : lagMs > 100 ? "🟡 Degraded" : "✅ OK";
      console.log(`  ${numDecodes} LC3 decodes: work=${fmt(workMs)}, event loop lag=${fmt(lagMs)} ${lagVerdict}`);
    }
  }

  // Test 2: JSON.stringify of large incident document
  console.log();
  for (const logCount of [500, 1000, 2000, 5000]) {
    const doc = {
      cloudLogs: Array.from({ length: logCount }, (_, i) => ({
        timestamp: new Date().toISOString(),
        level: "info",
        message: `Log ${i}: ${"x".repeat(200)}`,
        service: "cloud",
        context: { requestId: `req-${i}`, duration: Math.random() * 1000 },
      })),
      phoneLogs: Array.from({ length: Math.floor(logCount / 2) }, (_, i) => ({
        timestamp: new Date().toISOString(),
        level: "info",
        message: `Phone log ${i}: ${"y".repeat(150)}`,
      })),
    };

    const { workMs, lagMs } = await measureEventLoopLag(`JSON.stringify ${logCount} logs`, () => {
      JSON.stringify(doc, null, 2);
    });
    const lagVerdict = lagMs > 1000 ? "🔴 HEALTH PROBE FAIL" : lagMs > 100 ? "🟡 Degraded" : "✅ OK";
    console.log(
      `  JSON.stringify(${logCount} logs, null, 2): work=${fmt(workMs)}, event loop lag=${fmt(lagMs)} ${lagVerdict}`,
    );
  }

  // Test 3: Combined — what happens during incident processing
  console.log("\n  --- Combined: incident processing during 40-session audio decode ---");
  console.log("  (Simulates incident triggered while server is under normal audio load)\n");

  if (fs.existsSync(wasmPath)) {
    // Simulate: decode 640 frames (1 second of 40-session audio) PLUS stringify a big incident doc
    const wasmBuffer2 = fs.readFileSync(wasmPath);
    const wasmModule2 = await WebAssembly.compile(new Uint8Array(wasmBuffer2));
    const inst2 = await WebAssembly.instantiate(wasmModule2, {});
    const exp2 = inst2.exports as any;

    const frameDurationUs = 10000;
    const sampleRateHz = 16000;
    const fb = 20;
    const fSamples = exp2.lc3_frame_samples(frameDurationUs, sampleRateHz);
    const dSize = exp2.lc3_decoder_size(frameDurationUs, sampleRateHz);
    const eSize = exp2.lc3_encoder_size(frameDurationUs, sampleRateHz);

    const mem = exp2.memory as WebAssembly.Memory;
    const bp = mem.buffer.byteLength;
    const allocSz = dSize + eSize + fSamples * 2 + 1024;
    const pn = Math.ceil((bp + allocSz) / (64 * 1024));
    const cp = mem.buffer.byteLength / (64 * 1024);
    if (pn > cp) mem.grow(pn - cp);
    const dp = bp;
    const sp = dp + dSize + eSize;
    const fp = sp + fSamples * 2;
    exp2.lc3_setup_decoder(frameDurationUs, sampleRateHz, 0, dp);

    const bigDoc = {
      cloudLogs: Array.from({ length: 1000 }, (_, i) => ({
        timestamp: new Date().toISOString(),
        level: "info",
        message: `Log ${i}: ${"x".repeat(200)}`,
        service: "cloud",
        context: { requestId: `req-${i}`, duration: Math.random() * 1000 },
      })),
      phoneLogs: Array.from({ length: 500 }, (_, i) => ({
        timestamp: new Date().toISOString(),
        level: "info",
        message: `Phone log ${i}: ${"y".repeat(150)}`,
      })),
    };
    const serialized = JSON.stringify(bigDoc, null, 2);

    const { workMs, lagMs } = await measureEventLoopLag("640 decodes + incident JSON cycle", () => {
      // Audio decode work
      for (let i = 0; i < 640; i++) {
        exp2.lc3_decode(dp, fp, fb, 0, sp, 1);
      }
      // Incident read-modify-write cycle
      const existing = JSON.parse(serialized);
      const newLogs = Array.from({ length: 200 }, (_, j) => ({
        timestamp: new Date().toISOString(),
        level: "info",
        message: `App log ${j}: ${"z".repeat(150)}`,
      }));
      existing.cloudLogs = [...existing.cloudLogs, ...newLogs];
      JSON.stringify(existing, null, 2);
    });

    const lagVerdict = lagMs > 1000 ? "🔴 HEALTH PROBE FAIL" : lagMs > 100 ? "🟡 Degraded" : "✅ OK";
    console.log(`  Combined work: ${fmt(workMs)}, event loop lag: ${fmt(lagMs)} ${lagVerdict}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════════════╗");
  console.log("║  CPU Spike Suspects Benchmark                                      ║");
  console.log("║  Issue 056: What causes the 5-core spike before pod kill?           ║");
  console.log("╚══════════════════════════════════════════════════════════════════════╝");
  console.log();
  console.log(`  Runtime: Bun ${typeof Bun !== "undefined" ? Bun.version : "(not Bun)"}`);
  console.log(`  Platform: ${process.platform} ${process.arch}`);
  console.log(`  CPU cores: ${navigator?.hardwareConcurrency || "unknown"}`);
  console.log(`  Date: ${new Date().toISOString()}`);

  if (RUN_LC3) {
    await benchmarkLC3();
  }

  if (RUN_JSON) {
    await benchmarkIncidentJSON();
  }

  // Always run the event loop blocking test — it ties everything together
  if (RUN_LC3 || RUN_JSON) {
    await benchmarkEventLoopBlocking();
  }

  separator("Summary");
  console.log(`
  To determine the root cause, look at:

  1. LC3 decode: What % of a 1-second budget does decode consume at 40 sessions?
     - If <30%: WASM decode is NOT the primary cause (it's been stable for months)
     - If >70%: WASM decode IS saturating the event loop

  2. Incident JSON: How long does a single read-modify-write cycle block?
     - If <10ms per cycle: Incident system is NOT the cause
     - If >50ms per cycle: Multiple back-to-back cycles could block for 200+ms
     - If >100ms per cycle: A single incident with 5 app uploads = 500+ms blocked

  3. Combined: Does incident processing during audio load push past the tipping point?
     - The crash happens when the event loop can't service /health for 75 seconds
     - Even 200ms of blocking can cascade if it delays audio processing,
       causing audio chunks to queue up, making the next tick even longer

  Key question: Did this crash pattern START after the incident system was deployed
  (Feb 22) or after SDK v3 (March 23)? If it correlates with the incident system,
  focus on the JSON processing. If it correlates with SDK v3, look at feat(048).
`);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
