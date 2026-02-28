import { EventEmitter } from "events";
import { LiveKitGoBridgeManager } from "./LiveKitGoBridgeManager";

export interface LiveKitInfo {
  url: string;
  roomName: string;
  token: string;
}

export interface LiveKitManagerOptions {
  // For Node/Bun publisher path first; browser can be added later with adapters
  publishAudioFilePath?: string; // optional WAV/PCM file path to publish
  preferredSampleRate?: number; // e.g., 48000 for Opus, or 16000
  autoInitOnInfo?: boolean; // auto-connect and publish when info arrives
  useBrowserMic?: boolean; // if true, capture mic in browser
  // New: use LiveKit as the audio transport for arbitrary PCM chunks
  useForAudio?: boolean;
  // Use Go bridge instead of Node SDK for publishing
  useGoBridge?: boolean;
  goBridgeUrl?: string;
}

/**
 * LiveKitManager (client-side)
 * - Listens for `livekit_info` from the WebSocket manager
 * - Connects to LiveKit and publishes an audio track (Node path placeholder)
 * - Future: add browser adapter (getUserMedia) for mic publishing
 */
export class LiveKitManager extends EventEmitter {
  private info: LiveKitInfo | null = null;
  private options: LiveKitManagerOptions;
  private room: any | null = null;
  private customSource: any | null = null; // rtc-node AudioSource
  private customTrack: any | null = null; // rtc-node LocalAudioTrack
  private targetRate: number = 48000;
  private frameQueue: Buffer[] = [];
  private pushTimer: NodeJS.Timeout | null = null;
  private customReady = false;
  private goBridge: LiveKitGoBridgeManager | null = null;

  constructor(options?: LiveKitManagerOptions) {
    super();
    this.options = {
      autoInitOnInfo: true,
      ...options,
    };
    if (this.options.preferredSampleRate) {
      this.targetRate = this.options.preferredSampleRate;
    }
  }

  // @ts-ignore // ws is an EventEmitter-like with 'on' method
  attachToWebSocket(ws: {
    on: (event: string, listener: (data: any) => void) => void;
  }): void {
    // Listen for CONNECTION_ACK which includes LiveKit info
    ws.on("connection_ack", async (ack: any) => {
      if (!ack.livekit) {
        console.log("[LiveKitManager] No LiveKit info in CONNECTION_ACK");
        return;
      }

      // Prevent multiple connections
      if (this.info) {
        console.log(
          "[LiveKitManager] Already have LiveKit info, ignoring duplicate CONNECTION_ACK",
        );
        return;
      }

      const data = ack.livekit;
      console.log(
        "[LiveKitManager] Received LiveKit info from CONNECTION_ACK:",
        {
          url: data.url,
          roomName: data.roomName,
          tokenLength: data.token?.length,
          tokenPrefix: data.token?.substring(0, 20) + "...",
        },
      );
      this.info = { url: data.url, roomName: data.roomName, token: data.token };
      this.emit("info", this.info);

      if (this.options.autoInitOnInfo) {
        try {
          if (this.options.useGoBridge) {
            // Use Go bridge for publishing
            await this.connectViaGoBridge();
          } else if (
            this.options.useForAudio &&
            !this.options.publishAudioFilePath &&
            !this.options.useBrowserMic
          ) {
            await this.connectForCustomPublisher();
          } else {
            await this.connectAndPublish();
          }
        } catch (err) {
          this.emit("error", err);
        }
      }
    });
  }

  hasInfo(): boolean {
    return !!this.info;
  }

  getInfo(): LiveKitInfo | null {
    return this.info;
  }

  /**
   * Connect to LiveKit via Go bridge for audio publishing
   * The Go bridge handles WebRTC and can reliably publish PCM audio
   */
  async connectViaGoBridge(): Promise<void> {
    if (!this.info) throw new Error("LiveKit info not set");

    const bridgeUrl = this.options.goBridgeUrl || "ws://localhost:8080";
    console.log(`[LiveKitManager] Connecting via Go bridge at ${bridgeUrl}`);

    // Create Go bridge manager
    this.goBridge = new LiveKitGoBridgeManager({
      userId: this.info.roomName, // Use room name as user ID
      serverUrl: bridgeUrl,
      debug: true,
    });

    // Set up event handlers
    this.goBridge.on("room_joined", (info) => {
      console.log("[LiveKitManager] Go bridge joined room:", info);
      this.customReady = true;
      this.emit("connected", {
        roomName: this.info!.roomName,
        via: "go-bridge",
      });
    });

    this.goBridge.on("error", (err) => {
      console.error("[LiveKitManager] Go bridge error:", err);
      this.emit("error", err);
    });

    // Connect to Go bridge
    await this.goBridge.connect();

    // Join LiveKit room via Go bridge
    await this.goBridge.joinRoom(this.info.roomName, this.info.token);

    console.log("[LiveKitManager] Connected to LiveKit via Go bridge");
  }

  async connectAndPublish(): Promise<void> {
    if (!this.info) throw new Error("LiveKit info not set");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Room } = require("@livekit/rtc-node");
    const room = new Room();
    await room.connect(this.info.url, this.info.token);
    this.room = room;
    this.emit("connected", { roomName: this.info.roomName });

    if (this.options.publishAudioFilePath) {
      await this.publishFromFile(room, this.options.publishAudioFilePath);
    } else {
      this.emit("warning", {
        message: "No publisher configured. Provide publishAudioFilePath.",
      });
    }
  }

  /**
   * Connects to LiveKit and prepares a custom RTCAudioSource for arbitrary PCM chunks.
   */
  async connectForCustomPublisher(): Promise<void> {
    if (!this.info) throw new Error("LiveKit info not set");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const {
      Room,
      AudioSource,
      LocalAudioTrack,
      TrackSource,
    } = require("@livekit/rtc-node");
    const room = new Room();

    console.log("[LiveKitManager] Attempting to connect to:", this.info.url);
    console.log("[LiveKitManager] Room name:", this.info.roomName);

    // Retry logic for connection
    let lastError: any;
    const maxRetries = 3;
    const retryDelays = [1000, 2000, 4000]; // exponential backoff

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        console.log(
          `[LiveKitManager] Connection attempt ${attempt + 1}/${maxRetries}`,
        );

        await room.connect(this.info.url, this.info.token, {
          autoSubscribe: false, // We're only publishing
          dynacast: true, // Enable adaptive streaming
          timeout: 10000, // 10 second timeout per attempt
        });

        this.room = room;
        console.log("[LiveKitManager] Successfully connected to LiveKit");
        this.emit("connected", { roomName: this.info.roomName });
        break; // Success, exit retry loop
      } catch (error: any) {
        lastError = error;
        console.error(
          `[LiveKitManager] Connection attempt ${attempt + 1} failed:`,
          error.message,
        );

        if (attempt < maxRetries - 1) {
          console.log(
            `[LiveKitManager] Retrying in ${retryDelays[attempt]}ms...`,
          );
          await new Promise((resolve) =>
            setTimeout(resolve, retryDelays[attempt]),
          );
        }
      }
    }

    if (!this.room) {
      console.error("[LiveKitManager] All connection attempts failed");
      throw lastError;
    }

    // Create AudioSource/Track and publish
    const source = new AudioSource({
      sampleRate: this.targetRate,
      numChannels: 1,
    });
    const track = LocalAudioTrack.createAudioTrack("microphone", {
      source,
      sourceType: TrackSource.Microphone,
    });
    await room.localParticipant.publishTrack(track);
    this.customSource = source;
    this.customTrack = track;
    this.customReady = true;
    this.emit("published");
  }

  /**
   * Sends a PCM16 mono chunk to LiveKit, buffering and pacing at ~10ms frames.
   * sampleRate is the PCM chunk's rate (defaults to 16000 if omitted).
   * With Go Bridge: sends raw PCM directly to Go service for publishing.
   */
  sendPcmChunk(chunk: Buffer, sampleRate: number = 16000): void {
    if (!this.options.useForAudio) {
      console.log("[LiveKitManager] Not configured for audio, skipping chunk");
      return; // not configured for custom sending
    }

    // If using Go bridge, send directly
    if (this.goBridge && this.goBridge.isReady()) {
      // Go bridge expects 16kHz PCM and handles resampling internally
      this.goBridge.publishAudio(chunk);
      return;
    } else if (this.goBridge) {
      console.log("[LiveKitManager] Go bridge not ready yet");
    }

    if (!this.customReady || !this.customSource) {
      this.emit("warning", {
        message: "LiveKit custom publisher not ready; dropping chunk",
      });
      return;
    }

    const resampled =
      sampleRate === this.targetRate
        ? chunk
        : this.resampleLinear(chunk, sampleRate, this.targetRate);
    // Split into 10ms frames and enqueue
    const samplesPer10ms = Math.floor(this.targetRate / 100);
    const bytesPerFrame = samplesPer10ms * 2; // 16-bit mono
    let offset = 0;
    while (offset + bytesPerFrame <= resampled.length) {
      const frame = resampled.subarray(offset, offset + bytesPerFrame);
      this.frameQueue.push(frame);
      offset += bytesPerFrame;
    }
    // Keep any tail for next call by reusing it as prefix on next chunk; for simplicity we ignore tails here

    if (!this.pushTimer) {
      this.pushTimer = setInterval(() => {
        try {
          if (!this.frameQueue.length) return;
          const frame = this.frameQueue.shift()!;
          const samples = new Int16Array(
            frame.buffer,
            frame.byteOffset,
            frame.length / 2,
          );
          // rtc-node AudioSource expects an AudioFrame
          const audioFrame = {
            data: samples,
            sampleRate: this.targetRate,
            numChannels: 1,
            samplesPerChannel: samples.length,
          };
          if (typeof (this.customSource as any).captureFrame === "function") {
            (this.customSource as any).captureFrame(audioFrame);
          } else if (
            typeof (this.customSource as any).pushFrame === "function"
          ) {
            (this.customSource as any).pushFrame(audioFrame);
          }
        } catch (err) {
          this.emit("error", err);
        }
      }, 10);
    }
  }

  private async publishFromFile(room: any, filePath: string): Promise<void> {
    if (this.isBrowser()) {
      this.emit("warning", {
        message: "publishFromFile is Node-only. Use useBrowserMic in browser.",
      });
      return;
    }

    // Lazy require node modules
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("fs");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const {
      AudioSource,
      LocalAudioTrack,
      TrackSource,
    } = require("@livekit/rtc-node");

    // Read WAV
    const wavBuffer: Buffer = fs.readFileSync(filePath);
    const parsed = this.parseWav(wavBuffer);
    if (!parsed) {
      this.emit("error", new Error("Failed to parse WAV file"));
      return;
    }

    const { sampleRate, channels, pcm } = parsed;
    const targetRate = this.options.preferredSampleRate || 48000;
    const monoPcm = channels === 2 ? this.stereoToMono(pcm) : pcm;
    const resampled =
      sampleRate === targetRate
        ? monoPcm
        : this.resampleLinear(monoPcm, sampleRate, targetRate);

    const source = new AudioSource({ sampleRate: targetRate, numChannels: 1 });
    const track = LocalAudioTrack.createAudioTrack("file", {
      source,
      sourceType: TrackSource.Microphone,
    });
    await room.localParticipant.publishTrack(track);

    const frameSize = Math.floor(targetRate / 100); // 10ms
    const bytesPerSample = 2;
    const bytesPerFrame = frameSize * bytesPerSample;
    let offset = 0;
    const pushNext = async () => {
      if (offset >= resampled.length) {
        this.emit("published");
        return;
      }
      const end = Math.min(offset + bytesPerFrame, resampled.length);
      const frameData = resampled.subarray(offset, end);
      offset = end;
      const samples = new Int16Array(
        frameData.buffer,
        frameData.byteOffset,
        frameData.length / 2,
      );
      const audioFrame = {
        data: samples,
        sampleRate: targetRate,
        numChannels: 1,
        samplesPerChannel: samples.length,
      };
      if (typeof source.captureFrame === "function")
        source.captureFrame(audioFrame);
      else if (typeof (source as any).pushFrame === "function")
        (source as any).pushFrame(audioFrame);
      setTimeout(pushNext, 10);
    };
    pushNext();
  }

  private parseWav(
    wavData: Buffer,
  ): { sampleRate: number; channels: number; pcm: Buffer } | null {
    if (wavData.toString("ascii", 0, 4) !== "RIFF") return null;
    if (wavData.toString("ascii", 8, 12) !== "WAVE") return null;
    const fmtIndex = wavData.indexOf(Buffer.from("fmt "));
    if (fmtIndex === -1) return null;
    const audioFormat = wavData.readUInt16LE(fmtIndex + 8);
    const channels = wavData.readUInt16LE(fmtIndex + 10);
    const sampleRate = wavData.readUInt32LE(fmtIndex + 12);
    const bitsPerSample = wavData.readUInt16LE(fmtIndex + 22);
    if (audioFormat !== 1 || bitsPerSample !== 16) return null; // PCM 16-bit only
    const dataIndex = wavData.indexOf(Buffer.from("data"));
    if (dataIndex === -1) return null;
    const dataSize = wavData.readUInt32LE(dataIndex + 4);
    const pcmStart = dataIndex + 8;
    const pcm = wavData.subarray(pcmStart, pcmStart + dataSize);
    return { sampleRate, channels, pcm };
  }

  private stereoToMono(stereo: Buffer): Buffer {
    const mono = Buffer.allocUnsafe(stereo.length / 2);
    for (let i = 0, j = 0; i < stereo.length; i += 4, j += 2) {
      const left = stereo.readInt16LE(i);
      const right = stereo.readInt16LE(i + 2);
      mono.writeInt16LE(((left + right) / 2) | 0, j);
    }
    return mono;
  }

  private resampleLinear(
    pcm: Buffer,
    fromRate: number,
    toRate: number,
  ): Buffer {
    if (fromRate === toRate) return pcm;
    const ratio = fromRate / toRate;
    const inSamples = pcm.length / 2;
    const outSamples = Math.round(inSamples / ratio);
    const out = Buffer.allocUnsafe(outSamples * 2);
    for (let i = 0; i < outSamples; i++) {
      const srcIndex = i * ratio;
      const i1 = Math.floor(srcIndex) * 2;
      const i2 = Math.min(i1 + 2, pcm.length - 2);
      const s1 = pcm.readInt16LE(i1);
      const s2 = pcm.readInt16LE(i2);
      const frac = srcIndex - Math.floor(srcIndex);
      const val = Math.round(s1 + (s2 - s1) * frac);
      out.writeInt16LE(val, i * 2);
    }
    return out;
  }

  private async publishFromBrowserMic(_room: any): Promise<void> {
    /* no-op in Node */ this.emit("warning", {
      message: "Browser mic not supported in Node",
    });
  }

  private isBrowser(): boolean {
    return (
      typeof window !== "undefined" &&
      typeof (window as any).navigator !== "undefined"
    );
  }
}
