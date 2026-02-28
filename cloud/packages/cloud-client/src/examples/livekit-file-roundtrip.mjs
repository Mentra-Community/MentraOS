import { setTimeout as delay } from 'timers/promises';
import fs from 'fs';
import path from 'path';

function parseWav(wavData) {
  if (wavData.toString('ascii', 0, 4) !== 'RIFF') throw new Error('Not RIFF');
  if (wavData.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Not WAVE');
  const fmtIndex = wavData.indexOf(Buffer.from('fmt '), 12);
  if (fmtIndex < 0) throw new Error('fmt chunk missing');
  const audioFormat = wavData.readUInt16LE(fmtIndex + 8);
  const channels = wavData.readUInt16LE(fmtIndex + 10);
  const sampleRate = wavData.readUInt32LE(fmtIndex + 12);
  const bitsPerSample = wavData.readUInt16LE(fmtIndex + 22);
  const dataIndex = wavData.indexOf(Buffer.from('data'), fmtIndex + 24);
  if (dataIndex < 0) throw new Error('data chunk missing');
  const dataSize = wavData.readUInt32LE(dataIndex + 4);
  const pcmStart = dataIndex + 8;
  const pcm = wavData.subarray(pcmStart, pcmStart + dataSize);
  if (audioFormat !== 1 || bitsPerSample !== 16) throw new Error('Expected PCM16');
  return { sampleRate, channels, bits: bitsPerSample, pcm };
}

function stereoToMono(pcm) {
  const mono = Buffer.allocUnsafe(pcm.length / 2);
  for (let i = 0, j = 0; i < pcm.length; i += 4, j += 2) {
    const left = pcm.readInt16LE(i);
    const right = pcm.readInt16LE(i + 2);
    mono.writeInt16LE(((left + right) / 2) | 0, j);
  }
  return mono;
}

function resampleLinear(pcm, fromRate, toRate) {
  if (fromRate === toRate) return pcm;
  const ratio = fromRate / toRate;
  const inSamples = pcm.length / 2;
  const outSamples = Math.round(inSamples / ratio);
  const out = Buffer.allocUnsafe(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const srcIndex = i * ratio;
    const i1 = Math.floor(srcIndex);
    const i2 = Math.min(i1 + 1, inSamples - 1);
    const s1 = pcm.readInt16LE(i1 * 2);
    const s2 = pcm.readInt16LE(i2 * 2);
    const frac = srcIndex - Math.floor(srcIndex);
    const val = Math.round(s1 + (s2 - s1) * frac);
    out.writeInt16LE(val, i * 2);
  }
  return out;
}

function buildWavFile(pcm16, sampleRate, channels) {
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm16.length;
  const headerSize = 44;
  const fileSize = headerSize - 8 + dataSize;
  const header = Buffer.alloc(headerSize);
  header.write('RIFF', 0);
  header.writeUInt32LE(fileSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return Buffer.concat([header, pcm16]);
}

async function run() {
  const server = process.env.SERVER_URL || 'http://localhost:8002';
  const email = process.env.TEST_EMAIL || 'user@example.com';
  const serverHttp = server.replace(/^ws/, 'http');
  const inputRel = process.env.INPUT_WAV || 'src/audio/short-test-16khz.wav';
  const outputRel = process.env.OUT_WAV || 'roundtrip-subscriber.wav';

  console.log('🎬 LiveKit File Roundtrip');
  console.log('- Server:', serverHttp);
  console.log('- Room  :', email);
  console.log('- InWAV :', inputRel);
  console.log('- OutWAV:', outputRel);

  // Mint tokens
  const pubIdentity = `file-publisher:${email}`;
  const subIdentity = `file-subscriber:${email}`;
  async function mint(mode, identity) {
    const res = await fetch(`${serverHttp}/api/livekit/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity, roomName: email, mode, ttlSeconds: 1800 }),
    });
    if (!res.ok) throw new Error(`Token mint failed: ${res.status}`);
    return res.json();
  }
  const [{ url, token: pubToken }, { token: subToken }] = await Promise.all([
    mint('publish', pubIdentity),
    mint('subscribe', subIdentity),
  ]);

  // Load input WAV and prep to 48k mono
  const inputPath = path.resolve(process.cwd(), inputRel);
  const wavBuf = fs.readFileSync(inputPath);
  const parsed = parseWav(wavBuf);
  let mono = parsed.channels === 1 ? parsed.pcm : stereoToMono(parsed.pcm);
  const pcm48 = parsed.sampleRate === 48000 ? mono : resampleLinear(mono, parsed.sampleRate, 48000);
  const totalFrames = Math.floor(pcm48.length / 2);
  console.log(`InWAV parsed: ${parsed.sampleRate} Hz, ch=${parsed.channels}, samples=${totalFrames}`);

  // Subscriber
  const { Room, AudioStream, RoomEvent, TrackKind, AudioSource, LocalAudioTrack, TrackSource } = await import('@livekit/rtc-node');
  const subRoom = new Room();
  await subRoom.connect(url, subToken, { autoSubscribe: true, timeout: 15000 });
  console.log('🎧 Subscriber connected');

  let receivedBuffers = [];
  let recvSamples = 0;
  const subReady = new Promise((resolve) => {
    subRoom.on(RoomEvent.TrackSubscribed, async (track, _pub, participant) => {
      if (track.kind !== TrackKind.KIND_AUDIO) return;
      console.log('🎙️  Subscribed to audio from', participant.identity);
      const stream = new AudioStream(track);
      for await (const frame of stream) {
        const sr = frame.sampleRate ?? 48000;
        const ch = frame.channels ?? frame.channelCount ?? 1;
        const dataAny = frame.data ?? frame.data;
        let monoInt16;
        if (dataAny instanceof Int16Array) {
          if (ch === 1) monoInt16 = dataAny; else {
            const frames = Math.floor(dataAny.length / ch);
            monoInt16 = new Int16Array(frames);
            for (let i = 0; i < frames; i++) {
              let acc = 0; for (let c = 0; c < ch; c++) acc += dataAny[i * ch + c];
              monoInt16[i] = Math.max(-32768, Math.min(32767, Math.round(acc / ch)));
            }
          }
        } else if (dataAny instanceof Float32Array) {
          const frames = Math.floor(dataAny.length / ch);
          monoInt16 = new Int16Array(frames);
          for (let i = 0; i < frames; i++) {
            let acc = 0; for (let c = 0; c < ch; c++) acc += dataAny[i * ch + c];
            const avg = acc / ch; monoInt16[i] = Math.max(-32768, Math.min(32767, Math.round(avg * 32767)));
          }
        } else {
          const view = new Int16Array((dataAny?.buffer ?? frame.data.buffer));
          monoInt16 = view;
        }
        const b = Buffer.from(
          (monoInt16.buffer).slice(monoInt16.byteOffset, monoInt16.byteOffset + monoInt16.byteLength),
        );
        receivedBuffers.push(b);
        recvSamples += monoInt16.length;
        if (recvSamples >= totalFrames) {
          resolve();
        }
      }
    });
  });

  // Publisher
  const pubRoom = new Room();
  await pubRoom.connect(url, pubToken, { autoSubscribe: false, timeout: 15000 });
  console.log('📡 Publisher connected');
  const source = new AudioSource({ sampleRate: 48000, numChannels: 1 });
  const track = LocalAudioTrack.createAudioTrack('file', { source, sourceType: TrackSource.Microphone });
  await pubRoom.localParticipant.publishTrack(track);
  console.log('📤 Publisher track published');

  const frameSamples = 480; // 10ms @ 48k
  let offset = 0;
  while (offset < pcm48.length) {
    const end = Math.min(offset + frameSamples * 2, pcm48.length);
    const frameBuf = pcm48.subarray(offset, end);
    offset = end;
    const samples = new Int16Array(frameBuf.buffer, frameBuf.byteOffset, frameBuf.length / 2);
    const audioFrame = { data: samples, sampleRate: 48000, numChannels: 1, samplesPerChannel: samples.length };
    if (typeof source.captureFrame === 'function') source.captureFrame(audioFrame);
    else if (typeof (source).pushFrame === 'function') (source).pushFrame(audioFrame);
    await delay(10);
  }
  console.log('✅ Publisher finished streaming file');

  await Promise.race([subReady, delay(3000)]);

  const outPath = path.resolve(process.cwd(), outputRel);
  const outPcm = Buffer.concat(receivedBuffers);
  const outWav = buildWavFile(outPcm, 48000, 1);
  fs.writeFileSync(outPath, outWav);
  console.log(`💾 Wrote roundtrip WAV: ${outPath} (${outPcm.length} bytes)`);

  try { await pubRoom.disconnect(); } catch {}
  try { await subRoom.disconnect(); } catch {}
  console.log('🏁 Done');
}

run().catch((err) => { console.error('Roundtrip failed:', err); process.exit(1); });
