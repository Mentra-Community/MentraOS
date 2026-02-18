/**
 * Core client configuration and event types
 */

import { Layout } from "./sdk-types";

/**
 * Main client configuration
 */
export interface ClientConfig {
  // Required
  email: string;
  serverUrl: string;

  // Optional
  coreToken?: string;
  audio?: AudioConfig;
  device?: DeviceConfig;
  behavior?: BehaviorConfig;
  debug?: DebugConfig;
}

/**
 * Audio streaming configuration
 */
export interface AudioConfig {
  format: "pcm16" | "wav";
  sampleRate: number;
  chunkSize: number;
}

/**
 * Device simulation parameters
 */
export interface DeviceConfig {
  model: string;
  batteryLevel: number;
  brightness: number;
}

/**
 * Client behavior settings
 */
export interface BehaviorConfig {
  statusUpdateInterval?: number;
  locationUpdateInterval?: number;
  reconnectOnDisconnect?: boolean;
  disableStatusUpdates?: boolean;
  useLiveKitAudio?: boolean; // Enable LiveKit for audio transport instead of WebSocket
}

/**
 * Debugging and logging options
 */
export interface DebugConfig {
  logLevel?: "debug" | "info" | "warn" | "error";
  saveMetrics?: boolean;
  logWebSocketMessages?: boolean;
}

/**
 * Audio stream interface for cross-platform compatibility
 */
export interface AudioStream {
  on(event: "data", listener: (chunk: Buffer) => void): this;
  on(event: "end", listener: () => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  pipe?: (destination: any) => any;
}

/**
 * Event types emitted by the client
 */
export interface DisplayEvent {
  layout: Layout;
  timestamp: Date;
}

export interface AppStateChange {
  userSession: {
    activeAppSessions: string[];
    loadingApps: string[];
    isTranscribing: boolean;
  };
  timestamp: Date;
}

export interface ConnectionAck {
  sessionId: string;
  userSession: any;
  timestamp: Date;
  livekit?: {
    url: string;
    roomName: string;
    token: string;
  };
}

export interface SettingsUpdate {
  settings: {
    useOnboardMic: boolean;
    contextualDashboard: boolean;
    metricSystemEnabled: boolean;
    headUpAngle: number;
    brightness: number;
    autoBrightness: boolean;
    sensingEnabled: boolean;
    alwaysOnStatusBar: boolean;
    bypassVad: boolean;
    bypassAudioEncoding: boolean;
  };
  timestamp: Date;
}

export interface MicrophoneStateChange {
  isMicrophoneEnabled: boolean;
  bypassVad?: boolean; // NEW: VAD bypass flag for PCM subscriptions
  timestamp: Date;
}

/**
 * Account credentials (re-exported from AccountService)
 */
export interface AccountCredentials {
  email: string;
  coreToken: string;
}

/**
 * Core token payload structure (re-exported from AccountService)
 */
export interface CoreTokenPayload {
  sub: string;
  email: string;
  organizations: any[];
  defaultOrg: any;
  iat?: number;
}
