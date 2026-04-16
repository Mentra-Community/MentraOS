// ── Glasses ──────────────────────────────────────────────────

export interface GlassesCapabilities {
  hasDisplay: boolean;
  hasCamera: boolean;
  hasMic: boolean;
  hasSpeaker: boolean;
  hasLight: boolean;
  hasButtons: boolean;
  hasTouchpad: boolean;
  hasWifi: boolean;
  displayWidth?: number;
  displayHeight?: number;
}

export interface GlassesInfo {
  connected: boolean;
  model: string | null;
  capabilities: GlassesCapabilities;
  batteryLevel: number | null;
  charging: boolean;
  micEnabled: boolean;
  firmwareVersion: string | null;
  serialNumber: string | null;
}

export const DEFAULT_GLASSES_INFO: GlassesInfo = {
  connected: false,
  model: null,
  capabilities: {
    hasDisplay: false,
    hasCamera: false,
    hasMic: false,
    hasSpeaker: false,
    hasLight: false,
    hasButtons: false,
    hasTouchpad: false,
    hasWifi: false,
  },
  batteryLevel: null,
  charging: false,
  micEnabled: false,
  firmwareVersion: null,
  serialNumber: null,
};

// ── Glasses Interface (what @mentra/glasses or simulated-glasses implements) ──

export interface GlassesDisplayManager {
  showText(text: string): void;
  showTextWall(text: string): void;
  clear(): void;
}

export interface GlassesCameraManager {
  takePhoto(options?: {
    size?: string;
    silent?: boolean;
  }): Promise<{ data: Uint8Array; mimeType: string; width: number; height: number }>;
}

export interface GlassesMicManager {
  start(): void;
  stop(): void;
  readonly active: boolean;
  onChunk(handler: (pcm: Uint8Array) => void): () => void;
}

export interface GlassesLedManager {
  set(options: { color: string; durationMs?: number }): void;
  off(): void;
}

export interface GlassesDeviceManager {
  readonly batteryLevel: number | null;
  readonly charging: boolean;
  readonly firmwareVersion: string | null;
  onButtonPress(handler: (event: ButtonEvent) => void): () => void;
  onTouch(handler: (event: TouchEvent) => void): () => void;
  onBatteryUpdate(handler: (level: number, charging: boolean) => void): () => void;
}

/** The contract between @mentra/client and any glasses implementation */
export interface Glasses {
  readonly model: string;
  readonly capabilities: GlassesCapabilities;
  readonly display: GlassesDisplayManager;
  readonly camera: GlassesCameraManager;
  readonly mic: GlassesMicManager;
  readonly led: GlassesLedManager;
  readonly device: GlassesDeviceManager;
  disconnect(): Promise<void>;
  isConnected(): boolean;
}

// ── Display ──────────────────────────────────────────────────

export type DisplayView = "main" | "dashboard";

export interface DisplayEvent {
  type: string;
  view: DisplayView;
  packageName: string;
  payload: Record<string, unknown>;
  durationMs?: number;
}

export interface DisplayState {
  currentEvent: DisplayEvent | null;
  mainEvent: DisplayEvent | null;
  dashboardEvent: DisplayEvent | null;
  activeView: DisplayView;
}

// ── Transcription ────────────────────────────────────────────

export interface TranscriptionEvent {
  text: string;
  isFinal: boolean;
  language?: string;
  speakerId?: string;
  confidence?: number;
}

// ── Apps ──────────────────────────────────────────────────────

export interface AppInfo {
  packageName: string;
  name: string;
  version?: string;
  running: boolean;
  loading: boolean;
  healthy: boolean;
  local: boolean;
  compatible: boolean;
  type: "standard" | "background" | "system_dashboard" | "system_appstore";
}

// ── Connection ───────────────────────────────────────────────

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

export interface ConnectionInfo {
  status: ConnectionStatus;
  url: string | null;
  error: string | null;
  sessionId: string | null;
  lastConnectedAt: Date | null;
  reconnectAttempts: number;
}

// ── Hardware Events ──────────────────────────────────────────

export interface ButtonEvent {
  buttonId: string;
  pressType: "short" | "long" | "double";
}

export interface TouchEvent {
  type:
    | "tap"
    | "swipe_forward"
    | "swipe_backward"
    | "swipe_up"
    | "swipe_down"
    | "hold";
  x?: number;
  y?: number;
}

// ── Errors ────────────────────────────────────────────────────

export interface MentraError {
  code: string;
  message: string;
  severity: "fatal" | "error" | "warning";
}

export class MentraCapabilityError extends Error {
  readonly capability: string;
  readonly model: string;

  constructor(capability: string, model: string) {
    super(`${capability} is not available on ${model}`);
    this.name = "MentraCapabilityError";
    this.capability = capability;
    this.model = model;
  }
}
