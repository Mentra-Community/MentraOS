import fs from "fs";
import path from "path";

function readWav(p: string) {
  const buf = fs.readFileSync(p);
  if (
    buf.toString("ascii", 0, 4) !== "RIFF" ||
    buf.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error("Not a WAV file");
  }
  const fmtIndex = buf.indexOf(Buffer.from("fmt "), 12);
  if (fmtIndex < 0) throw new Error("fmt chunk not found");
  const audioFormat = buf.readUInt16LE(fmtIndex + 8);
  const channels = buf.readUInt16LE(fmtIndex + 10);
  const sampleRate = buf.readUInt32LE(fmtIndex + 12);
  const bitsPerSample = buf.readUInt16LE(fmtIndex + 22);
  const dataIndex = buf.indexOf(Buffer.from("data"), fmtIndex + 24);
  if (dataIndex < 0) throw new Error("data chunk not found");
  const dataSize = buf.readUInt32LE(dataIndex + 4);
  const pcmStart = dataIndex + 8;
  const pcm = buf.subarray(pcmStart, pcmStart + dataSize);
  return { audioFormat, channels, sampleRate, bitsPerSample, pcm };
}

function analyzePcm16Mono(pcm: Buffer, sampleRate: number) {
  const samples = new Int16Array(
    pcm.buffer,
    pcm.byteOffset,
    Math.floor(pcm.byteLength / 2),
  );
  let sumSq = 0;
  let sum = 0;
  let min = 32767;
  let max = -32768;
  let clips = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i];
    sumSq += v * v;
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
    if (v === 32767 || v === -32768) clips++;
  }
  const mean = sum / samples.length;
  const rms = Math.sqrt(sumSq / samples.length);
  // Frequency estimate via positive-going zero crossings
  const crossings: number[] = [];
  let prev = samples[0];
  for (let i = 1; i < samples.length; i++) {
    const cur = samples[i];
    if (prev < 0 && cur >= 0) crossings.push(i);
    prev = cur;
  }
  let freq = 0;
  if (crossings.length > 1) {
    let sumPeriod = 0;
    let count = 0;
    for (let i = 1; i < crossings.length; i++) {
      const period = crossings[i] - crossings[i - 1];
      if (period > 0) {
        sumPeriod += period;
        count++;
      }
    }
    const meanPeriod = sumPeriod / Math.max(1, count);
    if (meanPeriod > 0) freq = sampleRate / meanPeriod;
  }
  // Rough static indicator: proportion of large inter-sample jumps
  let bigJumps = 0;
  for (let i = 1; i < samples.length; i++) {
    const dv = Math.abs(samples[i] - samples[i - 1]);
    if (dv > 20000) bigJumps++;
  }
  const jumpRatio = bigJumps / samples.length;
  return { count: samples.length, rms, mean, min, max, clips, freq, jumpRatio };
}

async function main() {
  const input = process.env.ANALYZE_WAV || "diagnose-subscriber.wav";
  const wavPath = path.resolve(process.cwd(), input);
  const { audioFormat, channels, sampleRate, bitsPerSample, pcm } =
    readWav(wavPath);
  if (audioFormat !== 1) throw new Error(`Unsupported format: ${audioFormat}`);
  if (bitsPerSample !== 16)
    throw new Error(`Expected 16-bit PCM, got ${bitsPerSample}`);
  if (channels !== 1) throw new Error(`Expected mono, got ${channels}`);
  const res = analyzePcm16Mono(pcm, sampleRate);
  console.log("\n—— WAV Analysis ——");
  console.log("Path        :", wavPath);
  console.log("SampleRate  :", sampleRate);
  console.log("Channels    :", channels);
  console.log("Bits        :", bitsPerSample);
  console.log("Samples     :", res.count);
  console.log("RMS         :", res.rms.toFixed(1));
  console.log("Mean        :", res.mean.toFixed(1));
  console.log("Peak(min/max):", res.min, res.max);
  console.log("Clipped     :", res.clips);
  console.log("Freq (est)  :", res.freq.toFixed(2), "Hz");
  console.log("BigJumpRatio:", (res.jumpRatio * 100).toFixed(4), "%");
}

main().catch((e) => {
  console.error("Analyze failed:", e);
  process.exit(1);
});
