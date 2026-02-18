import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";

// Simple PCM16 sine generator and writer utilities. Playback support varies by runtime;
// for reliability we write to a file if real-time playback isn't available.

export function int16ToBytes(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(i * 2, samples[i], true);
  }
  return out;
}

export function genSine(
  freq: number,
  durSec: number,
  sampleRate: number,
  channels: number,
  volume = 0.5,
): Uint8Array {
  if (durSec <= 0) return new Uint8Array();
  const n = Math.floor(sampleRate * durSec);
  const amp = Math.floor(32767 * volume);
  const mono = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * freq * i) / sampleRate;
    mono[i] = Math.floor(amp * Math.sin(t));
  }
  let interleaved: Int16Array;
  if (channels === 1) interleaved = mono;
  else {
    interleaved = new Int16Array(n * channels);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < channels; c++)
        interleaved[i * channels + c] = mono[i];
    }
  }
  return int16ToBytes(interleaved);
}

export interface PCMSink {
  write(buf: Uint8Array): void;
  close(): void;
}

export class TeeSink implements PCMSink {
  constructor(
    private a: PCMSink,
    private b: PCMSink,
  ) {}
  write(buf: Uint8Array) {
    try {
      this.a.write(buf);
    } catch {
      // ignore.
    }
    try {
      this.b.write(buf);
    } catch {
      // ignore.
    }
  }
  close() {
    try {
      this.a.close();
    } catch {
      // ignore.
    }
    try {
      this.b.close();
    } catch {
      // ignore.
    }
  }
}

export class FileSink implements PCMSink {
  private out: fs.WriteStream;
  public frames = 0;
  public totalBytes = 0;
  public lastWrite = 0;
  constructor(filePath: string) {
    this.out = fs.createWriteStream(filePath);
  }
  write(buf: Uint8Array) {
    this.out.write(buf);
    this.frames++;
    this.totalBytes += buf.length;
    this.lastWrite = Date.now();
  }
  close() {
    this.out.close();
  }
}

/**
 * Uses sox play command for audio playback
 * Install: brew install sox
 */
export class SoxPlaySink implements PCMSink {
  private process?: ChildProcess;
  public frames = 0;
  public totalBytes = 0;
  public ok = false;
  private closed = false;

  constructor(params: {
    sampleRate: number;
    channels: number;
    bitDepth?: number;
  }) {
    const bitDepth = params.bitDepth || 16;

    try {
      this.process = spawn(
        "play",
        [
          "-q", // quiet non-error logs
          "-t",
          "raw", // Raw audio format
          "-r",
          params.sampleRate.toString(), // Sample rate
          "-b",
          bitDepth.toString(), // Bit depth
          "-c",
          params.channels.toString(), // Channels
          "-e",
          "signed-integer", // Encoding
          "--endian",
          "little", // Byte order
          "-", // Read from stdin
        ],
        {
          stdio: ["pipe", "ignore", "pipe"],
        },
      );
      this.ok = true;
    } catch (err) {
      console.error("Sox spawn failed:", err);
      this.ok = false;
    }

    this.process?.on("error", (err) => {
      console.error("Sox error:", err);
      console.log("Install sox with: brew install sox");
      this.ok = false;
    });
    this.process?.on("exit", (code, signal) => {
      this.ok = false;
      this.closed = true;
      console.log(`Sox exited code=${code} signal=${signal}`);
    });
    this.process?.on("close", (code, signal) => {
      this.ok = false;
      this.closed = true;
      console.log(`Sox closed code=${code} signal=${signal}`);
    });
    this.process?.stderr?.on("data", (chunk: any) => {
      const s = String(chunk || "").trim();
      if (s) console.log(`[sox] ${s}`);
    });

    console.log(
      `SoxPlaySink initialized: ${params.sampleRate}Hz, ${params.channels}ch`,
    );
  }

  write(buf: Uint8Array) {
    if (!this.ok || this.closed) return;
    if (this.process?.stdin && !this.process.killed) {
      this.process.stdin.write(Buffer.from(buf));
      this.frames++;
      this.totalBytes += buf.length;
    }
  }

  close() {
    if (this.process) {
      this.process.stdin?.end();
      this.process.kill();
    }
  }
}

// macOS-friendly pipeline using ffmpeg to wrap raw PCM into WAV and piping to afplay
// export class FfmpegAfplaySink implements PCMSink {
//   private ff?: ChildProcess;
//   private af?: ChildProcess;
//   public ok = false;
//   public frames = 0;
//   public totalBytes = 0;
//   public lastWrite = 0;
//   constructor(params: { sampleRate: number; channels: number }) {
//     try {
//       const ffArgs = [
//         '-hide_banner',
//         '-loglevel', 'error',
//         '-f', 's16le',
//         '-ar', String(params.sampleRate),
//         '-ac', String(params.channels),
//         '-i', 'pipe:0',
//         '-f', 'wav',
//         'pipe:1',
//       ];
//       const ff = spawn('ffmpeg', ffArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
//       ff.on('error', (e) => console.error('ffmpeg spawn error:', e));
//       ff.stderr?.on('data', (d) => {
//         const s = String(d);
//         if (s && s.trim()) {
//           // suppress noisy logs
//         }
//       });
//       const af = spawn('afplay', ['-'], { stdio: ['pipe', 'ignore', 'pipe'] });
//       af.on('error', (e) => console.error('afplay spawn error:', e));
//       const ffStdout: any = ff.stdout;
//       const afStdin: any = af.stdin;
//       if (ffStdout && afStdin) {
//         if (typeof ffStdout.on === 'function') {
//           ffStdout.on('data', (chunk: any) => {
//             try { afStdin.write(chunk); } catch {}
//           });
//           ffStdout.on('end', () => {
//             try { afStdin.end(); } catch {}
//           });
//         } else if (typeof ffStdout.pipe === 'function') {
//           // best-effort fallback
//           try { ffStdout.pipe(afStdin); } catch {}
//         }
//       }
//       this.ff = ff;
//       this.af = af;
//       this.ok = true;
//     } catch (e) {
//       console.error('FfmpegAfplaySink initialization failed:', e);
//       this.ok = false;
//     }
//   }
//   write(buf: Uint8Array) {
//     if (!this.ok || !this.ff) return false;
//     const can = this.ff.stdin ? this.ff.stdin.write(Buffer.from(buf)) : false;
//     this.frames++;
//     this.totalBytes += buf.length;
//     this.lastWrite = Date.now();
//     return can;
//   }
//   close() {
//     try {
//       if (this.ff?.stdin) this.ff.stdin.end();
//       this.ff?.kill();
//       this.af?.kill();
//     } catch {}
//   }
// }
