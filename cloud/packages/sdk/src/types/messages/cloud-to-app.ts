// src/messages/cloud-to-app.ts

import {BaseMessage} from "./base"
import {CloudToAppMessageType, GlassesToCloudMessageType} from "../message-types"
import {ExtendedStreamType, StreamType} from "../streams"
import type {AppSettings, AppConfig} from "../models"
import type {DashboardMode} from "../dashboard"
import type {Capabilities} from "../capabilities"
import type {
  LocationUpdate,
  CalendarEvent,
  RtmpStreamStatus,
  PhotoResponse,
  RgbLedControlResponse,
} from "./glasses-to-cloud"
import type {AppSession} from "../../app/session"
import type {GlassesInfo} from "@mentra/types"

//===========================================================
// Responses
//===========================================================

/**
 * Connection acknowledgment to App
 */
export interface AppConnectionAck extends BaseMessage {
  type: CloudToAppMessageType.CONNECTION_ACK
  settings?: AppSettings
  mentraosSettings?: Record<string, any> // MentraOS system settings
  config?: AppConfig // App config sent from cloud
  capabilities?: Capabilities // Device capability profile
}

/**
 * Connection error to App
 */
export interface AppConnectionError extends BaseMessage {
  type: CloudToAppMessageType.CONNECTION_ERROR
  message: string
  code?: string
}

//===========================================================
// Permission messages
//===========================================================

/**
 * Permission error detail for a specific stream
 */
export interface PermissionErrorDetail {
  /** The stream type that was rejected */
  stream: string
  /** The permission required for this stream */
  requiredPermission: string
  /** Detailed message explaining the rejection */
  message: string
}

/**
 * Permission error notification to App
 * Sent when subscriptions are rejected due to missing permissions
 */
export interface PermissionError extends BaseMessage {
  type: CloudToAppMessageType.PERMISSION_ERROR
  /** General error message */
  message: string
  /** Array of details for each rejected stream */
  details: PermissionErrorDetail[]
}

//===========================================================
// Updates
//===========================================================

/**
 * App stopped notification to App
 */
export interface AppStopped extends BaseMessage {
  type: CloudToAppMessageType.APP_STOPPED
  reason: "user_disabled" | "system_stop" | "error"
  message?: string
}

/**
 * Settings update to App
 */
export interface SettingsUpdate extends BaseMessage {
  type: CloudToAppMessageType.SETTINGS_UPDATE
  packageName: string
  settings: AppSettings
}

/**
 * Device capabilities update to App
 * Sent when the connected glasses model changes or capabilities are updated
 */
export interface CapabilitiesUpdate extends BaseMessage {
  type: CloudToAppMessageType.CAPABILITIES_UPDATE
  capabilities: Capabilities | null
  modelName: string | null
}

/**
 * Device state update to App
 * Sent when any device state changes (WiFi, battery, hotspot, connection, etc.)
 * Apps receive this automatically - no subscription needed
 */
export interface DeviceStateUpdate extends BaseMessage {
  type: CloudToAppMessageType.DEVICE_STATE_UPDATE
  state: Partial<GlassesInfo> // Only changed fields (or full snapshot)
  fullSnapshot?: boolean // True on initial connection or reconnection
  timestamp: Date
}

/**
 * MentraOS settings update to App
 */
export interface MentraosSettingsUpdate extends BaseMessage {
  type: "augmentos_settings_update"
  sessionId: string
  settings: Record<string, any>
  timestamp: Date
}

//===========================================================
// Audio-related data types
//===========================================================
/**
 * Transcription data
 */
export interface TranscriptionData extends BaseMessage {
  type: StreamType.TRANSCRIPTION
  text: string // The transcribed text
  isFinal: boolean // Whether this is a final transcription
  utteranceId?: string // Unique ID for this speech segment - interim and final for same utterance share the same ID
  transcribeLanguage?: string // Subscription language code (used for routing, e.g., "en-US")
  detectedLanguage?: string // Actual detected language from speech recognition (e.g., "ja", "en")
  startTime: number // Start time in milliseconds
  endTime: number // End time in milliseconds
  speakerId?: string // ID of the speaker if available (from diarization)
  duration?: number // Audio duration in milliseconds
  provider?: string // The transcription provider (e.g., "azure", "soniox")
  confidence?: number // Confidence score (0-1)
  metadata?: TranscriptionMetadata // Token-level metadata (always included)
}

/**
 * Metadata for transcription containing token-level details
 */
export interface TranscriptionMetadata {
  provider: "soniox" | "azure" | string
  soniox?: {
    tokens: SonioxToken[]
  }
  azure?: {
    // Azure-specific metadata can be added later
    tokens?: any[]
  }
  alibaba?: {
    // Alibaba-specific metadata can be added later
    tokens?: any[]
  }
}

/**
 * Soniox token with word-level details
 */
export interface SonioxToken {
  text: string
  startMs?: number
  endMs?: number
  confidence: number
  isFinal: boolean
  speaker?: string
}

/**
 * Translation data
 */
export interface TranslationData extends BaseMessage {
  type: StreamType.TRANSLATION
  text: string // The transcribed text
  originalText?: string // The original transcribed text before translation
  isFinal: boolean // Whether this is a final transcription
  startTime: number // Start time in milliseconds
  endTime: number // End time in milliseconds
  speakerId?: string // ID of the speaker if available
  duration?: number // Audio duration in milliseconds
  transcribeLanguage?: string // The language code of the transcribed text
  translateLanguage?: string // The language code of the translated text
  didTranslate?: boolean // Whether the text was translated
  provider?: string // The translation provider (e.g., "azure", "google")
  confidence?: number // Confidence score (0-1)
}

/**
 * Audio chunk data
 */
export interface AudioChunk extends BaseMessage {
  type: StreamType.AUDIO_CHUNK
  arrayBuffer: ArrayBufferLike // The audio data
  sampleRate?: number // Audio sample rate (e.g., 16000 Hz)
}

/**
 * Tool call from cloud to App
 * Represents a tool invocation with filled parameters
 */
export interface ToolCall {
  toolId: string // The ID of the tool that was called
  toolParameters: Record<string, string | number | boolean> // The parameters of the tool that was called
  timestamp: Date // Timestamp when the tool was called
  userId: string // ID of the user who triggered the tool call
  activeSession: AppSession | null
}

//===========================================================
// Stream data
//===========================================================

/**
 * Stream data to App
 */
export interface DataStream extends BaseMessage {
  type: CloudToAppMessageType.DATA_STREAM
  streamType: ExtendedStreamType
  data: unknown // Type depends on the streamType
}

//===========================================================
// Dashboard messages
//===========================================================

/**
 * Dashboard mode changed notification
 */
export interface DashboardModeChanged extends BaseMessage {
  type: CloudToAppMessageType.DASHBOARD_MODE_CHANGED
  mode: DashboardMode
}

/**
 * Dashboard always-on state changed notification
 */
export interface DashboardAlwaysOnChanged extends BaseMessage {
  type: CloudToAppMessageType.DASHBOARD_ALWAYS_ON_CHANGED
  enabled: boolean
}

/**
 * Standard connection error (for server compatibility)
 */
export interface StandardConnectionError extends BaseMessage {
  type: "connection_error"
  message: string
}

/**
 * Custom message for general-purpose communication (cloud to App)
 */
export interface CustomMessage extends BaseMessage {
  type: CloudToAppMessageType.CUSTOM_MESSAGE
  action: string // Identifies the specific action/message type
  payload: any // Custom data payload
}

/**
 * Output status for a re-stream destination
 */
export interface OutputStatus {
  /** The destination URL */
  url: string
  /** Friendly name if provided */
  name?: string
  /** Status of this output */
  status: "active" | "error" | "stopped"
  /** Error message if status is error */
  error?: string
}

/**
 * Managed RTMP stream status update
 * Sent when managed stream status changes or URLs are ready
 */
export interface ManagedStreamStatus extends BaseMessage {
  type: CloudToAppMessageType.MANAGED_STREAM_STATUS
  status: "initializing" | "preparing" | "active" | "stopping" | "stopped" | "error"
  hlsUrl?: string
  dashUrl?: string
  webrtcUrl?: string
  /** Cloudflare Stream player/preview URL for embedding */
  previewUrl?: string
  /** Thumbnail image URL */
  thumbnailUrl?: string
  message?: string
  streamId?: string
  /** Status of re-stream outputs if configured */
  outputs?: OutputStatus[]
}

/**
 * Stream status check response
 * Returns information about any existing streams for the user
 */
export interface StreamStatusCheckResponse extends BaseMessage {
  type: CloudToAppMessageType.STREAM_STATUS_CHECK_RESPONSE
  hasActiveStream: boolean
  streamInfo?: {
    type: "managed" | "unmanaged"
    streamId: string
    status: string
    createdAt: Date
    // For managed streams
    hlsUrl?: string
    dashUrl?: string
    webrtcUrl?: string
    previewUrl?: string
    thumbnailUrl?: string
    activeViewers?: number
    // For unmanaged streams
    rtmpUrl?: string
    requestingAppId?: string
  }
}

/**
 * Audio play response to App
 */
export interface AudioPlayResponse extends BaseMessage {
  type: CloudToAppMessageType.AUDIO_PLAY_RESPONSE
  requestId: string
  success: boolean
  error?: string // Error message (if failed)
  duration?: number // Duration of audio in milliseconds (if successful)
}

/**
 * Union type for all messages from cloud to Apps
 */
export type CloudToAppMessage =
  | AppConnectionAck
  | AppConnectionError
  | StandardConnectionError
  | DataStream
  | AppStopped
  | SettingsUpdate
  | CapabilitiesUpdate
  | DeviceStateUpdate
  | TranscriptionData
  | TranslationData
  | AudioChunk
  | LocationUpdate
  | CalendarEvent
  | PhotoResponse
  | DashboardModeChanged
  | DashboardAlwaysOnChanged
  | CustomMessage
  | ManagedStreamStatus
  | StreamStatusCheckResponse
  | MentraosSettingsUpdate
  // New App-to-App communication response messages
  | AppMessageReceived
  | AppUserJoined
  | AppUserLeft
  | AppRoomUpdated
  | AppDirectMessageResponse
  | RtmpStreamStatus
  | PhotoResponse
  | RgbLedControlResponse
  | PermissionError
  | AudioPlayResponse

//===========================================================
// Type guards
//===========================================================

export function isAppConnectionAck(message: CloudToAppMessage): message is AppConnectionAck {
  return message.type === CloudToAppMessageType.CONNECTION_ACK
}

export function isAppConnectionError(message: CloudToAppMessage): message is AppConnectionError {
  return message.type === CloudToAppMessageType.CONNECTION_ERROR || (message as any).type === "connection_error"
}

export function isAppStopped(message: CloudToAppMessage): message is AppStopped {
  return message.type === CloudToAppMessageType.APP_STOPPED
}

export function isSettingsUpdate(message: CloudToAppMessage): message is SettingsUpdate {
  return message.type === CloudToAppMessageType.SETTINGS_UPDATE
}

export function isCapabilitiesUpdate(message: CloudToAppMessage): message is CapabilitiesUpdate {
  return message.type === CloudToAppMessageType.CAPABILITIES_UPDATE
}

export function isDeviceStateUpdate(message: CloudToAppMessage): message is DeviceStateUpdate {
  return message.type === CloudToAppMessageType.DEVICE_STATE_UPDATE
}

export function isDataStream(message: CloudToAppMessage): message is DataStream {
  return message.type === CloudToAppMessageType.DATA_STREAM
}

export function isAudioChunk(message: CloudToAppMessage): message is AudioChunk {
  return message.type === StreamType.AUDIO_CHUNK
}

export function isDashboardModeChanged(message: CloudToAppMessage): message is DashboardModeChanged {
  return message.type === CloudToAppMessageType.DASHBOARD_MODE_CHANGED
}

export function isDashboardAlwaysOnChanged(message: CloudToAppMessage): message is DashboardAlwaysOnChanged {
  return message.type === CloudToAppMessageType.DASHBOARD_ALWAYS_ON_CHANGED
}

export function isManagedStreamStatus(message: CloudToAppMessage): message is ManagedStreamStatus {
  return message.type === CloudToAppMessageType.MANAGED_STREAM_STATUS
}

export function isRtmpStreamStatus(message: CloudToAppMessage): message is RtmpStreamStatus {
  return message.type === GlassesToCloudMessageType.RTMP_STREAM_STATUS
}

export function isPhotoResponse(message: CloudToAppMessage): message is PhotoResponse {
  return message.type === GlassesToCloudMessageType.PHOTO_RESPONSE
}

export function isRgbLedControlResponse(message: CloudToAppMessage): message is RgbLedControlResponse {
  return message.type === GlassesToCloudMessageType.RGB_LED_CONTROL_RESPONSE
}

export function isStreamStatusCheckResponse(message: CloudToAppMessage): message is StreamStatusCheckResponse {
  return message.type === CloudToAppMessageType.STREAM_STATUS_CHECK_RESPONSE
}

export function isAudioPlayResponse(message: CloudToAppMessage): message is AudioPlayResponse {
  return message.type === CloudToAppMessageType.AUDIO_PLAY_RESPONSE
}

// New type guards for App-to-App communication
export function isAppMessageReceived(message: CloudToAppMessage): message is AppMessageReceived {
  return message.type === CloudToAppMessageType.APP_MESSAGE_RECEIVED
}

export function isAppUserJoined(message: CloudToAppMessage): message is AppUserJoined {
  return message.type === CloudToAppMessageType.APP_USER_JOINED
}

export function isAppUserLeft(message: CloudToAppMessage): message is AppUserLeft {
  return message.type === CloudToAppMessageType.APP_USER_LEFT
}

//===========================================================
// App-to-App Communication Response Messages
//===========================================================

/**
 * Message received from another App user
 */
export interface AppMessageReceived extends BaseMessage {
  type: CloudToAppMessageType.APP_MESSAGE_RECEIVED
  payload: any
  messageId: string
  senderUserId: string
  senderSessionId: string
  roomId?: string
}

/**
 * Notification that a user joined the App
 */
export interface AppUserJoined extends BaseMessage {
  type: CloudToAppMessageType.APP_USER_JOINED
  userId: string
  sessionId: string
  joinedAt: Date
  userProfile?: any
  roomId?: string
}

/**
 * Notification that a user left the App
 */
export interface AppUserLeft extends BaseMessage {
  type: CloudToAppMessageType.APP_USER_LEFT
  userId: string
  sessionId: string
  leftAt: Date
  roomId?: string
}

/**
 * Room status update (members, config changes, etc.)
 */
export interface AppRoomUpdated extends BaseMessage {
  type: CloudToAppMessageType.APP_ROOM_UPDATED
  roomId: string
  updateType: "user_joined" | "user_left" | "config_changed" | "room_closed"
  roomData: {
    memberCount: number
    maxUsers?: number
    isPrivate?: boolean
    metadata?: any
  }
}

/**
 * Response to a direct message attempt
 */
export interface AppDirectMessageResponse extends BaseMessage {
  type: CloudToAppMessageType.APP_DIRECT_MESSAGE_RESPONSE
  messageId: string
  success: boolean
  error?: string
  targetUserId: string
}

//===========================================================
// Cloud-to-Sdk Communication Response Messages
//===========================================================

/**
 * Permission data structures for permission fetch responses
 */
export interface Permission {
  type: string // or a union/enum if you want stricter typing
  description: string
  _id: string
}

/**
 * Package permissions response structure
 */
export interface PackagePermissions {
  packageName: string
  permissions: Permission[]
}
