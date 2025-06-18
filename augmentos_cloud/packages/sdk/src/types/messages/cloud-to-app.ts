// src/messages/cloud-to-app.ts

import { BaseMessage } from './base';
import { CloudToAppMessageType, GlassesToCloudMessageType } from '../message-types';
import { StreamType } from '../streams';
import { AppSettings, AppConfig, PermissionType } from '../models';
import { LocationUpdate, CalendarEvent, RtmpStreamStatus, PhotoResponse } from './glasses-to-cloud';
import { DashboardMode } from '../dashboard';

//===========================================================
// Responses
//===========================================================

/**
 * Connection acknowledgment to TPA
 */
export interface AppConnectionAck extends BaseMessage {
  type: CloudToAppMessageType.CONNECTION_ACK;
  settings?: AppSettings;
  config?: AppConfig; // TPA config sent from cloud
}

/**
 * Connection error to TPA
 */
export interface AppConnectionError extends BaseMessage {
  type: CloudToAppMessageType.CONNECTION_ERROR;
  message: string;
  code?: string;
}

//===========================================================
// Permission messages
//===========================================================

/**
 * Permission error detail for a specific stream
 */
export interface PermissionErrorDetail {
  /** The stream type that was rejected */
  stream: string;
  /** The permission required for this stream */
  requiredPermission: string;
  /** Detailed message explaining the rejection */
  message: string;
}

/**
 * Permission error notification to TPA
 * Sent when subscriptions are rejected due to missing permissions
 */
export interface PermissionError extends BaseMessage {
  type: CloudToAppMessageType.PERMISSION_ERROR;
  /** General error message */
  message: string;
  /** Array of details for each rejected stream */
  details: PermissionErrorDetail[];
}

//===========================================================
// Updates
//===========================================================

/**
 * App stopped notification to TPA
 */
export interface AppStopped extends BaseMessage {
  type: CloudToAppMessageType.APP_STOPPED;
  reason: "user_disabled" | "system_stop" | "error";
  message?: string;
}

/**
 * Settings update to TPA
 */
export interface SettingsUpdate extends BaseMessage {
  type: CloudToAppMessageType.SETTINGS_UPDATE;
  packageName: string;
  settings: AppSettings;
}

/**
 * AugmentOS settings update to TPA
 */
export interface AugmentosSettingsUpdate extends BaseMessage {
  type: 'augmentos_settings_update';
  sessionId: string;
  settings: Record<string, any>;
  timestamp: Date;
}

//===========================================================
// Audio-related data types
//===========================================================
/**
 * Transcription data
 */
export interface TranscriptionData extends BaseMessage {
  type: StreamType.TRANSCRIPTION;
  text: string;  // The transcribed text
  isFinal: boolean;  // Whether this is a final transcription
  transcribeLanguage?: string;  // Detected language code
  startTime: number;  // Start time in milliseconds
  endTime: number;  // End time in milliseconds
  speakerId?: string;  // ID of the speaker if available
  duration?: number;  // Audio duration in milliseconds
}

/**
 * Translation data
 */
export interface TranslationData extends BaseMessage {
  type: StreamType.TRANSLATION;
  text: string;  // The transcribed text
  originalText?: string; // The original transcribed text before translation
  isFinal: boolean;  // Whether this is a final transcription
  startTime: number;  // Start time in milliseconds
  endTime: number;  // End time in milliseconds
  speakerId?: string;  // ID of the speaker if available
  duration?: number;  // Audio duration in milliseconds
  transcribeLanguage?: string;  // The language code of the transcribed text
  translateLanguage?: string;  // The language code of the translated text
  didTranslate?: boolean;  // Whether the text was translated
}

/**
 * Audio chunk data
 */
export interface AudioChunk extends BaseMessage {
  type: StreamType.AUDIO_CHUNK;
  arrayBuffer: ArrayBufferLike;  // The audio data
  sampleRate?: number;  // Audio sample rate (e.g., 16000 Hz)
}

/**
 * Tool call from cloud to TPA
 * Represents a tool invocation with filled parameters
 */
export interface ToolCall {
  toolId: string; // The ID of the tool that was called
  toolParameters: Record<string, string | number | boolean>; // The parameters of the tool that was called
  timestamp: Date; // Timestamp when the tool was called
  userId: string; // ID of the user who triggered the tool call
}

//===========================================================
// Stream data
//===========================================================

/**
 * Stream data to TPA
 */
export interface DataStream extends BaseMessage {
  type: CloudToAppMessageType.DATA_STREAM;
  streamType: StreamType;
  data: unknown; // Type depends on the streamType
}

//===========================================================
// Dashboard messages
//===========================================================

/**
 * Dashboard mode changed notification
 */
export interface DashboardModeChanged extends BaseMessage {
  type: CloudToAppMessageType.DASHBOARD_MODE_CHANGED;
  mode: DashboardMode;
}

/**
 * Dashboard always-on state changed notification
 */
export interface DashboardAlwaysOnChanged extends BaseMessage {
  type: CloudToAppMessageType.DASHBOARD_ALWAYS_ON_CHANGED;
  enabled: boolean;
}

/**
 * Standard connection error (for server compatibility)
 */
export interface StandardConnectionError extends BaseMessage {
  type: 'connection_error';
  message: string;
}

/**
 * Custom message for general-purpose communication (cloud to TPA)
 */
export interface CustomMessage extends BaseMessage {
  type: CloudToAppMessageType.CUSTOM_MESSAGE;
  action: string;  // Identifies the specific action/message type
  payload: any;    // Custom data payload
}

/**
 * Union type for all messages from cloud to TPAs
 */
export type CloudToAppMessage =
  | AppConnectionAck
  | AppConnectionError
  | StandardConnectionError
  | DataStream
  | AppStopped
  | SettingsUpdate
  | TranscriptionData
  | TranslationData
  | AudioChunk
  | LocationUpdate
  | CalendarEvent
  | DataStream
  | PhotoResponse
  | DashboardModeChanged
  | DashboardAlwaysOnChanged
  | CustomMessage
  | AugmentosSettingsUpdate
  // New TPA-to-TPA communication response messages
  | AppMessageReceived
  | AppUserJoined
  | AppUserLeft
  | AppRoomUpdated
  | AppDirectMessageResponse
  | RtmpStreamStatus
  | PhotoResponse
  | PermissionError;

//===========================================================
// Type guards
//===========================================================

export function isAppConnectionAck(message: CloudToAppMessage): message is AppConnectionAck {
  return message.type === CloudToAppMessageType.CONNECTION_ACK;
}

export function isAppConnectionError(message: CloudToAppMessage): message is AppConnectionError {
  return message.type === CloudToAppMessageType.CONNECTION_ERROR || (message as any).type === 'connection_error';
}

export function isAppStopped(message: CloudToAppMessage): message is AppStopped {
  return message.type === CloudToAppMessageType.APP_STOPPED;
}

export function isSettingsUpdate(message: CloudToAppMessage): message is SettingsUpdate {
  return message.type === CloudToAppMessageType.SETTINGS_UPDATE;
}

export function isDataStream(message: CloudToAppMessage): message is DataStream {
  return message.type === CloudToAppMessageType.DATA_STREAM;
}

export function isAudioChunk(message: CloudToAppMessage): message is AudioChunk {
  return message.type === StreamType.AUDIO_CHUNK;
}

export function isDashboardModeChanged(message: CloudToAppMessage): message is DashboardModeChanged {
  return message.type === CloudToAppMessageType.DASHBOARD_MODE_CHANGED;
}

export function isDashboardAlwaysOnChanged(message: CloudToAppMessage): message is DashboardAlwaysOnChanged {
  return message.type === CloudToAppMessageType.DASHBOARD_ALWAYS_ON_CHANGED;
}

export function isRtmpStreamStatus(message: CloudToAppMessage): message is RtmpStreamStatus {
  return message.type === GlassesToCloudMessageType.RTMP_STREAM_STATUS;
}

export function isPhotoResponse(message: CloudToAppMessage): message is PhotoResponse {
  return message.type === GlassesToCloudMessageType.PHOTO_RESPONSE;
}

// New type guards for TPA-to-TPA communication
export function isAppMessageReceived(message: CloudToAppMessage): message is AppMessageReceived {
  return message.type === CloudToAppMessageType.APP_MESSAGE_RECEIVED;
}

export function isTpaUserJoined(message: CloudToAppMessage): message is AppUserJoined {
  return message.type === CloudToAppMessageType.APP_USER_JOINED;
}

export function isTpaUserLeft(message: CloudToAppMessage): message is AppUserLeft {
  return message.type === CloudToAppMessageType.APP_USER_LEFT;
}

//===========================================================
// TPA-to-TPA Communication Response Messages
//===========================================================

/**
 * Message received from another TPA user
 */
export interface AppMessageReceived extends BaseMessage {
  type: CloudToAppMessageType.APP_MESSAGE_RECEIVED;
  payload: any;
  messageId: string;
  senderUserId: string;
  senderSessionId: string;
  roomId?: string;
}

/**
 * Notification that a user joined the TPA
 */
export interface AppUserJoined extends BaseMessage {
  type: CloudToAppMessageType.APP_USER_JOINED;
  userId: string;
  sessionId: string;
  joinedAt: Date;
  userProfile?: any;
  roomId?: string;
}

/**
 * Notification that a user left the TPA
 */
export interface AppUserLeft extends BaseMessage {
  type: CloudToAppMessageType.APP_USER_LEFT;
  userId: string;
  sessionId: string;
  leftAt: Date;
  roomId?: string;
}

/**
 * Room status update (members, config changes, etc.)
 */
export interface AppRoomUpdated extends BaseMessage {
  type: CloudToAppMessageType.APP_ROOM_UPDATED;
  roomId: string;
  updateType: 'user_joined' | 'user_left' | 'config_changed' | 'room_closed';
  roomData: {
    memberCount: number;
    maxUsers?: number;
    isPrivate?: boolean;
    metadata?: any;
  };
}

/**
 * Response to a direct message attempt
 */
export interface AppDirectMessageResponse extends BaseMessage {
  type: CloudToAppMessageType.APP_DIRECT_MESSAGE_RESPONSE;
  messageId: string;
  success: boolean;
  error?: string;
  targetUserId: string;
}