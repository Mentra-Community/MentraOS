/**
 * @mentra/js — runtime contract
 *
 * The *shape* of what developer code talks to.
 *
 * Design notes
 * ────────────
 * This contract declares structural interfaces for the manager APIs
 * apps actually reach for. Both the cloud adapter (wrapping the forked
 * SDK classes at `./internals`) and the sim adapter (wrapping
 * `@mentra/client` + `@mentra/simulated-glasses`) implement the same
 * contract.
 *
 * Structural, not nominal: we don't alias the SDK classes as interfaces
 * because that would force every adapter to be a subclass of the SDK.
 * Instead we declare the exact shape apps use, and adapters provide it
 * however they want.
 *
 * The data types (TranscriptionData, PhotoResult, LocationData, ...)
 * mirror the forked SDK's types so apps can treat them interchangeably.
 * For simpler payloads we re-declare them here; for richer ones
 * (VideoConfig, etc.) we re-export from internals.
 */

// ── Re-exports from internals ────────────────────────────────────────────────

export type { Observable } from "./internals";

export type { AudioChunk as MicChunk, VadEvent } from "./internals/session/managers/MicManager";

export type {
  PhotoOptions,
  PhotoData as PhotoResult,
  StreamOptions as CameraStreamOptions,
  StreamResult as CameraStreamResult,
} from "./internals/session/managers/CameraManager";

export type { StreamOptions as SpeakerStreamOptions } from "./internals/session/managers/SpeakerManager";

export type { LocationData } from "./internals/session/managers/LocationManager";

import type { Observable as ObservableT } from "./internals";
import type { AudioChunk, VadEvent } from "./internals/session/managers/MicManager";
import type {
  PhotoOptions,
  PhotoData,
  StreamOptions as CamStreamOpts,
  StreamResult as CamStreamRes,
} from "./internals/session/managers/CameraManager";
import type { StreamOptions as SpkStreamOpts } from "./internals/session/managers/SpeakerManager";
import type { LocationData as LocData } from "./internals/session/managers/LocationManager";

// ── Session identity ─────────────────────────────────────────────────────────

export interface MentraSessionInfo {
  /**
   * Stable opaque user identity. Treat as a key, never parse.
   *
   * Legacy note (April 2026): the current cloud uses the user's email
   * as this value. Future cloud versions will migrate this to a real
   * UUID. Code that compares or stores userId continues to work across
   * that migration. Code that relies on userId being an email will
   * break.
   *
   * If you need the email, use `email`.
   */
  userId: string;

  /** User's email, if known. May be absent on some backends. */
  email?: string;

  /**
   * Per-session id. Cloud-assigned UUID in hosted mode, locally
   * generated in sim mode.
   */
  sessionId: string;
}

// ── Display ──────────────────────────────────────────────────────────────────

export interface DisplayRuntime {
  showText(text: string): void;
  showTextWall(text: string): void;
  clear(): void;
}

// ── Transcription ────────────────────────────────────────────────────────────

/**
 * Matches the forked SDK's `TranscriptionEvent`. Fields beyond `text`
 * and `isFinal` are optional because adapters differ in what they can
 * populate (e.g., sim adapter can't compute confidence).
 */
export interface TranscriptionData {
  text: string;
  isFinal: boolean;
  language?: string;
  speakerId?: string;
  utteranceId?: string;
  confidence?: number;
  startTime?: number;
  endTime?: number;
  duration?: number;
  metadata?: any;
}

export interface TranscriptionRuntime {
  /** Subscribe to all transcription events. Returns unsubscribe. */
  on(handler: (data: TranscriptionData) => void): () => void;
  /** Subscribe to only final events. Convenience. */
  onFinal(handler: (data: TranscriptionData) => void): () => void;
  /**
   * Subscribe to transcription for a specific language (or list).
   * ISO 639-1 codes. Optional — adapters may not implement.
   */
  forLanguage?(lang: string | string[], handler: (data: TranscriptionData) => void): () => void;
}

// ── Microphone ───────────────────────────────────────────────────────────────

export interface MicRuntime {
  onChunk(handler: (chunk: AudioChunk) => void): () => void;
  onVoiceActivity(handler: (event: VadEvent) => void): () => void;
  readonly hasPermission: boolean;
}

// ── Speaker ──────────────────────────────────────────────────────────────────

export type SpeakerStreamState = "creating" | "streaming" | "ending" | "ended" | "error" | string;

export interface SpeakerStream {
  readonly id: string;
  readonly state: SpeakerStreamState;
  write(chunk: Uint8Array): void;
  end(): Promise<void>;
  flush(): void;
  onStateChange(handler: (state: SpeakerStreamState) => void): void;
}

export interface SpeakerRuntime {
  createStream(options?: SpkStreamOpts): Promise<SpeakerStream>;
}

// ── Camera ───────────────────────────────────────────────────────────────────

export interface StreamStatus {
  status: string;
  streamId?: string;
  [extra: string]: unknown;
}

export interface ExistingStreamInfo {
  hasActiveStream: boolean;
  streamInfo?: {
    type: "managed" | "unmanaged";
    streamId: string;
    status: string;
    createdAt: Date;
    hlsUrl?: string;
    dashUrl?: string;
    webrtcUrl?: string;
    previewUrl?: string;
    thumbnailUrl?: string;
    activeViewers?: number;
    rtmpUrl?: string;
    requestingAppId?: string;
  };
}

export interface CameraRuntime {
  takePhoto(opts?: PhotoOptions): Promise<PhotoData>;
  startStream(options?: CamStreamOpts): Promise<CamStreamRes | void>;
  stopStream(): Promise<void>;
  onStreamStatus(handler: (status: StreamStatus) => void): () => void;
  checkExistingStream(): Promise<ExistingStreamInfo>;
}

// ── Device state ─────────────────────────────────────────────────────────────

/**
 * Read-only reactive device state. Every property is an Observable:
 * call `.value` for a snapshot or `.onChange(cb)` for updates.
 *
 * POC scope: only the fields `flash` uses plus obvious core. Case/
 * hotspot fields from the forked SDK are deliberately omitted;
 * adapters can widen later.
 */
export interface DeviceStateRuntime {
  readonly connected: ObservableT<boolean>;
  readonly modelName: ObservableT<string | null>;
  readonly batteryLevel: ObservableT<number | null>;
  readonly charging: ObservableT<boolean | null>;
  readonly wifiConnected: ObservableT<boolean>;
  readonly wifiSsid: ObservableT<string | null>;
}

export interface DeviceRuntime {
  readonly state: DeviceStateRuntime;
}

// ── Location ─────────────────────────────────────────────────────────────────

export interface LocationRuntime {
  requestUpdate(): Promise<LocData>;
  onUpdate(handler: (fix: LocData) => void): () => void;
}

// ── The contract ─────────────────────────────────────────────────────────────

export interface MentraRuntime {
  /** Adapter identity. "cloud" | "sim" | "island" | ... */
  readonly name: string;

  /** Session identity. Available once a session is active. */
  readonly info: MentraSessionInfo;

  onReady(handler: (info: MentraSessionInfo) => void): void;
  onStopped(handler: (reason: string) => void): void;
  onReconnected(handler: () => void): void;

  readonly display: DisplayRuntime;
  readonly transcription: TranscriptionRuntime;
  readonly mic: MicRuntime;
  readonly speaker: SpeakerRuntime;
  readonly camera: CameraRuntime;
  readonly device: DeviceRuntime;
  readonly location: LocationRuntime;
}

// ── Capability error ─────────────────────────────────────────────────────────

export class MentraRuntimeCapabilityError extends Error {
  readonly capability: string;
  readonly runtime: string;
  constructor(capability: string, runtime: string) {
    super(`${capability} is not supported by the "${runtime}" runtime.`);
    this.name = "MentraRuntimeCapabilityError";
    this.capability = capability;
    this.runtime = runtime;
  }
}
