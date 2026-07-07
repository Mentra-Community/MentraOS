#!/usr/bin/env bun
/**
 * Headless translation/transcription e2e harness — no phone required.
 *
 * Drives the SAME code path the mobile app uses (`@mentra/cloud-client/node`):
 * mint an OEM JWT at the dev-stack's test-oem, exchange it at core, open the
 * runtime WebSocket, PUT the audio subscriptions, then stream PCM from laptop
 * TTS (`say`) over encrypted UDP and print every transcript/translation push.
 *
 * This exists for fast iteration on the cloud side: a run takes seconds and a
 * failure points at the exact stage (mint, exchange, handshake, subscription
 * write, audio feed, provider result, WS push) instead of "nothing showed up
 * in the app". Once this passes, the only untested layers are the RN
 * transports and the miniapp UI.
 *
 * Examples:
 *   bun scripts/translation-e2e.ts
 *   bun scripts/translation-e2e.ts --kind transcription --text "hello world"
 *   bun scripts/translation-e2e.ts --target fr --user harness-2 --timeout 90
 */
import { CloudClient } from "../packages/cloud-client/node/index";
import type { AudioSubscription } from "../packages/runtime/src/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = parseArgs(Bun.argv.slice(2));
const HOST = args.host ?? "127.0.0.1";
const CORE_URL = args["core-url"] ?? `http://${HOST}:3000`;
const RUNTIME_URL = args["runtime-url"] ?? `http://${HOST}:3001`;
const TEST_OEM_URL = args["test-oem-url"] ?? `http://${HOST}:3102`;
const USER = args.user ?? "translation-harness";
const KIND = args.kind === "transcription" ? "transcription" : "translation";
const TARGET = args.target ?? "es";
const TEXT =
  args.text ??
  "Hello my friend. How are you doing today? I would like a coffee with milk. Where is the train station, please?";
const TIMEOUT_S = Number(args.timeout ?? 60);

// 16 kHz mono s16le; 50 ms per UDP packet keeps datagrams small (1600 B) and
// the pacing realistic so the provider treats it like live speech.
const SAMPLE_RATE = 16_000;
const FRAME_MS = 50;
const FRAME_BYTES = (SAMPLE_RATE / 1000) * FRAME_MS * 2;

const subscription: AudioSubscription =
  KIND === "transcription"
    ? { kind: "transcription", language: { mode: "auto" } }
    : { kind: "translation", source: { mode: "auto" }, target: TARGET };

console.log(`[e2e] user=${USER} sub=${JSON.stringify(subscription)}`);

// --- 1. auth: mint OEM JWT (the client exchanges it at core itself) ---------
const mint = await fetch(`${TEST_OEM_URL}/test-oem/mint-jwt`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ tenantUserId: USER }),
});
if (!mint.ok) throw new Error(`[e2e] mint-jwt failed: ${mint.status} ${await mint.text()}`);
const { jwt } = (await mint.json()) as { jwt: string };
console.log("[e2e] minted OEM JWT");

// --- 2. client + connect -----------------------------------------------------
const cloud = new CloudClient({
  endpoints: { core: CORE_URL, runtime: RUNTIME_URL },
  auth: { subjectToken: jwt, subjectTokenType: "oem-jwt" },
  audio: { codec: "pcm", sampleRate: SAMPLE_RATE },
  logger: {
    debug: () => {},
    info: (msg, fields) => console.log(`[client] ${msg}`, fields ?? ""),
    warn: (msg, fields) => console.warn(`[client] WARN ${msg}`, fields ?? ""),
    error: (msg, fields) => console.error(`[client] ERROR ${msg}`, fields ?? ""),
  },
});

let sawFinal = false;
cloud.runtime.onTranscript((d) => {
  console.log(`[transcript${d.isFinal ? " FINAL" : ""}] ${d.text}`);
  if (KIND === "transcription" && d.isFinal && d.text.trim()) sawFinal = true;
});
cloud.runtime.onTranslation((d) => {
  console.log(`[translation${d.isFinal ? " FINAL" : ""}] ${JSON.stringify(d)}`);
  if (KIND === "translation" && d.isFinal) sawFinal = true;
});
cloud.runtime.onError((err) => console.error("[e2e] protocol error:", err));
cloud.runtime.onDisconnected((info) => console.warn("[e2e] disconnected:", info.reason));

cloud.runtime.onStatusChanged((s) => console.log("[e2e] status:", JSON.stringify(s)));
await cloud.runtime.connect();
console.log("[e2e] connected");

await cloud.runtime.setSubscriptions([subscription]);
console.log("[e2e] subscriptions applied");

// --- 3. TTS -> PCM -----------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), "mentra-tts-"));
const wavPath = join(dir, "tts.wav");
await run("say", ["--file-format=WAVE", "--data-format=LEI16@16000", "-o", wavPath, TEXT]);
const pcm = readWavData(new Uint8Array(await Bun.file(wavPath).arrayBuffer()));
console.log(`[e2e] TTS rendered: ${(pcm.length / 2 / SAMPLE_RATE).toFixed(1)}s of audio`);

// --- 4. stream at real-time pace, with trailing silence so the provider
// finalizes the last utterance ------------------------------------------------
const silence = new Uint8Array(FRAME_BYTES);
const deadline = Date.now() + TIMEOUT_S * 1000;
let offset = 0;
let sent = 0;
while (Date.now() < deadline && !sawFinal) {
  const frame =
    offset < pcm.length
      ? pcm.subarray(offset, Math.min(offset + FRAME_BYTES, pcm.length))
      : silence;
  offset += FRAME_BYTES;
  cloud.runtime.sendAudioFrame(frame);
  sent += 1;
  if (sent % 100 === 0) console.log(`[e2e] sent ${sent} frames (${(sent * FRAME_MS) / 1000}s)`);
  await sleep(FRAME_MS);
}

// Give the final push a moment to arrive after the last frame.
const settle = Date.now() + 5_000;
while (Date.now() < settle && !sawFinal) await sleep(200);

cloud.runtime.close();
if (sawFinal) {
  console.log(`[e2e] PASS: received final ${KIND} result`);
  process.exit(0);
}
console.error(`[e2e] FAIL: no final ${KIND} result within ${TIMEOUT_S}s`);
process.exit(1);

// --- helpers -----------------------------------------------------------------

/** Extract the `data` chunk payload from a RIFF/WAVE file (LEI16 mono). */
function readWavData(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 4) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }
  let pos = 12;
  while (pos + 8 <= bytes.length) {
    const id = ascii(bytes, pos, 4);
    const size = view.getUint32(pos + 4, true);
    if (id === "data") return bytes.subarray(pos + 8, pos + 8 + size);
    pos += 8 + size + (size % 2);
  }
  throw new Error("WAVE file has no data chunk");
}

function ascii(bytes: Uint8Array, start: number, len: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + len));
}

async function run(command: string, argv: string[]): Promise<void> {
  const proc = Bun.spawn([command, ...argv], { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`${command} failed (${code}): ${await new Response(proc.stderr).text()}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv: string[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq > 2) {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) out[arg.slice(2)] = "true";
    else {
      out[arg.slice(2)] = next;
      i += 1;
    }
  }
  return out;
}
