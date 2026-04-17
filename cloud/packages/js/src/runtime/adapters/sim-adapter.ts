/**
 * sim-adapter — in-process simulated-glasses runtime
 *
 * Wraps `@mentra/client` + `@mentra/simulated-glasses` behind the
 * `MentraRuntime` contract. No webhooks, no WebSockets, no cloud,
 * no physical glasses — everything runs in the same process as the
 * dev server.
 *
 * Capability support
 * ──────────────────
 * The sim adapter implements what makes sense without real hardware:
 *
 *   ✓ display        — forwarded to SimulatedGlasses display
 *   ✓ transcription  — backed by @mentra/client injectTranscription
 *   ✓ mic            — backed by SimulatedGlasses mic (inject chunks)
 *   ✓ device.state   — static observable values for the sim profile
 *   ✗ speaker        — no physical speaker to write audio to
 *   ✗ camera         — no camera to take photos from
 *   ✗ location       — could fake but no real use case yet
 *
 * Unsupported managers throw `MentraRuntimeCapabilityError` the first
 * time they're touched. That's honest and catches "my app uses camera,
 * won't work in sim" without silent hangs.
 */

import type {
  CameraRuntime,
  DeviceRuntime,
  DeviceStateRuntime,
  DisplayRuntime,
  LocationRuntime,
  MentraRuntime,
  MentraSessionInfo,
  MicChunk,
  MicRuntime,
  SpeakerRuntime,
  TranscriptionData,
  TranscriptionRuntime,
  VadEvent,
} from "../contract";
import { MentraRuntimeCapabilityError } from "../contract";
import { Observable as ObservableImpl } from "../internals";

// Type-only so the adapter compiles without these packages installed.
import type { MentraClient } from "@mentra/client";
import type { SimulatedGlasses } from "@mentra/simulated-glasses";

type ReadyHandler = (info: MentraSessionInfo) => void;
type StoppedHandler = (reason: string) => void;
type ReconnectedHandler = () => void;
type TranscriptionHandler = (data: TranscriptionData) => void;
type MicChunkHandler = (chunk: MicChunk) => void;
type VadHandler = (event: VadEvent) => void;

export interface SimAdapterConfig {
  client: MentraClient;
  glasses: SimulatedGlasses;
  userId?: string;
  email?: string;
}

export class SimAdapter implements MentraRuntime {
  readonly name = "sim";

  private client: MentraClient;
  private glasses: SimulatedGlasses;
  private sessionInfo: MentraSessionInfo;
  private started = false;

  // Persistent handler lists.
  private readyHandlers: ReadyHandler[] = [];
  private stoppedHandlers: StoppedHandler[] = [];
  // Transport drops don't happen in sim — onReconnected is a no-op
  // but we hold the list for interface symmetry.
  private reconnectedHandlers: ReconnectedHandler[] = [];
  private transcriptionHandlers: TranscriptionHandler[] = [];
  private transcriptionFinalHandlers: TranscriptionHandler[] = [];
  private micChunkHandlers: MicChunkHandler[] = [];
  private vadHandlers: VadHandler[] = [];

  constructor(cfg: SimAdapterConfig) {
    this.client = cfg.client;
    this.glasses = cfg.glasses;
    this.sessionInfo = {
      userId: cfg.userId ?? "local-user",
      email: cfg.email,
      sessionId: `sim-${Date.now()}`,
    };

    // Wire @mentra/client transcription events into our handler fanout.
    this.client.transcription.on((event: any) => {
      const t: TranscriptionData = {
        text: event.text,
        isFinal: !!event.isFinal,
        language: event.language,
      };
      for (const h of this.transcriptionHandlers) {
        try {
          h(t);
        } catch (e) {
          console.error("[sim-adapter] transcription handler:", e);
        }
      }
      if (t.isFinal) {
        for (const h of this.transcriptionFinalHandlers) {
          try {
            h(t);
          } catch (e) {
            console.error("[sim-adapter] transcription final handler:", e);
          }
        }
      }
    });
  }

  // ── Contract: identity ─────────────────────────────────────────────────

  get info(): MentraSessionInfo {
    return { ...this.sessionInfo };
  }

  // ── Contract: lifecycle ────────────────────────────────────────────────

  onReady(handler: ReadyHandler): void {
    this.readyHandlers.push(handler);
    if (this.started) {
      try {
        handler(this.info);
      } catch (e) {
        console.error("[sim-adapter] onReady:", e);
      }
    }
  }

  onStopped(handler: StoppedHandler): void {
    this.stoppedHandlers.push(handler);
  }

  onReconnected(handler: ReconnectedHandler): void {
    // Sim never has transport drops. Registering is a no-op but we
    // keep the list for symmetry / future use.
    this.reconnectedHandlers.push(handler);
  }

  // ── Contract: display ──────────────────────────────────────────────────

  readonly display: DisplayRuntime = {
    showText: (text) => this.emitDisplay("text", { text }),
    showTextWall: (text) => this.emitDisplay("text_wall", { text }),
    clear: () => this.emitDisplay("clear", {}),
  };

  // ── Contract: transcription ────────────────────────────────────────────

  readonly transcription: TranscriptionRuntime = {
    on: (handler) => {
      this.transcriptionHandlers.push(handler);
      return () => {
        const idx = this.transcriptionHandlers.indexOf(handler);
        if (idx >= 0) this.transcriptionHandlers.splice(idx, 1);
      };
    },
    onFinal: (handler) => {
      this.transcriptionFinalHandlers.push(handler);
      return () => {
        const idx = this.transcriptionFinalHandlers.indexOf(handler);
        if (idx >= 0) this.transcriptionFinalHandlers.splice(idx, 1);
      };
    },
  };

  // ── Contract: mic ──────────────────────────────────────────────────────

  readonly mic: MicRuntime = {
    onChunk: (handler) => {
      this.micChunkHandlers.push(handler);
      return () => {
        const idx = this.micChunkHandlers.indexOf(handler);
        if (idx >= 0) this.micChunkHandlers.splice(idx, 1);
      };
    },
    onVoiceActivity: (handler) => {
      this.vadHandlers.push(handler);
      return () => {
        const idx = this.vadHandlers.indexOf(handler);
        if (idx >= 0) this.vadHandlers.splice(idx, 1);
      };
    },
    get hasPermission() {
      return true;
    }, // sim has unlimited permissions
  };

  // ── Contract: speaker ──────────────────────────────────────────────────
  // Not supported in sim — no physical speaker. Throws on first use.

  readonly speaker: SpeakerRuntime = {
    createStream: async () => {
      throw new MentraRuntimeCapabilityError("speaker.createStream", this.name);
    },
  };

  // ── Contract: camera ───────────────────────────────────────────────────
  // Not supported in sim — no camera. Throws on first use.

  readonly camera: CameraRuntime = {
    takePhoto: () => {
      throw new MentraRuntimeCapabilityError("camera.takePhoto", this.name);
    },
    startStream: () => {
      throw new MentraRuntimeCapabilityError("camera.startStream", this.name);
    },
    stopStream: () => {
      throw new MentraRuntimeCapabilityError("camera.stopStream", this.name);
    },
    onStreamStatus: () => {
      throw new MentraRuntimeCapabilityError("camera.onStreamStatus", this.name);
    },
    checkExistingStream: () => {
      throw new MentraRuntimeCapabilityError("camera.checkExistingStream", this.name);
    },
  };

  // ── Contract: device ───────────────────────────────────────────────────
  // Static observable values matching the attached sim profile (G1).

  readonly device: DeviceRuntime = {
    state: simDeviceState(),
  };

  // ── Contract: location ─────────────────────────────────────────────────
  // Not supported in sim. Could fake a fixed location later.

  readonly location: LocationRuntime = {
    requestUpdate: () => {
      throw new MentraRuntimeCapabilityError("location.requestUpdate", this.name);
    },
    onUpdate: () => {
      throw new MentraRuntimeCapabilityError("location.onUpdate", this.name);
    },
  };

  // ── Lifecycle (called by dev.ts) ───────────────────────────────────────

  /**
   * Attach the glasses and fire the ready event. Idempotent.
   */
  start(): void {
    if (this.started) return;
    this.client.glasses.attach(this.glasses as any);
    this.started = true;

    const info = this.info;
    for (const h of this.readyHandlers) {
      try {
        h(info);
      } catch (e) {
        console.error("[sim-adapter] onReady:", e);
      }
    }
  }

  stop(reason = "intentional"): void {
    if (!this.started) return;
    this.client.glasses.detach();
    this.started = false;
    for (const h of this.stoppedHandlers) {
      try {
        h(reason);
      } catch (e) {
        console.error("[sim-adapter] onStopped:", e);
      }
    }
  }

  // ── Test / dev affordances ────────────────────────────────────────────

  /** Simulate a transcription coming from on-device STT. */
  injectTranscription(data: TranscriptionData): void {
    this.client.injectTranscription({
      text: data.text,
      isFinal: data.isFinal,
      language: data.language,
    });
  }

  /** Simulate a mic chunk. Used by tests + /__mentra/inject/mic-chunk. */
  injectMicChunk(data: ArrayBuffer, sampleRate = 16000, channels = 1): void {
    const chunk: MicChunk = {
      data: data as any,
      sampleRate,
      channels,
      timestamp: Date.now(),
    };
    for (const h of this.micChunkHandlers) {
      try {
        h(chunk);
      } catch (e) {
        console.error("[sim-adapter] mic handler:", e);
      }
    }
  }

  /** Simulate a VAD event (user started / stopped speaking). */
  injectVad(isSpeaking: boolean): void {
    const event: VadEvent = { isSpeaking, timestamp: Date.now() };
    for (const h of this.vadHandlers) {
      try {
        h(event);
      } catch (e) {
        console.error("[sim-adapter] vad handler:", e);
      }
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private emitDisplay(type: string, payload: Record<string, unknown>): void {
    if (!this.started) {
      throw new MentraRuntimeCapabilityError("display (no active session)", this.name);
    }
    this.client.injectDisplayEvent({
      type,
      view: "main",
      packageName: "local",
      payload,
    });
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * A static-ish DeviceStateRuntime that reports reasonable defaults for a
 * simulated G1. If someone wants richer sim behavior later (e.g. battery
 * draining over time), this is where to add it.
 */
function simDeviceState(): DeviceStateRuntime {
  return {
    connected: new ObservableImpl<boolean>(true),
    modelName: new ObservableImpl<string | null>("sim-g1"),
    batteryLevel: new ObservableImpl<number | null>(100),
    charging: new ObservableImpl<boolean | null>(false),
    wifiConnected: new ObservableImpl<boolean>(true),
    wifiSsid: new ObservableImpl<string | null>("sim-wifi"),
  };
}
