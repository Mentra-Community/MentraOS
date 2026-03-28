#!/usr/bin/env bun
/**
 * analyze-heap.ts — Live memory analysis for MentraCloud pods.
 *
 * Modes:
 *   1. LIVE: Poll a running pod's /api/admin/memory/now endpoint and track growth
 *   2. SNAPSHOT: Parse a Bun/JSC heap snapshot JSON and extract what we can
 *   3. COMPARE: Fetch two snapshots N minutes apart and diff them
 *
 * Usage:
 *   # Track live memory growth (polls every 30s, shows deltas)
 *   bun run src/scripts/analyze-heap.ts live --host=uscentralapi.mentra.glass
 *   bun run src/scripts/analyze-heap.ts live --host=uscentralapi.mentra.glass --interval=10 --duration=600
 *   bun run src/scripts/analyze-heap.ts live --host=franceapi.mentra.glass
 *
 *   # Analyze a saved snapshot file
 *   bun run src/scripts/analyze-heap.ts snapshot --file=../../.heap/us-central-snapshot.json
 *
 *   # Fetch two V8 snapshots from the server, save them, and diff object counts
 *   bun run src/scripts/analyze-heap.ts compare --host=uscentralapi.mentra.glass --delay=300
 *
 *   # Just fetch and save a snapshot
 *   bun run src/scripts/analyze-heap.ts fetch --host=uscentralapi.mentra.glass --out=../../.heap/
 *
 * Environment:
 *   MENTRA_ADMIN_JWT — Bearer token for admin endpoints (reads from process.env or Doppler)
 */

export {};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ADMIN_JWT =
  process.env.MENTRA_ADMIN_JWT ||
  // Fallback: try to read from .env manually
  (() => {
    try {
      const envFile = Bun.file("../../.env");
      const text = envFile.text();
      // text() returns a Promise in types but we only use this as a fallback
      // If it fails, we return empty string
      if (typeof text === "string") {
        const match = text.match(/MENTRA_ADMIN_JWT=(.+)/);
        return match?.[1]?.trim() ?? "";
      }
      return "";
    } catch {
      return "";
    }
  })();

if (!ADMIN_JWT) {
  console.error("❌ MENTRA_ADMIN_JWT not set. Set it in environment or cloud/.env");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const mode = args[0] ?? "live";

function getArg(name: string, defaultVal: string): string {
  const found = args.find((a) => a.startsWith(`--${name}=`));
  return found ? found.split("=").slice(1).join("=") : defaultVal;
}

function getArgNum(name: string, defaultVal: number): number {
  return parseFloat(getArg(name, String(defaultVal)));
}

const host = getArg("host", "uscentralapi.mentra.glass");
const interval = getArgNum("interval", 30); // seconds
const duration = getArgNum("duration", 3600); // seconds (0 = forever)
const delaySeconds = getArgNum("delay", 300); // for compare mode
const snapshotFile = getArg("file", "");
const outDir = getArg("out", "../../.heap");

const BASE_URL = `https://${host}`;
const HEADERS = {
  "Authorization": `Bearer ${ADMIN_JWT}`,
  "Content-Type": "application/json",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MemoryInfo {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

interface SessionInfo {
  userId: string;
  startTime: string;
  audio: {
    recentBufferChunks: number;
    recentBufferBytes: number;
    orderedBufferChunks: number;
    orderedBufferBytes: number;
  };
  transcription: {
    vadBufferChunks: number;
    vadBufferBytes: number;
    transcriptLanguages: number;
    transcriptSegments: number;
  };
  microphone: {
    enabled: boolean;
    keepAliveActive: boolean;
  };
  apps: {
    running: number;
    websockets: number;
  };
}

interface MemorySnapshot {
  timestamp: string;
  host: string;
  process: {
    pid: number;
    memory: {
      rss: { bytes: number; human: string };
      heapTotal: { bytes: number; human: string };
      heapUsed: { bytes: number; human: string };
      external: { bytes: number; human: string };
      arrayBuffers: { bytes: number; human: string };
    };
    loadavg: number[];
    uptime: number;
  };
  sessions: SessionInfo[];
}

interface HealthInfo {
  status: string;
  activeSessions: number;
  uptimeSeconds: number;
  heapUsedMB: number;
  rssMB: number;
  eventLoopLagMs: number;
}

interface TimePoint {
  time: Date;
  memory: MemoryInfo;
  sessions: number;
  apps: number;
  websockets: number;
  audioBufferBytes: number;
  vadBufferBytes: number;
  transcriptSegments: number;
  uptime: number;
  loadavg: number[];
  micActive: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmt(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function delta(current: number, previous: number): string {
  const diff = current - previous;
  if (diff === 0) return "  ──";
  const sign = diff > 0 ? "+" : "";
  return `${sign}${fmt(diff)}`;
}

function deltaNum(current: number, previous: number): string {
  const diff = current - previous;
  if (diff === 0) return "──";
  const sign = diff > 0 ? "+" : "";
  return `${sign}${diff}`;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

function rpad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function timestamp(): string {
  return new Date().toISOString().slice(11, 19);
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// Mode: LIVE — poll and track memory growth
// ---------------------------------------------------------------------------

async function modeLive() {
  console.log(`📊 Live Memory Tracker — ${host}`);
  console.log(`   Polling every ${interval}s${duration > 0 ? `, for ${duration}s` : ", until Ctrl+C"}`);
  console.log();

  const history: TimePoint[] = [];
  const startTime = Date.now();

  // Print header
  const header = `${rpad("Time", 10)} ${pad("RSS", 10)} ${pad("Δ RSS", 10)} ${pad("Heap", 10)} ${pad("Δ Heap", 10)} ${pad("Ext", 10)} ${pad("ArrBuf", 10)} ${pad("Sessions", 9)} ${pad("Apps", 6)} ${pad("WS", 6)} ${pad("Audio", 10)} ${pad("VAD", 10)} ${pad("Segs", 7)} ${pad("Mic", 5)} ${pad("Uptime", 8)} ${pad("Load", 6)}`;
  console.log(header);
  console.log("─".repeat(header.length));

  async function poll() {
    try {
      const data = await fetchJson<MemorySnapshot>(`${BASE_URL}/api/admin/memory/now`);
      const mem = data.process.memory;

      let totalAudioBytes = 0;
      let totalVadBytes = 0;
      let totalSegments = 0;
      let totalApps = 0;
      let totalWs = 0;
      let micActive = 0;

      for (const s of data.sessions) {
        totalAudioBytes += s.audio.recentBufferBytes + s.audio.orderedBufferBytes;
        totalVadBytes += s.transcription.vadBufferBytes;
        totalSegments += s.transcription.transcriptSegments;
        totalApps += s.apps.running;
        totalWs += s.apps.websockets;
        if (s.microphone.enabled) micActive++;
      }

      const point: TimePoint = {
        time: new Date(),
        memory: {
          rss: mem.rss.bytes,
          heapTotal: mem.heapTotal.bytes,
          heapUsed: mem.heapUsed.bytes,
          external: mem.external.bytes,
          arrayBuffers: mem.arrayBuffers.bytes,
        },
        sessions: data.sessions.length,
        apps: totalApps,
        websockets: totalWs,
        audioBufferBytes: totalAudioBytes,
        vadBufferBytes: totalVadBytes,
        transcriptSegments: totalSegments,
        uptime: data.process.uptime,
        loadavg: data.process.loadavg,
        micActive,
      };

      history.push(point);
      const prev = history.length > 1 ? history[history.length - 2] : point;

      const line = `${rpad(timestamp(), 10)} ${pad(fmt(point.memory.rss), 10)} ${pad(delta(point.memory.rss, prev.memory.rss), 10)} ${pad(fmt(point.memory.heapUsed), 10)} ${pad(delta(point.memory.heapUsed, prev.memory.heapUsed), 10)} ${pad(fmt(point.memory.external), 10)} ${pad(fmt(point.memory.arrayBuffers), 10)} ${pad(String(point.sessions), 9)} ${pad(String(point.apps), 6)} ${pad(String(point.websockets), 6)} ${pad(fmt(point.audioBufferBytes), 10)} ${pad(fmt(point.vadBufferBytes), 10)} ${pad(String(point.transcriptSegments), 7)} ${pad(String(point.micActive), 5)} ${pad(Math.round(point.uptime) + "s", 8)} ${pad(point.loadavg[0].toFixed(1), 6)}`;

      console.log(line);

      // Detect crash (uptime reset)
      if (prev.uptime > 60 && point.uptime < prev.uptime) {
        console.log(
          `\n  🔴 POD RESTARTED — uptime went from ${Math.round(prev.uptime)}s to ${Math.round(point.uptime)}s\n`,
        );
      }

      // Warn if RSS is getting dangerous
      if (point.memory.rss > 900 * 1024 * 1024) {
        console.log(`  ⚠️  RSS > 900MB — crash likely imminent`);
      } else if (point.memory.rss > 700 * 1024 * 1024) {
        console.log(`  ⚠️  RSS > 700MB — elevated`);
      }
    } catch (err: any) {
      console.log(`${rpad(timestamp(), 10)} ❌ ${err.message?.slice(0, 80) ?? err}`);
    }
  }

  // Initial poll
  await poll();

  // Periodic polling
  const pollInterval = setInterval(poll, interval * 1000);

  // Duration limit
  if (duration > 0) {
    setTimeout(() => {
      clearInterval(pollInterval);
      printSummary(history);
      process.exit(0);
    }, duration * 1000);
  }

  // Handle Ctrl+C
  process.on("SIGINT", () => {
    clearInterval(pollInterval);
    console.log("\n");
    printSummary(history);
    process.exit(0);
  });

  // Keep alive
  await new Promise(() => {});
}

function printSummary(history: TimePoint[]) {
  if (history.length < 2) {
    console.log("Not enough data points for summary.");
    return;
  }

  const first = history[0];
  const last = history[history.length - 1];
  const durationMin = (last.time.getTime() - first.time.getTime()) / 60000;
  const rssGrowth = last.memory.rss - first.memory.rss;
  const heapGrowth = last.memory.heapUsed - first.memory.heapUsed;
  const rssRate = durationMin > 0 ? rssGrowth / durationMin : 0;
  const heapRate = durationMin > 0 ? heapGrowth / durationMin : 0;

  // Find peak values
  let peakRss = 0;
  let peakHeap = 0;
  let peakSessions = 0;
  let restarts = 0;

  for (let i = 0; i < history.length; i++) {
    const p = history[i];
    if (p.memory.rss > peakRss) peakRss = p.memory.rss;
    if (p.memory.heapUsed > peakHeap) peakHeap = p.memory.heapUsed;
    if (p.sessions > peakSessions) peakSessions = p.sessions;
    if (i > 0 && p.uptime < history[i - 1].uptime && history[i - 1].uptime > 60) {
      restarts++;
    }
  }

  // Estimate time to crash (extrapolate RSS to 1GB)
  const crashThreshold = 1024 * 1024 * 1024; // 1GB
  const timeToGb = rssRate > 0 ? (crashThreshold - last.memory.rss) / rssRate : Infinity;

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  SUMMARY");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Host:              ${host}`);
  console.log(`  Duration:          ${durationMin.toFixed(1)} minutes (${history.length} samples)`);
  console.log(`  Restarts detected: ${restarts}`);
  console.log();
  console.log(
    `  RSS:    ${fmt(first.memory.rss)} → ${fmt(last.memory.rss)}  (${delta(last.memory.rss, first.memory.rss)})`,
  );
  console.log(
    `  Heap:   ${fmt(first.memory.heapUsed)} → ${fmt(last.memory.heapUsed)}  (${delta(last.memory.heapUsed, first.memory.heapUsed)})`,
  );
  console.log(
    `  Ext:    ${fmt(first.memory.external)} → ${fmt(last.memory.external)}  (${delta(last.memory.external, first.memory.external)})`,
  );
  console.log(
    `  ArrBuf: ${fmt(first.memory.arrayBuffers)} → ${fmt(last.memory.arrayBuffers)}  (${delta(last.memory.arrayBuffers, first.memory.arrayBuffers)})`,
  );
  console.log();
  console.log(`  RSS growth rate:   ${fmt(Math.abs(rssRate))}/min${rssRate < 0 ? " (shrinking)" : ""}`);
  console.log(`  Heap growth rate:  ${fmt(Math.abs(heapRate))}/min${heapRate < 0 ? " (shrinking)" : ""}`);
  console.log(`  Peak RSS:          ${fmt(peakRss)}`);
  console.log(`  Peak Heap:         ${fmt(peakHeap)}`);
  console.log(`  Peak Sessions:     ${peakSessions}`);
  console.log();

  if (rssRate > 0 && timeToGb < Infinity && timeToGb > 0) {
    console.log(`  ⏱  Est. time to 1GB RSS: ${timeToGb.toFixed(0)} min (${(timeToGb / 60).toFixed(1)} hrs)`);
    console.log(`     At current growth rate, this pod will crash in ~${(timeToGb / 60).toFixed(1)} hours.`);
  } else if (rssRate <= 0) {
    console.log(`  ✅ RSS is stable or shrinking.`);
  }

  // Per-session memory cost
  const avgSessions = history.reduce((s, p) => s + p.sessions, 0) / history.length;
  if (avgSessions > 0) {
    const perSessionRss = last.memory.rss / last.sessions;
    const perSessionHeap = last.memory.heapUsed / last.sessions;
    console.log();
    console.log(`  Per-session (current, ${last.sessions} sessions):`);
    console.log(`    RSS/session:  ${fmt(perSessionRss)}`);
    console.log(`    Heap/session: ${fmt(perSessionHeap)}`);
  }

  // Unaccounted memory
  const accounted = last.memory.heapUsed + last.memory.external + last.memory.arrayBuffers;
  const unaccounted = last.memory.rss - accounted;
  console.log();
  console.log(`  Memory breakdown (current):`);
  console.log(
    `    Heap used:     ${fmt(last.memory.heapUsed)} (${((last.memory.heapUsed / last.memory.rss) * 100).toFixed(0)}%)`,
  );
  console.log(
    `    External:      ${fmt(last.memory.external)} (${((last.memory.external / last.memory.rss) * 100).toFixed(0)}%)`,
  );
  console.log(
    `    ArrayBuffers:  ${fmt(last.memory.arrayBuffers)} (${((last.memory.arrayBuffers / last.memory.rss) * 100).toFixed(0)}%)`,
  );
  console.log(
    `    Unaccounted:   ${fmt(unaccounted)} (${((unaccounted / last.memory.rss) * 100).toFixed(0)}%) — JIT, GC metadata, fragmentation`,
  );
  console.log();
}

// ---------------------------------------------------------------------------
// Mode: FETCH — grab a V8 heap snapshot and save it
// ---------------------------------------------------------------------------

async function modeFetch(): Promise<string> {
  console.log(`📸 Fetching heap snapshot from ${host}...`);

  // Use the Bun-native endpoint (JSC format)
  const res = await fetch(`${BASE_URL}/api/admin/memory/heap-snapshot-bun`, { headers: HEADERS });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.text();
  const filename = `${host.split(".")[0]}-${Date.now()}.json`;
  const filepath = `${outDir}/${filename}`;

  await Bun.write(filepath, data);
  const sizeMB = data.length / 1024 / 1024;
  console.log(`  Saved: ${filepath} (${sizeMB.toFixed(1)} MB)`);
  return filepath;
}

// ---------------------------------------------------------------------------
// Mode: SNAPSHOT — analyze a saved JSC snapshot
// ---------------------------------------------------------------------------

async function modeSnapshot() {
  const file = snapshotFile;
  if (!file) {
    console.error("Usage: analyze-heap.ts snapshot --file=<path>");
    process.exit(1);
  }

  console.log(`📂 Analyzing ${file}...`);
  const raw = await Bun.file(file).text();
  const data = JSON.parse(raw);

  if (data.version && data.nodes && data.nodeClassNames) {
    analyzeJscSnapshot(data);
  } else if (data.snapshot && data.nodes && data.edges && data.strings) {
    analyzeV8Snapshot(data);
  } else {
    console.error("Unknown snapshot format. Keys:", Object.keys(data).slice(0, 10));
  }
}

function analyzeJscSnapshot(data: any) {
  const nodes: number[] = data.nodes;
  const classNames: string[] = data.nodeClassNames;
  const edges: number[] = data.edges;

  // Find node stride (must evenly divide nodes.length)
  let nodeStride = 0;
  for (const s of [4, 6, 7, 5, 8]) {
    if (nodes.length % s === 0) {
      nodeStride = s;
      break;
    }
  }

  if (!nodeStride) {
    console.error("Could not determine node stride. nodes.length =", nodes.length);
    return;
  }

  const numEntries = nodes.length / nodeStride;
  console.log(`  Format: JSC Inspector v${data.version}`);
  console.log(`  Node stride: ${nodeStride}, entries: ${numEntries.toLocaleString()}`);
  console.log(`  Class names: ${classNames.length}`);
  console.log(`  Edge values: ${edges.length.toLocaleString()}`);
  console.log();

  // Count objects by class name
  // In the JSC format, not all entries have valid class indices at offset 0.
  // Valid class indices are 0..classNames.length-1.
  // We also check other offsets in case the format is different.

  const classCounts = new Map<string, number>();
  let validNodes = 0;

  // Try each offset to find which one gives the most valid class indices
  let bestOffset = 0;
  let bestValid = 0;

  for (let offset = 0; offset < nodeStride; offset++) {
    let valid = 0;
    for (let i = 0; i < numEntries; i++) {
      const val = nodes[i * nodeStride + offset];
      if (val >= 0 && val < classNames.length) valid++;
    }
    if (valid > bestValid) {
      bestValid = valid;
      bestOffset = offset;
    }
  }

  console.log(
    `  Best class index offset: ${bestOffset} (${bestValid.toLocaleString()} valid out of ${numEntries.toLocaleString()})`,
  );
  console.log();

  // Count using best offset
  for (let i = 0; i < numEntries; i++) {
    const ci = nodes[i * nodeStride + bestOffset];
    if (ci >= 0 && ci < classNames.length) {
      const cls = classNames[ci];
      classCounts.set(cls, (classCounts.get(cls) || 0) + 1);
      validNodes++;
    }
  }

  // Sort by count
  const sorted = [...classCounts.entries()].sort((a, b) => b[1] - a[1]);

  console.log(`OBJECT COUNTS (${validNodes.toLocaleString()} objects with valid class names):`);
  console.log();
  console.log(`${rpad("Class", 45)} ${pad("Count", 10)} ${pad("% of total", 10)}`);
  console.log("─".repeat(68));

  for (let i = 0; i < Math.min(50, sorted.length); i++) {
    const [cls, count] = sorted[i];
    const pct = ((count / validNodes) * 100).toFixed(1);
    console.log(`${rpad(cls.slice(0, 44), 45)} ${pad(count.toLocaleString(), 10)} ${pad(pct + "%", 10)}`);
  }

  // Session-related objects
  const sessionKeywords = [
    "session",
    "socket",
    "audio",
    "buffer",
    "stream",
    "transcript",
    "pino",
    "manager",
    "display",
    "soniox",
    "timeout",
    "websocket",
    "user",
    "calendar",
    "device",
    "microphone",
    "translation",
    "transcription",
    "dashboard",
    "streaming",
    "registry",
    "subscription",
    "livekit",
    "location",
    "timer",
  ];

  const sessionClasses = sorted.filter(([cls]) => sessionKeywords.some((kw) => cls.toLowerCase().includes(kw)));

  if (sessionClasses.length > 0) {
    console.log();
    console.log("SESSION-RELATED OBJECTS:");
    console.log("─".repeat(68));
    for (const [cls, count] of sessionClasses) {
      console.log(`  ${rpad(cls, 45)} ${pad(count.toLocaleString(), 10)}`);
    }
  }

  console.log();
  console.log("⚠️  JSC snapshot format does not expose reliable per-object sizes via CLI.");
  console.log("   Object counts above are accurate. For size analysis, use 'live' mode instead.");
  console.log("   Or open this file in Safari Web Inspector (Develop → Import Recording).");
}

function analyzeV8Snapshot(_data: any) {
  console.log("V8 format detected. Open this file in Chrome DevTools → Memory → Load.");
  console.log("Chrome will show retained sizes, dominator tree, and allocation details.");
}

// ---------------------------------------------------------------------------
// Mode: COMPARE — two snapshots with a delay, diff the counts
// ---------------------------------------------------------------------------

async function modeCompare() {
  console.log(`🔄 Compare mode — will take two snapshots ${delaySeconds}s apart`);
  console.log();

  // Snapshot 1: just get memory/now
  console.log("📸 Snapshot 1...");
  const snap1 = await fetchJson<MemorySnapshot>(`${BASE_URL}/api/admin/memory/now`);
  const health1 = await fetchJson<HealthInfo>(`${BASE_URL}/health`);

  console.log(`  RSS: ${snap1.process.memory.rss.human}, Heap: ${snap1.process.memory.heapUsed.human}`);
  console.log(`  Sessions: ${snap1.sessions.length}, Uptime: ${Math.round(snap1.process.uptime)}s`);
  console.log();

  console.log(`⏳ Waiting ${delaySeconds}s...`);
  await Bun.sleep(delaySeconds * 1000);

  // Snapshot 2
  console.log("📸 Snapshot 2...");
  const snap2 = await fetchJson<MemorySnapshot>(`${BASE_URL}/api/admin/memory/now`);
  const health2 = await fetchJson<HealthInfo>(`${BASE_URL}/health`);

  console.log(`  RSS: ${snap2.process.memory.rss.human}, Heap: ${snap2.process.memory.heapUsed.human}`);
  console.log(`  Sessions: ${snap2.sessions.length}, Uptime: ${Math.round(snap2.process.uptime)}s`);
  console.log();

  // Check for restart
  if (snap2.process.uptime < snap1.process.uptime) {
    console.log("🔴 POD RESTARTED between snapshots. Comparison invalid.");
    return;
  }

  const m1 = snap1.process.memory;
  const m2 = snap2.process.memory;

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  MEMORY DELTA");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  Time between:   ${delaySeconds}s`);
  console.log(
    `  Sessions:       ${snap1.sessions.length} → ${snap2.sessions.length} (${deltaNum(snap2.sessions.length, snap1.sessions.length)})`,
  );
  console.log();
  console.log(`  RSS:            ${m1.rss.human} → ${m2.rss.human} (${delta(m2.rss.bytes, m1.rss.bytes)})`);
  console.log(
    `  Heap used:      ${m1.heapUsed.human} → ${m2.heapUsed.human} (${delta(m2.heapUsed.bytes, m1.heapUsed.bytes)})`,
  );
  console.log(
    `  External:       ${m1.external.human} → ${m2.external.human} (${delta(m2.external.bytes, m1.external.bytes)})`,
  );
  console.log(
    `  ArrayBuffers:   ${m1.arrayBuffers.human} → ${m2.arrayBuffers.human} (${delta(m2.arrayBuffers.bytes, m1.arrayBuffers.bytes)})`,
  );
  console.log();

  const rssGrowth = m2.rss.bytes - m1.rss.bytes;
  const ratePerMin = (rssGrowth / delaySeconds) * 60;
  console.log(`  RSS growth rate: ${fmt(Math.abs(ratePerMin))}/min${ratePerMin < 0 ? " (shrinking)" : ""}`);

  if (ratePerMin > 0) {
    const crashThreshold = 1024 * 1024 * 1024;
    const remaining = crashThreshold - m2.rss.bytes;
    const minsToCrash = remaining / ratePerMin;
    console.log(`  Est. time to 1GB: ${minsToCrash.toFixed(0)} min (${(minsToCrash / 60).toFixed(1)} hrs)`);
  }

  // Per-session comparison
  console.log();
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  PER-SESSION DETAILS");
  console.log("═══════════════════════════════════════════════════════════════");

  // Find sessions that exist in both snapshots
  const sessions1 = new Map(snap1.sessions.map((s) => [s.userId, s]));
  const sessions2 = new Map(snap2.sessions.map((s) => [s.userId, s]));

  const allUsers = new Set([...sessions1.keys(), ...sessions2.keys()]);
  const persistent = [...allUsers].filter((u) => sessions1.has(u) && sessions2.has(u));
  const newSessions = [...allUsers].filter((u) => !sessions1.has(u) && sessions2.has(u));
  const goneSessions = [...allUsers].filter((u) => sessions1.has(u) && !sessions2.has(u));

  console.log(`  Persistent sessions: ${persistent.length}`);
  console.log(`  New sessions:        ${newSessions.length}`);
  console.log(`  Gone sessions:       ${goneSessions.length}`);

  if (persistent.length > 0) {
    console.log();
    console.log("  Persistent session changes:");
    console.log(
      `  ${rpad("User", 35)} ${pad("Δ Audio", 12)} ${pad("Δ VAD", 12)} ${pad("Δ Segments", 12)} ${pad("Δ Apps", 8)}`,
    );
    console.log("  " + "─".repeat(82));

    for (const userId of persistent) {
      const s1 = sessions1.get(userId)!;
      const s2 = sessions2.get(userId)!;

      const dAudio =
        s2.audio.recentBufferBytes +
        s2.audio.orderedBufferBytes -
        (s1.audio.recentBufferBytes + s1.audio.orderedBufferBytes);
      const dVad = s2.transcription.vadBufferBytes - s1.transcription.vadBufferBytes;
      const dSeg = s2.transcription.transcriptSegments - s1.transcription.transcriptSegments;
      const dApps = s2.apps.running - s1.apps.running;

      // Only show if something changed
      if (dAudio !== 0 || dVad !== 0 || dSeg !== 0 || dApps !== 0) {
        console.log(
          `  ${rpad(userId.slice(0, 34), 35)} ${pad(delta(0, -dAudio), 12)} ${pad(delta(0, -dVad), 12)} ${pad(deltaNum(s2.transcription.transcriptSegments, s1.transcription.transcriptSegments), 12)} ${pad(deltaNum(s2.apps.running, s1.apps.running), 8)}`,
        );
      }
    }
  }

  console.log();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log();
switch (mode) {
  case "live":
    await modeLive();
    break;
  case "fetch":
    await modeFetch();
    break;
  case "snapshot":
    await modeSnapshot();
    break;
  case "compare":
    await modeCompare();
    break;
  default:
    console.log("Unknown mode:", mode);
    console.log("Modes: live, fetch, snapshot, compare");
    process.exit(1);
}
