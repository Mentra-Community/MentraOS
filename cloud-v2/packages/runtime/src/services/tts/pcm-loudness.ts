/**
 * @fileoverview Loudness for streamed PCM speech.
 *
 * ElevenLabs' default voice (eleven_flash_v2_5, our voice settings) streams at
 * about -29.7 LUFS with peaks near -10 dBFS: some 10 dB below a YouTube
 * podcast. Mentra Live's 3.4 BES no longer levels sources with the amplifier's
 * AGC, so that gap is heard as Mentra AI being much quieter than other apps.
 * The runtime raises its speech to about -19 LUFS, the level chosen by ear
 * against a YouTube podcast on Mentra Live, with a look-ahead limiter holding
 * the few peaks it pushes past the ceiling.
 */

/** Gain bringing the default voice from -29.7 to about -19 LUFS. */
export const SPEECH_GAIN_DB = 10.8;

/** The limiter's ceiling: -1.5 dBFS, headroom for the phone's A2DP encoder. */
const CEILING = 10 ** (-1.5 / 20);
/** About 1.5 ms of look-ahead at 24 kHz, the delay the limiter adds. */
const LOOKAHEAD = 36;
/** Gain recovery per sample: a 60 ms release at 24 kHz. */
const RELEASE = 1 - Math.exp(-1 / (0.06 * 24000));

/**
 * Raises signed 16-bit little-endian mono PCM by `gainDb`, limiting peaks to the
 * ceiling. Chunks may split a sample; the odd byte waits for the next chunk.
 */
export function pcmSpeechLoudness(gainDb: number = SPEECH_GAIN_DB): TransformStream<Uint8Array, Uint8Array> {
  const gain = 10 ** (gainDb / 20);
  // The last LOOKAHEAD gained samples, oldest first, waiting to be output.
  const pending = new Float32Array(LOOKAHEAD);
  let filled = 0;
  let head = 0;
  let envelope = 1;
  let carry: number | null = null;

  const run = (input: Float32Array, output: Int16Array): number => {
    let written = 0;
    for (let i = 0; i < input.length; i++) {
      const incoming = input[i];
      if (filled < LOOKAHEAD) {
        pending[(head + filled++) % LOOKAHEAD] = incoming;
        continue;
      }
      const sample = pending[head];
      pending[head] = incoming;
      head = (head + 1) % LOOKAHEAD;
      output[written++] = limit(sample);
    }
    return written;
  };

  // Gain for the oldest pending sample: low enough for every sample in the window, reached
  // within the window, so the limiter is already down when a peak arrives.
  const limit = (sample: number): number => {
    let peak = Math.abs(sample);
    for (let k = 0; k < filled; k++) peak = Math.max(peak, Math.abs(pending[(head + k) % LOOKAHEAD]));
    const target = peak > CEILING ? CEILING / peak : 1;
    envelope = target < envelope ? envelope + (target - envelope) / 4 : envelope + (target - envelope) * RELEASE;
    const out = Math.max(-CEILING, Math.min(CEILING, sample * envelope));
    return Math.round(out * 32767);
  };

  const toFloat = (bytes: Uint8Array): Float32Array => {
    let data = bytes;
    if (carry !== null) {
      data = new Uint8Array(bytes.length + 1);
      data[0] = carry;
      data.set(bytes, 1);
      carry = null;
    }
    if (data.length % 2 === 1) {
      carry = data[data.length - 1];
      data = data.subarray(0, data.length - 1);
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const samples = new Float32Array(data.length / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = (view.getInt16(i * 2, true) / 32768) * gain;
    return samples;
  };

  const toBytes = (samples: Int16Array, count: number): Uint8Array => {
    const bytes = new Uint8Array(count * 2);
    const view = new DataView(bytes.buffer);
    for (let i = 0; i < count; i++) view.setInt16(i * 2, samples[i], true);
    return bytes;
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const input = toFloat(chunk);
      const output = new Int16Array(input.length);
      const count = run(input, output);
      if (count > 0) controller.enqueue(toBytes(output, count));
    },
    flush(controller) {
      const output = new Int16Array(filled);
      let count = 0;
      while (filled > 0) {
        const sample = pending[head];
        head = (head + 1) % LOOKAHEAD;
        filled--;
        output[count++] = limit(sample);
      }
      if (count > 0) controller.enqueue(toBytes(output, count));
    },
  });
}
