/**
 * @fileoverview Real Soniox transcription + translation integration test.
 *
 * This is the only test that hits the real Soniox API, so it is gated on
 * `SONIOX_API_KEY` (run it with `doppler run -- bun test tests/soniox.integration.test.ts`,
 * which injects the key from the cloud-v2 dev config). When the key is absent
 * the whole suite skips, so the default offline `bun test` stays free and green.
 *
 * It generates real speech audio on the fly with macOS `say` + `afconvert`
 * (16 kHz mono signed-16 PCM, exactly what the provider expects), feeds it to
 * the SonioxProvider, and asserts a real transcript comes back, and for the
 * translation case, real Spanish.
 */
import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSonioxProvider,
  type CreateSonioxProviderOptions,
} from "../packages/runtime/src/services/audio/providers/soniox";
import type {
  TranscriptEvent,
  TranscriptionProvider,
} from "../packages/runtime/src/services/audio/providers/provider";

const HAS_KEY = !!process.env.SONIOX_API_KEY;
const HAS_SAY = existsSync("/usr/bin/say") && existsSync("/usr/bin/afconvert");
const RUN = HAS_KEY && HAS_SAY;

if (!RUN) {
  // Make the skip reason visible so it's obvious why nothing ran.
  console.log(
    `[soniox.integration] skipped (SONIOX_API_KEY=${HAS_KEY ? "set" : "missing"}, say/afconvert=${HAS_SAY ? "present" : "missing"}). Run with: doppler run -- bun test tests/soniox.integration.test.ts`,
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** macOS `say` -> 16 kHz mono signed-16 PCM, returned as an Int16Array. */
function generateSpeechPcm(phrase: string): Int16Array {
  const stamp = `${process.pid}-${phrase.replace(/\W+/g, "").slice(0, 12)}`;
  const aiff = join(tmpdir(), `mentra-say-${stamp}.aiff`);
  const wav = join(tmpdir(), `mentra-say-${stamp}.wav`);

  const say = Bun.spawnSync(["/usr/bin/say", "-o", aiff, phrase]);
  if (say.exitCode !== 0) throw new Error(`say failed: ${say.stderr}`);

  // -d LEI16@16000: little-endian signed 16-bit @ 16 kHz; -c 1: mono; WAVE container.
  const conv = Bun.spawnSync([
    "/usr/bin/afconvert", aiff, wav, "-d", "LEI16@16000", "-c", "1", "-f", "WAVE",
  ]);
  if (conv.exitCode !== 0) throw new Error(`afconvert failed: ${conv.stderr}`);

  const buf = readFileSync(wav);
  // Find the "data" chunk and read the PCM that follows it.
  const dataIdx = buf.indexOf("data");
  if (dataIdx < 0) throw new Error("no data chunk in WAV");
  const pcmStart = dataIdx + 8; // skip "data" + 4-byte size
  const pcmBytes = buf.subarray(pcmStart);
  // Align to Int16.
  const usable = pcmBytes.byteLength - (pcmBytes.byteLength % 2);
  return new Int16Array(
    pcmBytes.buffer,
    pcmBytes.byteOffset,
    usable / 2,
  );
}

/**
 * Stream PCM to a provider at ~2x realtime, then finish and let final results
 * settle. Returns the longest transcript text seen across all events (robust
 * to the interim/final timing of streaming STT).
 */
async function transcribe(
  pcm: Int16Array,
  opts: Omit<CreateSonioxProviderOptions, "onTranscript" | "scope">,
): Promise<{ best: string; events: TranscriptEvent[] }> {
  const events: TranscriptEvent[] = [];
  const provider: TranscriptionProvider = await createSonioxProvider({
    scope: "test",
    onTranscript: (e) => events.push(e),
    ...opts,
  });

  const CHUNK = 1600; // 100 ms at 16 kHz
  for (let i = 0; i < pcm.length; i += CHUNK) {
    provider.writeAudio(pcm.subarray(i, i + CHUNK));
    await sleep(50);
  }
  await provider.close(); // finish() flushes final results
  await sleep(1500); // let any trailing result events land

  const best = events.reduce((a, e) => (e.text.length > a.length ? e.text : a), "");
  return { best, events };
}

let pcmEn: Int16Array;

beforeAll(() => {
  if (!RUN) return;
  pcmEn = generateSpeechPcm("the quick brown fox jumps over the lazy dog");
});

describe.skipIf(!RUN)("Soniox (real API)", () => {
  test("captions: transcribes English speech", async () => {
    const { best } = await transcribe(pcmEn, { language: "en" });
    console.log(`[soniox.integration] caption: "${best}"`);
    const low = best.toLowerCase();
    expect(best.length).toBeGreaterThan(0);
    // robust word checks, not an exact match (STT punctuation/casing varies)
    expect(low).toContain("quick");
    expect(low).toContain("fox");
  }, 40_000);

  test("translation: English speech -> Spanish text", async () => {
    const { best } = await transcribe(pcmEn, { language: "en", targetLanguage: "es" });
    console.log(`[soniox.integration] translation: "${best}"`);
    expect(best.length).toBeGreaterThan(0);
    // It should be Spanish, not the English source. Assert at least one
    // expected Spanish word shows up (zorro = fox, perro = dog, rápido = quick).
    const low = best.toLowerCase();
    expect(low).toMatch(/zorro|perro|r[áa]pido|salta|perezoso/);
  }, 40_000);
});

afterEach(async () => {
  // give sessions a moment to fully close between tests
  if (RUN) await sleep(250);
});
