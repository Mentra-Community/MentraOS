// src/messages/cloud-to-glasses.ts

import { Layout } from "../layouts";
import { CloudToGlassesMessageType, ResponseTypes, UpdateTypes } from "../message-types";

import { BaseMessage } from "./base";
// import { UserSession } from "../user-session";

//===========================================================
// Responses
//===========================================================

/**
 * Connection acknowledgment to glasses
 */
export interface ConnectionAck extends BaseMessage {
  type: CloudToGlassesMessageType.CONNECTION_ACK;
  // userSession: Partial<UserSession>;
  sessionId: string;
  livekit?: {
    url: string;
    roomName: string;
    token: string;
  };
  /**
   * UDP encryption info - only present if client requested encryption via ?udpEncryption=true
   * Client uses this symmetric key to encrypt UDP audio packets with secretbox
   */
  udpEncryption?: {
    /** Symmetric key for XSalsa20-Poly1305 encryption (base64 encoded, 32 bytes) */
    key: string;
    /** Encryption algorithm being used */
    algorithm: "xsalsa20-poly1305";
  };
}

/**
 * Connection error to glasses
 */
export interface ConnectionError extends BaseMessage {
  type: CloudToGlassesMessageType.CONNECTION_ERROR;
  code?: string;
  message: string;
}

/**
 * Authentication error to glasses
 */
export interface AuthError extends BaseMessage {
  type: CloudToGlassesMessageType.AUTH_ERROR;
  message: string;
}

//===========================================================
// Updates
//===========================================================

/**
 * Display update to glasses
 */
export interface DisplayEvent extends BaseMessage {
  type: CloudToGlassesMessageType.DISPLAY_EVENT;
  layout: Layout;
  durationMs?: number;
}

/**
 * App state change to glasses
 */
export interface AppStateChange extends BaseMessage {
  type: CloudToGlassesMessageType.APP_STATE_CHANGE;
  // userSession: Partial<UserSession>;
  error?: string;
}

/**
 * Microphone state change to glasses
 */
export interface MicrophoneStateChange extends BaseMessage {
  type: CloudToGlassesMessageType.MICROPHONE_STATE_CHANGE;
  // userSession: Partial<UserSession>;
  isMicrophoneEnabled: boolean;
  requiredData: Array<"pcm" | "transcription" | "pcm_or_transcription">;
  bypassVad?: boolean; // NEW: PCM subscription bypass
}

/**
 * Photo request to glasses
 */
export interface PhotoRequestToGlasses extends BaseMessage {
  type: CloudToGlassesMessageType.PHOTO_REQUEST;
  // userSession: Partial<UserSession>;
  requestId: string;
  appId: string;
  saveToGallery?: boolean;
  webhookUrl?: string; // URL where ASG should send the photo directly
  authToken?: string; // Auth token for webhook authentication
  /** Desired capture size to guide device resolution selection */
  size?: "small" | "medium" | "large" | "full";
  /** Image compression level: none, medium, or heavy */
  compress?: "none" | "medium" | "heavy";
  /** Silent mode: disables LED flash and shutter sound when true. Cloud-controlled based on packageName. */
  silent?: boolean;
}

/**
 * LED color type for RGB LED control
 */
export type LedColor = "red" | "green" | "blue" | "orange" | "white";

/**
 * RGB LED control request to glasses
 */
export interface RgbLedControlToGlasses extends BaseMessage {
  type: CloudToGlassesMessageType.RGB_LED_CONTROL;
  requestId: string;
  appId: string;
  action: "on" | "off"; // Only low-level on/off actions
  color?: LedColor; // LED color name
  ontime?: number;
  offtime?: number;
  count?: number;
}

// TODO(isaiah): Deprecated, remove this after new mobile client refactor complete, and we migrate to SettingsStateChange.
/**
 * Settings update to glasses
 */
export interface SettingsUpdate extends BaseMessage {
  type: CloudToGlassesMessageType.SETTINGS_UPDATE;
  sessionId: string;
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
}

/**
 * LiveKit info for client to connect & publish
 */
export interface LiveKitInfo extends BaseMessage {
  type: CloudToGlassesMessageType.LIVEKIT_INFO;
  url: string;
  roomName: string;
  token: string;
}

//===========================================================
// RTMP Streaming Commands
//===========================================================

/**
 * Start RTMP stream command to glasses
 */
export interface StartRtmpStream extends BaseMessage {
  type: CloudToGlassesMessageType.START_RTMP_STREAM;
  rtmpUrl: string;
  appId: string;
  streamId?: string;
  video?: any; // Video configuration
  audio?: any; // Audio configuration
  stream?: any; // Stream configuration
}

/**
 * Stop RTMP stream command to glasses
 */
export interface StopRtmpStream extends BaseMessage {
  type: CloudToGlassesMessageType.STOP_RTMP_STREAM;
  appId: string;
  streamId?: string;
}

/**
 * Keep RTMP stream alive command to glasses
 */
export interface KeepRtmpStreamAlive extends BaseMessage {
  type: CloudToGlassesMessageType.KEEP_RTMP_STREAM_ALIVE;
  streamId: string;
  ackId: string;
}

//===========================================================
// Location Service Commands
//===========================================================

/**
 * Sets the continuous location update tier on the device.
 */
export interface SetLocationTier extends BaseMessage {
  type: CloudToGlassesMessageType.SET_LOCATION_TIER;
  tier: "realtime" | "high" | "tenMeters" | "hundredMeters" | "kilometer" | "threeKilometers" | "reduced" | "standard";
}

/**
 * Requests a single, on-demand location fix from the device.
 */
export interface RequestSingleLocation extends BaseMessage {
  type: CloudToGlassesMessageType.REQUEST_SINGLE_LOCATION;
  accuracy: string; // The accuracy tier requested by the app
  correlationId: string; // To match the response with the poll request
}

/**
 * Audio play request to glasses
 */
export interface AudioPlayRequestToGlasses extends BaseMessage {
  type: CloudToGlassesMessageType.AUDIO_PLAY_REQUEST;
  // userSession: Partial<UserSession>;
  requestId: string;
  appId: string;
  audioUrl: string; // URL to audio file for download and play
  volume?: number; // Volume level 0.0-1.0, defaults to 1.0
  stopOtherAudio?: boolean; // Whether to stop other audio playback, defaults to true
}

/**
 * Audio stop request to glasses
 */
export interface AudioStopRequestToGlasses extends BaseMessage {
  type: CloudToGlassesMessageType.AUDIO_STOP_REQUEST;
  // userSession: Partial<UserSession>;
  appId: string;
}

/**
 * WiFi setup request to glasses/mobile
 */
export interface ShowWifiSetup extends BaseMessage {
  type: CloudToGlassesMessageType.SHOW_WIFI_SETUP;
  reason?: string;
  appPackageName?: string;
}

/**
 * UDP ping acknowledgment from cloud to mobile
 * Sent when the Go UDP listener receives a ping from the mobile client
 */
export interface UdpPingAck extends BaseMessage {
  type: CloudToGlassesMessageType.UDP_PING_ACK;
}

/**
 * Union type for all messages from cloud to glasses
 */
export type CloudToGlassesMessage =
  | ConnectionAck
  | ConnectionError
  | AuthError
  | DisplayEvent
  | AppStateChange
  | MicrophoneStateChange
  | PhotoRequestToGlasses
  | RgbLedControlToGlasses
  | AudioPlayRequestToGlasses
  | AudioStopRequestToGlasses
  | SettingsUpdate
  | StartRtmpStream
  | StopRtmpStream
  | KeepRtmpStreamAlive
  | SetLocationTier
  | RequestSingleLocation
  | LiveKitInfo
  | ShowWifiSetup
  | UdpPingAck;

//===========================================================
// Type guards
//===========================================================

export function isResponse(message: CloudToGlassesMessage): boolean {
  return ResponseTypes.includes(message.type as any);
}

export function isUpdate(message: CloudToGlassesMessage): boolean {
  return UpdateTypes.includes(message.type as any);
}

// Individual type guards
export function isConnectionAck(message: CloudToGlassesMessage): message is ConnectionAck {
  return message.type === CloudToGlassesMessageType.CONNECTION_ACK;
}

export function isConnectionError(message: CloudToGlassesMessage): message is ConnectionError {
  return message.type === CloudToGlassesMessageType.CONNECTION_ERROR;
}

export function isAuthError(message: CloudToGlassesMessage): message is AuthError {
  return message.type === CloudToGlassesMessageType.AUTH_ERROR;
}

export function isDisplayEvent(message: CloudToGlassesMessage): message is DisplayEvent {
  return message.type === CloudToGlassesMessageType.DISPLAY_EVENT;
}

export function isAppStateChange(message: CloudToGlassesMessage): message is AppStateChange {
  return message.type === CloudToGlassesMessageType.APP_STATE_CHANGE;
}

export function isMicrophoneStateChange(message: CloudToGlassesMessage): message is MicrophoneStateChange {
  return message.type === CloudToGlassesMessageType.MICROPHONE_STATE_CHANGE;
}

export function isPhotoRequest(message: CloudToGlassesMessage): message is PhotoRequestToGlasses {
  return message.type === CloudToGlassesMessageType.PHOTO_REQUEST;
}

export function isRgbLedControl(message: CloudToGlassesMessage): message is RgbLedControlToGlasses {
  return message.type === CloudToGlassesMessageType.RGB_LED_CONTROL;
}

export function isSettingsUpdate(message: CloudToGlassesMessage): message is SettingsUpdate {
  return message.type === CloudToGlassesMessageType.SETTINGS_UPDATE;
}

export function isStartRtmpStream(message: CloudToGlassesMessage): message is StartRtmpStream {
  return message.type === CloudToGlassesMessageType.START_RTMP_STREAM;
}

export function isStopRtmpStream(message: CloudToGlassesMessage): message is StopRtmpStream {
  return message.type === CloudToGlassesMessageType.STOP_RTMP_STREAM;
}

export function isKeepRtmpStreamAlive(message: CloudToGlassesMessage): message is KeepRtmpStreamAlive {
  return message.type === CloudToGlassesMessageType.KEEP_RTMP_STREAM_ALIVE;
}

export function isAudioPlayRequestToGlasses(message: CloudToGlassesMessage): message is AudioPlayRequestToGlasses {
  return message.type === CloudToGlassesMessageType.AUDIO_PLAY_REQUEST;
}

export function isAudioStopRequestToGlasses(message: CloudToGlassesMessage): message is AudioStopRequestToGlasses {
  return message.type === CloudToGlassesMessageType.AUDIO_STOP_REQUEST;
}
