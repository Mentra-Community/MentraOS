import { describe, expect, test } from "bun:test";

import { pcmSpeechLoudness, SPEECH_GAIN_DB } from "./pcm-loudness";

const CEILING = Math.round(10 ** (-1.5 / 20) * 32767);

function pcm(samples: number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((s, i) => view.setInt16(i * 2, s, true));
  return bytes;
}

function samplesOf(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: bytes.length / 2 }, (_, i) => view.getInt16(i * 2, true));
}

async function run(chunks: Uint8Array[], gainDb?: number): Promise<Uint8Array> {
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  return new Uint8Array(await new Response(input.pipeThrough(pcmSpeechLoudness(gainDb))).arrayBuffer());
}

describe("pcmSpeechLoudness", () => {
  test("raises quiet speech by the gain, sample for sample", async () => {
    const input = Array.from({ length: 200 }, (_, i) => Math.round(1000 * Math.sin(i / 5)));
    const out = samplesOf(await run([pcm(input)]));
    const gain = 10 ** (SPEECH_GAIN_DB / 20);
    expect(out).toHaveLength(input.length);
    out.forEach((s, i) => expect(Math.abs(s - (input[i] / 32768) * gain * 32767)).toBeLessThanOrEqual(1));
  });

  test("never lets a raised peak past the ceiling", async () => {
    const input = Array.from({ length: 4800 }, (_, i) => Math.round(20000 * Math.sin(i / 3)));
    const out = samplesOf(await run([pcm(input)]));
    expect(Math.max(...out.map(Math.abs))).toBeLessThanOrEqual(CEILING);
    expect(Math.max(...out.map(Math.abs))).toBeGreaterThan(CEILING * 0.9);
  });

  test("gives the same samples however the stream is split, odd bytes included", async () => {
    const bytes = pcm(Array.from({ length: 999 }, (_, i) => Math.round(9000 * Math.sin(i / 7))));
    const whole = await run([bytes]);
    const split = await run([bytes.subarray(0, 1), bytes.subarray(1, 77), bytes.subarray(77, 1001), bytes.subarray(1001)]);
    expect(split).toEqual(whole);
    expect(whole).toHaveLength(bytes.length);
  });

  test("passes a stream shorter than the look-ahead through on flush", async () => {
    expect(samplesOf(await run([pcm([100, -100, 50])], 0))).toEqual([100, -100, 50]);
  });
});
