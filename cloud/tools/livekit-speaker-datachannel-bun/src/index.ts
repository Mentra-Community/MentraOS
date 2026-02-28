import "dotenv/config";
import { Command } from "commander";
import { Room, RoomEvent, dispose } from "@livekit/rtc-node";
import { AccessToken } from "livekit-server-sdk";
import { RoomServiceClient } from "livekit-server-sdk";
import { genSine, FileSink, type PCMSink, SoxPlaySink, TeeSink } from "./audio";

// CLI flags
const program = new Command();
program
  .option("--url <url>", "LiveKit URL", process.env.LIVEKIT_URL)
  .option("--token <token>", "Access token", process.env.LIVEKIT_TOKEN)
  .option(
    "--target <identity>",
    "Subscribe only to this participant identity",
    process.env.TARGET_IDENTITY,
  )
  .option("--room <room>", "Room name", process.env.LIVEKIT_ROOM_NAME)
  .option(
    "--identity <identity>",
    "Client identity",
    process.env.LIVEKIT_IDENTITY,
  )
  .option(
    "--inspect",
    "List rooms/participants via RoomService before connecting",
    false,
  )
  .option(
    "--watch",
    "Poll participants every 5s via RoomService and log",
    false,
  )
  .option(
    "--expected-sr <hz>",
    "Expected sample rate for metrics",
    (v) => parseInt(v, 10),
    16000,
  )
  .option("--beep", "Play a 1s 440Hz test tone on start", false)
  .option("--beep-dur <sec>", "Beep duration", (v) => parseFloat(v), 1.0)
  .option(
    "--frames-only",
    "Only log data packet frames; no periodic/status logs",
    false,
  )
  .option(
    "--max-latency-ms <ms>",
    "Max buffered latency before dropping",
    (v) => parseInt(v, 10),
    250,
  )
  .option(
    "--target-latency-ms <ms>",
    "Target latency after drops",
    (v) => parseInt(v, 10),
    100,
  )
  .option(
    "--drop-old",
    "Enable dropping of oldest frames when backlog exceeds max-latency-ms",
    true,
  )
  .option(
    "--gain <x>",
    "Linear gain on PCM (e.g., 2.0 = +6dB)",
    (v) => parseFloat(v),
    1.0,
  )
  .option("--audio-out <mode>", "audio sink: auto|sox|file", "auto")
  .parse(process.argv);

const raw = program.opts();
const opt = {
  url: String(raw.url),
  token: raw.token as string | undefined,
  target: raw.target as string | undefined,
  room: raw.room as string | undefined,
  identity: raw.identity as string | undefined,
  inspect: Boolean(raw.inspect),
  watch: Boolean(raw.watch),
  expectedSr: Number(raw.expectedSr ?? 16000),
  beep: Boolean(raw.beep),
  beepDur: Number(raw.beepDur ?? 1.0),
  framesOnly: Boolean(raw.framesOnly),
  maxLatencyMs: Number(raw.maxLatencyMs ?? 250),
  targetLatencyMs: Number(raw.targetLatencyMs ?? 100),
  dropOld: raw.dropOld !== undefined ? Boolean(raw.dropOld) : true,
  gain: Number(raw.gain ?? 1.0),
  audioOut: (raw.audioOut as string | undefined) ?? "auto",
} as const;

if (!opt.url) {
  console.error("url is required (flag --url or env LIVEKIT_URL)");
  process.exit(1);
}

let token: string | undefined = opt.token;
let identity: string | undefined = opt.identity;
const roomName: string | undefined = opt.room;

// Simple ring buffer for audio
class RingBuffer {
  private buffer: Uint8Array;
  private size: number;
  private writePos = 0;
  private readPos = 0;
  private fillLevel = 0;

  constructor(sizeMs: number, sampleRate: number, channels: number = 1) {
    const bytesPerSecond = sampleRate * channels * 2; // 16-bit = 2 bytes
    this.size = Math.floor((sizeMs / 1000) * bytesPerSecond);
    // Ensure even size for sample alignment
    this.size = (this.size >> 1) << 1;
    this.buffer = new Uint8Array(this.size);
  }

  write(data: Uint8Array): boolean {
    // Ensure even length
    if (data.length % 2 !== 0) {
      data = data.slice(0, data.length - 1);
    }

    // Check if we have space
    const space = this.size - this.fillLevel;
    if (data.length > space) {
      return false; // Would overflow
    }

    // Copy data into circular buffer
    for (let i = 0; i < data.length; i++) {
      this.buffer[this.writePos] = data[i];
      this.writePos = (this.writePos + 1) % this.size;
    }
    this.fillLevel += data.length;
    return true;
  }

  read(bytes: number): Uint8Array | null {
    // Ensure even read size
    bytes = (bytes >> 1) << 1;

    if (this.fillLevel < bytes) {
      return null; // Not enough data
    }

    const result = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i++) {
      result[i] = this.buffer[this.readPos];
      this.readPos = (this.readPos + 1) % this.size;
    }
    this.fillLevel -= bytes;
    return result;
  }

  available(): number {
    return this.fillLevel;
  }

  availableMs(sampleRate: number, channels: number = 1): number {
    const bytesPerSecond = sampleRate * channels * 2;
    return (this.fillLevel / bytesPerSecond) * 1000;
  }

  drop(bytes: number): number {
    // Ensure even drop size (complete samples)
    bytes = (bytes >> 1) << 1;
    const toDrop = Math.min(bytes, this.fillLevel);

    // Apply fade-out to the last few samples before drop to avoid pop
    const fadeLength = Math.min(32, toDrop / 2); // Fade last 16 samples
    for (let i = 0; i < fadeLength; i++) {
      const pos = (this.readPos + toDrop - fadeLength * 2 + i * 2) % this.size;
      const sample = this.buffer[pos] | (this.buffer[pos + 1] << 8);
      const faded = Math.round(sample * (i / fadeLength));
      this.buffer[pos] = faded & 0xff;
      this.buffer[pos + 1] = (faded >> 8) & 0xff;
    }

    this.readPos = (this.readPos + toDrop) % this.size;
    this.fillLevel -= toDrop;
    return toDrop;
  }
}

async function mintTokenIfNeeded() {
  if (token) return;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!apiKey || !apiSecret) {
    console.error(
      "LIVEKIT_TOKEN not provided and LIVEKIT_API_KEY/SECRET missing; cannot mint token",
    );
    process.exit(1);
  }
  if (!roomName) {
    console.error(
      "room is required to mint token (flag --room or env LIVEKIT_ROOM_NAME)",
    );
    process.exit(1);
  }
  if (!identity) identity = `speaker-${Date.now()}`;
  const at = new AccessToken(
    process.env.LIVEKIT_API_KEY!,
    process.env.LIVEKIT_API_SECRET!,
    {
      identity,
      name: identity,
    },
  );
  at.addGrant({ roomJoin: true, room: roomName! });
  token = await at.toJwt();
  console.log(`joining as (minted): identity=${identity} room=${roomName}`);
}

async function main() {
  await mintTokenIfNeeded();
  if (!token) throw new Error("missing token");

  console.log(
    `livekit-speaker-bun: url=${opt.url} room=${roomName} target=${opt.target ?? "any"} tokenLen=${token.length}`,
  );

  // Choose audio sink
  let sink: PCMSink;
  const useSox = () =>
    new SoxPlaySink({ sampleRate: opt.expectedSr, channels: 1 });

  switch (opt.audioOut) {
    case "sox": {
      const s = useSox();
      sink = new TeeSink(s as unknown as PCMSink, new FileSink("out.raw"));
      console.log("audio: sox play sink + tee to out.raw");
      break;
    }
    case "auto": {
      try {
        const s = useSox();
        sink = new TeeSink(s as unknown as PCMSink, new FileSink("out.raw"));
        console.log("audio: sox play sink (auto) + tee to out.raw");
        break;
      } catch {
        console.log("audio: defaulting to file sink (out.raw)");
        sink = new FileSink("out.raw");
        break;
      }
    }
    case "file":
    default: {
      sink = new FileSink("out.raw");
      console.log("audio: file sink (out.raw)");
      break;
    }
  }

  // Test beep
  if (opt.beep) {
    const s = genSine(440, opt.beepDur, opt.expectedSr, 1, 0.3);
    sink.write(s);
    console.log(`beep: wrote ${s.length} bytes`);
  }

  // Setup audio parameters
  const channels = 1;
  const sampleRate = opt.expectedSr;
  const bytesPerSecond = sampleRate * channels * 2;
  const tickMs = 20; // 20ms chunks work better than 10ms
  const bytesPerTick = Math.floor((tickMs / 1000) * bytesPerSecond);
  // Ensure even bytes for complete samples
  const alignedBytesPerTick = (bytesPerTick >> 1) << 1;

  // Create ring buffer (500ms capacity)
  const audioBuffer = new RingBuffer(500, sampleRate, channels);
  let playbackStarted = false;

  // Stats
  const stats = {
    bytesWritten: 0,
    framesReceived: 0,
    underruns: 0,
    drops: 0,
    lastRxTime: 0,
  };

  // Smoothing: Keep track of last sample for cross-fade
  let lastSample = 0;

  // Apply gain function with smooth clipping
  const applyGain = (data: Uint8Array): Uint8Array => {
    if (opt.gain === 1.0 || !data || data.length === 0) return data;

    const output = new Uint8Array(data.length);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const outView = new DataView(output.buffer);
    const numSamples = data.length / 2;

    for (let i = 0; i < numSamples; i++) {
      const sample = view.getInt16(i * 2, true);
      let amplified = sample * opt.gain;

      // Soft clipping instead of hard clipping to reduce distortion
      if (amplified > 32767) {
        amplified = 32767 - (amplified - 32767) * 0.2; // Soft clip
      } else if (amplified < -32768) {
        amplified = -32768 - (amplified + 32768) * 0.2; // Soft clip
      }

      outView.setInt16(i * 2, Math.round(amplified), true);
    }

    return output;
  };

  // Apply smoothing to reduce pops between chunks
  const smoothChunk = (data: Uint8Array): Uint8Array => {
    if (!data || data.length < 4) return data;

    const output = new Uint8Array(data.length);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const outView = new DataView(output.buffer);
    const numSamples = data.length / 2;

    // Apply cross-fade at beginning
    const fadeLength = Math.min(8, numSamples / 4);

    for (let i = 0; i < numSamples; i++) {
      let sample = view.getInt16(i * 2, true);

      // Fade in at start
      if (i < fadeLength) {
        const fadeIn = i / fadeLength;
        sample = Math.round(lastSample * (1 - fadeIn) + sample * fadeIn);
      }

      outView.setInt16(i * 2, sample, true);
    }

    // Remember last sample for next chunk
    lastSample = view.getInt16((numSamples - 1) * 2, true);

    return output;
  };

  // Audio playback timer
  const audioTimer = setInterval(() => {
    const availableMs = audioBuffer.availableMs(sampleRate, channels);

    // Wait for initial buffering
    if (!playbackStarted) {
      if (availableMs >= opt.targetLatencyMs) {
        playbackStarted = true;
        console.log(
          `playback started with ${availableMs.toFixed(1)}ms buffered`,
        );
      }
      return;
    }

    // Drop old data if buffer is too full
    if (opt.dropOld && availableMs > opt.maxLatencyMs) {
      const dropMs = availableMs - opt.targetLatencyMs;
      const dropBytes = Math.floor((dropMs / 1000) * bytesPerSecond);
      const alignedDropBytes = (dropBytes >> 1) << 1;
      const dropped = audioBuffer.drop(alignedDropBytes);
      stats.drops++;
      if (!opt.framesOnly) {
        console.log(
          `dropped ${dropped}B to reduce latency from ${availableMs.toFixed(1)}ms to target`,
        );
      }
    }

    // Read and play audio
    const chunk = audioBuffer.read(alignedBytesPerTick);
    if (chunk) {
      let output = applyGain(chunk);
      output = smoothChunk(output); // Apply smoothing to reduce pops
      try {
        sink.write(output);
        stats.bytesWritten += output.length;
      } catch (e) {
        console.error("audio write error:", e);
      }
    } else {
      // Buffer underrun - fade to silence smoothly
      stats.underruns++;
      const silence = new Uint8Array(alignedBytesPerTick);

      // Fade from last sample to silence
      const view = new DataView(silence.buffer);
      const fadeSamples = Math.min(16, alignedBytesPerTick / 2);
      for (let i = 0; i < fadeSamples; i++) {
        const fade = 1 - i / fadeSamples;
        const sample = Math.round(lastSample * fade);
        view.setInt16(i * 2, sample, true);
      }
      lastSample = 0; // Reset after fade

      try {
        sink.write(silence);
        stats.bytesWritten += alignedBytesPerTick;
      } catch (e) {
        console.error("audio write error:", e);
      }
    }
  }, tickMs);

  // Create room and connect
  const room = new Room();

  room.on(RoomEvent.Connected, () => {
    console.log(
      `connected: local=${room.localParticipant?.identity} remotes=${room.remoteParticipants.size}`,
    );
  });

  room.on(RoomEvent.Disconnected, () => {
    if (!opt.framesOnly) console.log("room disconnected");
  });

  room.on(RoomEvent.Reconnecting, () => {
    if (!opt.framesOnly) console.log("room reconnecting...");
  });

  room.on(RoomEvent.Reconnected, () => {
    if (!opt.framesOnly) console.log("room reconnected");
  });

  // Handle incoming data
  room.on(RoomEvent.DataReceived, (payload, participant) => {
    if (opt.target && participant?.identity !== opt.target) return;

    const data = payload as Uint8Array;
    if (!data || data.length === 0) return;

    stats.framesReceived++;
    let pcm = data;

    // Skip sequence byte if present (odd length)
    if (data.length % 2 === 1) {
      pcm = data.slice(1);
    }

    // Ensure even length for 16-bit samples
    if (pcm.length % 2 !== 0) {
      pcm = pcm.slice(0, pcm.length - 1);
    }

    if (pcm.length < 2) return;

    // Debug timing (only log every 10th frame)
    if (!opt.framesOnly && stats.framesReceived % 10 === 0) {
      const now = Date.now();
      if (stats.lastRxTime > 0) {
        const delta = now - stats.lastRxTime;
        const samples = (pcm.length / 2) * 10; // 10 frames worth
        const expectedMs = (samples / sampleRate) * 1000;
        const jitter = Math.abs(delta - expectedMs);

        console.log(
          `rx #${stats.framesReceived}: ${pcm.length}B, ` +
            `Δt=${delta}ms (10 frames), expected=${expectedMs.toFixed(1)}ms, ` +
            `jitter=${jitter.toFixed(1)}ms`,
        );
      }
      stats.lastRxTime = now;
    }

    // Add to buffer
    if (!audioBuffer.write(pcm)) {
      console.warn(`buffer overflow! dropping ${pcm.length} bytes`);
      stats.drops++;
      // Try to recover by clearing some space
      audioBuffer.drop(pcm.length);
      // Try writing again
      audioBuffer.write(pcm);
    }
  });

  // Stats reporting
  setInterval(() => {
    if (!opt.framesOnly) {
      const bufferMs = audioBuffer.availableMs(sampleRate, channels);
      const idealBytes = bytesPerSecond;
      const efficiency = ((stats.bytesWritten / idealBytes) * 100).toFixed(0);

      console.log(
        `stats: written=${stats.bytesWritten}B (${efficiency}% of ideal), ` +
          `buffer=${bufferMs.toFixed(1)}ms, frames=${stats.framesReceived}, ` +
          `underruns=${stats.underruns}, drops=${stats.drops}, ` +
          `started=${playbackStarted}`,
      );

      // Reset per-second stats
      stats.bytesWritten = 0;
      stats.underruns = 0;
      stats.drops = 0;
    }
  }, 1000);

  // Connect to room
  await room.connect(opt.url, token, {
    autoSubscribe: false, // We're using data channel, not tracks
    dynacast: false,
  });

  // Cleanup
  const shutdown = () => {
    console.log("shutting down...");
    clearInterval(audioTimer);
    sink.close();
    room.disconnect();
    dispose().catch(() => {});
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Optional: inspect/watch via server SDK
async function maybeInspect() {
  if (!opt.inspect && !opt.watch) return;
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!apiKey || !apiSecret) {
    console.log(
      "inspect/watch requested but LIVEKIT_API_KEY/SECRET missing; skipping REST",
    );
    return;
  }
  const httpURL = opt.url.replace(/^wss?:\/\//, (m) =>
    m === "wss://" ? "https://" : "http://",
  );
  const rs = new RoomServiceClient(httpURL, apiKey, apiSecret);
  if (opt.inspect) {
    try {
      const rooms = await rs.listRooms();
      console.log(`rooms: ${rooms.length}`);
      for (const r of rooms)
        console.log(`- room: ${r.name} participants=${r.numParticipants}`);
      if (roomName) {
        const parts = await rs.listParticipants(roomName);
        console.log(`participants in ${roomName}: ${parts.length}`);
        for (const p of parts) console.log(`- ${p.identity}`);
      }
    } catch (e) {
      console.log("inspect error", e);
    }
  }
  if (opt.watch && roomName) {
    setInterval(async () => {
      try {
        const parts = await rs.listParticipants(roomName);
        console.log(
          "watch participants=",
          parts.map((p: any) => p.identity),
        );
      } catch (e) {
        console.log("watch error", e);
      }
    }, 5000);
  }
}

// Run
maybeInspect()
  .then(() => main())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
