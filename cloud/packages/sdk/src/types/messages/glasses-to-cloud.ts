// src/messages/glasses-to-cloud.ts

import { GlassesToCloudMessageType, ControlActionTypes, EventTypes } from "../message-types";
import { StreamType } from "../streams";

import { BaseMessage } from "./base";

//===========================================================
// Control actions
//===========================================================

/**
 * Connection initialization from glasses
 */
export interface ConnectionInit extends BaseMessage {
  type: GlassesToCloudMessageType.CONNECTION_INIT;
  userId?: string;
  coreToken?: string;
}

/**
 * Client requests LiveKit info (url, room, token)
 */
export interface LiveKitInit extends BaseMessage {
  type: GlassesToCloudMessageType.LIVEKIT_INIT;
  mode?: "publish" | "subscribe"; // Optional mode - defaults to 'publish' for backward compatibility
}

export interface RequestSettings extends BaseMessage {
  type: GlassesToCloudMessageType.REQUEST_SETTINGS;
  sessionId: string;
}

/**
 * Start app request from glasses
 */
export interface StartApp extends BaseMessage {
  type: GlassesToCloudMessageType.START_APP;
  packageName: string;
}

/**
 * Stop app request from glasses
 */
export interface StopApp extends BaseMessage {
  type: GlassesToCloudMessageType.STOP_APP;
  packageName: string;
}

/**
 * Dashboard state update from glasses
 */
export interface DashboardState extends BaseMessage {
  type: GlassesToCloudMessageType.DASHBOARD_STATE;
  isOpen: boolean;
}

/**
 * Open dashboard request from glasses
 */
export interface OpenDashboard extends BaseMessage {
  type: GlassesToCloudMessageType.OPEN_DASHBOARD;
}

//===========================================================
// Events and data
//===========================================================

/**
 * Button press event from glasses
 */
export interface ButtonPress extends BaseMessage {
  type: GlassesToCloudMessageType.BUTTON_PRESS;
  buttonId: string;
  pressType: "short" | "long";
}

/**
 * Head position event from glasses
 */
export interface HeadPosition extends BaseMessage {
  type: GlassesToCloudMessageType.HEAD_POSITION;
  position: "up" | "down";
}

/**
 * Touch gesture event from glasses
 */
export interface TouchEvent extends BaseMessage {
  type: GlassesToCloudMessageType.TOUCH_EVENT;
  device_model: string;
  gesture_name: string;
  timestamp: Date;
}

/**
 * Glasses battery update from glasses
 */
export interface GlassesBatteryUpdate extends BaseMessage {
  type: GlassesToCloudMessageType.GLASSES_BATTERY_UPDATE;
  level: number; // 0-100
  charging: boolean;
  timeRemaining?: number; // minutes
}

/**
 * Phone battery update from glasses
 */
export interface PhoneBatteryUpdate extends BaseMessage {
  type: GlassesToCloudMessageType.PHONE_BATTERY_UPDATE;
  level: number; // 0-100
  charging: boolean;
  timeRemaining?: number; // minutes
}

/**
 * Glasses connection state from glasses
 */
export interface GlassesConnectionState extends BaseMessage {
  type: GlassesToCloudMessageType.GLASSES_CONNECTION_STATE;
  modelName: string;
  status: string;

  // Optional WiFi details (only present for WiFi-capable glasses)
  wifi?: {
    connected: boolean;
    ssid?: string | null;
  };
}

/**
 * Location update from glasses
 */
export interface LocationUpdate extends BaseMessage {
  type: GlassesToCloudMessageType.LOCATION_UPDATE | StreamType.LOCATION_UPDATE;
  lat: number;
  lng: number;
  accuracy?: number; // Accuracy in meters
  correlationId?: string; // for poll responses
}

/**
 * VPS coordinates update from glasses
 */
export interface VpsCoordinates extends BaseMessage {
  type: GlassesToCloudMessageType.VPS_COORDINATES | StreamType.VPS_COORDINATES;
  deviceModel: string;
  requestId: string;
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  confidence: number;
}

export interface LocalTranscription extends BaseMessage {
  type: GlassesToCloudMessageType.LOCAL_TRANSCRIPTION;
  text: string;
  isFinal: boolean;
  startTime: number;
  endTime: number;
  speakerId: number;
  transcribeLanguage: string;
  provider: string;
}

export interface CalendarEvent extends BaseMessage {
  type: GlassesToCloudMessageType.CALENDAR_EVENT | StreamType.CALENDAR_EVENT;
  eventId: string;
  title: string;
  dtStart: string;
  dtEnd: string;
  timezone: string;
  timeStamp: string;
}

/**
 * Voice activity detection from glasses
 */
export interface Vad extends BaseMessage {
  type: GlassesToCloudMessageType.VAD;
  status: boolean | "true" | "false";
}

/**
 * Phone notification from glasses
 */
export interface PhoneNotification extends BaseMessage {
  type: GlassesToCloudMessageType.PHONE_NOTIFICATION;
  notificationId: string;
  app: string;
  title: string;
  content: string;
  priority: "low" | "normal" | "high";
}

/**
 * Notification dismissed from glasses
 */
export interface PhoneNotificationDismissed extends BaseMessage {
  type: GlassesToCloudMessageType.PHONE_NOTIFICATION_DISMISSED;
  notificationId: string;
  app: string;
  title: string;
  content: string;
  notificationKey: string;
}

/**
 * MentraOS settings update from glasses
 */
export interface MentraosSettingsUpdateRequest extends BaseMessage {
  type: GlassesToCloudMessageType.MENTRAOS_SETTINGS_UPDATE_REQUEST;
}
export interface MentraosSettingsUpdateRequest extends BaseMessage {
  type: GlassesToCloudMessageType.MENTRAOS_SETTINGS_UPDATE_REQUEST;
}

/**
 * Core status update from glasses
 */
export interface CoreStatusUpdate extends BaseMessage {
  type: GlassesToCloudMessageType.CORE_STATUS_UPDATE;
  status: string;
  details?: Record<string, any>;
}

// ===========================================================
// Mentra Live
// ===========================================================

/**
 * Photo error codes for detailed error reporting
 */
export enum PhotoErrorCode {
  CAMERA_INIT_FAILED = "CAMERA_INIT_FAILED",
  CAMERA_CAPTURE_FAILED = "CAMERA_CAPTURE_FAILED",
  CAMERA_TIMEOUT = "CAMERA_TIMEOUT",
  CAMERA_BUSY = "CAMERA_BUSY",
  UPLOAD_FAILED = "UPLOAD_FAILED",
  UPLOAD_TIMEOUT = "UPLOAD_TIMEOUT",
  BLE_TRANSFER_FAILED = "BLE_TRANSFER_FAILED",
  BLE_TRANSFER_BUSY = "BLE_TRANSFER_BUSY",
  BLE_TRANSFER_FAILED_TO_START = "BLE_TRANSFER_FAILED_TO_START",
  BLE_TRANSFER_TIMEOUT = "BLE_TRANSFER_TIMEOUT",
  COMPRESSION_FAILED = "COMPRESSION_FAILED",
  PERMISSION_DENIED = "PERMISSION_DENIED",
  STORAGE_FULL = "STORAGE_FULL",
  NETWORK_ERROR = "NETWORK_ERROR",
  // Phone-side error codes
  PHONE_GLASSES_NOT_CONNECTED = "PHONE_GLASSES_NOT_CONNECTED",
  PHONE_BLE_TRANSFER_FAILED = "PHONE_BLE_TRANSFER_FAILED",
  PHONE_UPLOAD_FAILED = "PHONE_UPLOAD_FAILED",
  PHONE_TIMEOUT = "PHONE_TIMEOUT",
  UNKNOWN_ERROR = "UNKNOWN_ERROR",
}

/**
 * Photo processing stages for error context
 */
export enum PhotoStage {
  REQUEST_RECEIVED = "REQUEST_RECEIVED",
  CAMERA_INIT = "CAMERA_INIT",
  PHOTO_CAPTURE = "PHOTO_CAPTURE",
  COMPRESSION = "COMPRESSION",
  UPLOAD_START = "UPLOAD_START",
  UPLOAD_PROGRESS = "UPLOAD_PROGRESS",
  BLE_TRANSFER = "BLE_TRANSFER",
  RESPONSE_SENT = "RESPONSE_SENT",
}

/**
 * Connection state information for error diagnostics
 */
export interface ConnectionState {
  wifi: {
    connected: boolean;
    ssid?: string;
    hasInternet: boolean;
  };
  ble: {
    connected: boolean;
    transferInProgress: boolean;
  };
  camera: {
    available: boolean;
    initialized: boolean;
  };
  storage: {
    availableSpace: number;
    totalSpace: number;
  };
}

/**
 * Detailed error information for photo failures
 */
export interface PhotoErrorDetails {
  stage: PhotoStage;
  connectionState?: ConnectionState;
  retryable: boolean;
  suggestedAction?: string;
  diagnosticInfo?: {
    timestamp: number;
    duration: number;
    retryCount: number;
    lastSuccessfulStage?: PhotoStage;
  };
}

/**
 * Enhanced photo response with error support
 */
export interface PhotoResponse extends BaseMessage {
  type: GlassesToCloudMessageType.PHOTO_RESPONSE;
  requestId: string; // Unique ID for the photo request
  success: boolean; // Explicit success/failure flag

  // Success fields (only present when success = true)
  photoUrl?: string; // URL of the uploaded photo
  savedToGallery?: boolean; // Whether the photo was saved to gallery

  // Error fields (only present when success = false)
  error?: {
    code: PhotoErrorCode;
    message: string;
    details?: PhotoErrorDetails;
  };
}

/**
 * RGB LED control response from glasses
 */
export interface RgbLedControlResponse extends BaseMessage {
  type: GlassesToCloudMessageType.RGB_LED_CONTROL_RESPONSE;
  requestId: string;
  success: boolean;
  error?: string;
}

/**
 * RTMP stream status update from glasses
 */
export interface RtmpStreamStatus extends BaseMessage {
  type: GlassesToCloudMessageType.RTMP_STREAM_STATUS;
  streamId?: string; // Unique identifier for the stream
  status:
    | "initializing"
    | "connecting"
    | "reconnecting"
    | "streaming"
    | "error"
    | "stopped"
    | "active"
    | "stopping"
    | "disconnected"
    | "timeout"
    | "reconnected"
    | "reconnect_failed";
  errorDetails?: string;
  appId?: string; // ID of the app that requested the stream
  stats?: {
    bitrate: number;
    fps: number;
    droppedFrames: number;
    duration: number;
  };
}

/**
 * Keep-alive acknowledgment from glasses
 */
export interface KeepAliveAck extends BaseMessage {
  type: GlassesToCloudMessageType.KEEP_ALIVE_ACK;
  streamId: string; // ID of the stream being kept alive
  ackId: string; // Acknowledgment ID that was sent by cloud
}

/**
 * Photo taken event from glasses
 */
export interface PhotoTaken extends BaseMessage {
  type: GlassesToCloudMessageType.PHOTO_TAKEN;
  photoData: ArrayBuffer;
  mimeType: string;
  timestamp: Date;
}

/**
 * Audio play response from glasses/core
 */
export interface AudioPlayResponse extends BaseMessage {
  type: GlassesToCloudMessageType.AUDIO_PLAY_RESPONSE;
  requestId: string;
  success: boolean;
  error?: string;
  duration?: number;
}

/**
 * UDP audio registration request from glasses/phone
 * Mobile sends this to register its userIdHash for UDP audio routing
 */
export interface UdpRegister extends BaseMessage {
  type: GlassesToCloudMessageType.UDP_REGISTER;
  userIdHash: number; // FNV-1a 32-bit hash of userId
}

/**
 * UDP audio unregistration request from glasses/phone
 * Mobile sends this when stopping UDP audio
 */
export interface UdpUnregister extends BaseMessage {
  type: GlassesToCloudMessageType.UDP_UNREGISTER;
  userIdHash: number; // FNV-1a 32-bit hash of userId
}

/**
 * Union type for all messages from glasses to cloud
 */
export type GlassesToCloudMessage =
  | ConnectionInit
  | LiveKitInit
  | RequestSettings
  | StartApp
  | StopApp
  | DashboardState
  | OpenDashboard
  | ButtonPress
  | HeadPosition
  | TouchEvent
  | GlassesBatteryUpdate
  | PhoneBatteryUpdate
  | GlassesConnectionState
  | LocationUpdate
  | VpsCoordinates
  | CalendarEvent
  | Vad
  | PhoneNotification
  | PhoneNotificationDismissed
  | MentraosSettingsUpdateRequest
  | CoreStatusUpdate
  | RtmpStreamStatus
  | KeepAliveAck
  | PhotoResponse
  | RgbLedControlResponse
  | PhotoTaken
  | AudioPlayResponse
  | LocalTranscription
  | UdpRegister
  | UdpUnregister;

//===========================================================
// Type guards
//===========================================================

export function isControlAction(message: GlassesToCloudMessage): boolean {
  return ControlActionTypes.includes(message.type as any);
}

export function isEvent(message: GlassesToCloudMessage): boolean {
  return EventTypes.includes(message.type as any);
}

// Individual type guards
export function isConnectionInit(message: GlassesToCloudMessage): message is ConnectionInit {
  return message.type === GlassesToCloudMessageType.CONNECTION_INIT;
}

export function isRequestSettings(message: GlassesToCloudMessage): message is RequestSettings {
  return message.type === GlassesToCloudMessageType.REQUEST_SETTINGS;
}

export function isStartApp(message: GlassesToCloudMessage): message is StartApp {
  return message.type === GlassesToCloudMessageType.START_APP;
}

export function isStopApp(message: GlassesToCloudMessage): message is StopApp {
  return message.type === GlassesToCloudMessageType.STOP_APP;
}

export function isButtonPress(message: GlassesToCloudMessage): message is ButtonPress {
  return message.type === GlassesToCloudMessageType.BUTTON_PRESS;
}

export function isHeadPosition(message: GlassesToCloudMessage): message is HeadPosition {
  return message.type === GlassesToCloudMessageType.HEAD_POSITION;
}

export function isGlassesBatteryUpdate(message: GlassesToCloudMessage): message is GlassesBatteryUpdate {
  return message.type === GlassesToCloudMessageType.GLASSES_BATTERY_UPDATE;
}

export function isPhoneBatteryUpdate(message: GlassesToCloudMessage): message is PhoneBatteryUpdate {
  return message.type === GlassesToCloudMessageType.PHONE_BATTERY_UPDATE;
}

export function isGlassesConnectionState(message: GlassesToCloudMessage): message is GlassesConnectionState {
  return message.type === GlassesToCloudMessageType.GLASSES_CONNECTION_STATE;
}

export function isLocationUpdate(message: GlassesToCloudMessage): message is LocationUpdate {
  return message.type === GlassesToCloudMessageType.LOCATION_UPDATE;
}

export function isCalendarEvent(message: GlassesToCloudMessage): message is CalendarEvent {
  return message.type === GlassesToCloudMessageType.CALENDAR_EVENT;
}

export function isVad(message: GlassesToCloudMessage): message is Vad {
  return message.type === GlassesToCloudMessageType.VAD;
}

export function isPhoneNotification(message: GlassesToCloudMessage): message is PhoneNotification {
  return message.type === GlassesToCloudMessageType.PHONE_NOTIFICATION;
}

export function isPhoneNotificationDismissed(message: GlassesToCloudMessage): message is PhoneNotificationDismissed {
  return message.type === GlassesToCloudMessageType.PHONE_NOTIFICATION_DISMISSED;
}

export function isRtmpStreamStatus(message: GlassesToCloudMessage): message is RtmpStreamStatus {
  return message.type === GlassesToCloudMessageType.RTMP_STREAM_STATUS;
}

export function isPhotoResponse(message: GlassesToCloudMessage): message is PhotoResponse {
  return message.type === GlassesToCloudMessageType.PHOTO_RESPONSE;
}

export function isRgbLedControlResponse(message: GlassesToCloudMessage): message is RgbLedControlResponse {
  return message.type === GlassesToCloudMessageType.RGB_LED_CONTROL_RESPONSE;
}

export function isKeepAliveAck(message: GlassesToCloudMessage): message is KeepAliveAck {
  return message.type === GlassesToCloudMessageType.KEEP_ALIVE_ACK;
}

export function isPhotoTaken(message: GlassesToCloudMessage): message is PhotoTaken {
  return message.type === GlassesToCloudMessageType.PHOTO_TAKEN;
}

export function isAudioPlayResponse(message: GlassesToCloudMessage): message is AudioPlayResponse {
  return message.type === GlassesToCloudMessageType.AUDIO_PLAY_RESPONSE;
}

export function isLocalTranscription(message: GlassesToCloudMessage): message is LocalTranscription {
  return message.type === GlassesToCloudMessageType.LOCAL_TRANSCRIPTION;
}

export function isUdpRegister(message: GlassesToCloudMessage): message is UdpRegister {
  return message.type === GlassesToCloudMessageType.UDP_REGISTER;
}

export function isUdpUnregister(message: GlassesToCloudMessage): message is UdpUnregister {
  return message.type === GlassesToCloudMessageType.UDP_UNREGISTER;
}
