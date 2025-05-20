// src/messages/cloud-to-tpa.ts

import { BaseMessage } from './base';
import { CloudToTpaMessageType } from '../message-types';
import { StreamType } from '../streams';
import { AppSettings, TpaConfig } from '../models';
import { LocationUpdate, CalendarEvent } from './glasses-to-cloud';
import { DashboardMode } from '../dashboard';
import { TpaSession } from 'src/tpa/session';

//===========================================================
// Responses
//===========================================================

/**
 * Connection acknowledgment to TPA
 */
export interface TpaConnectionAck extends BaseMessage {
  type: CloudToTpaMessageType.CONNECTION_ACK;
  settings?: AppSettings;
  config?: TpaConfig; // TPA config sent from cloud
}

/**
 * Connection error to TPA
 */
export interface TpaConnectionError extends BaseMessage {
  type: CloudToTpaMessageType.CONNECTION_ERROR;
  message: string;
  code?: string;
}

//===========================================================
// Updates
//===========================================================

/**
 * App stopped notification to TPA
 */
export interface AppStopped extends BaseMessage {
  type: CloudToTpaMessageType.APP_STOPPED;
  reason: "user_disabled" | "system_stop" | "error";
  message?: string;
}

/**
 * Settings update to TPA
 */
export interface SettingsUpdate extends BaseMessage {
  type: CloudToTpaMessageType.SETTINGS_UPDATE;
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
  type: CloudToTpaMessageType.DATA_STREAM;
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
  type: CloudToTpaMessageType.DASHBOARD_MODE_CHANGED;
  mode: DashboardMode;
}

/**
 * Dashboard always-on state changed notification
 */
export interface DashboardAlwaysOnChanged extends BaseMessage {
  type: CloudToTpaMessageType.DASHBOARD_ALWAYS_ON_CHANGED;
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
  type: CloudToTpaMessageType.CUSTOM_MESSAGE;
  action: string;  // Identifies the specific action/message type
  payload: any;    // Custom data payload
}

/**
 * Photo response to TPA
 */
export interface PhotoResponse extends BaseMessage {
  type: CloudToTpaMessageType.PHOTO_RESPONSE;
  photoUrl: string;
  requestId: string;
}

/**
 * Video stream response to TPA
 */
export interface VideoStreamResponse extends BaseMessage {
  type: CloudToTpaMessageType.VIDEO_STREAM_RESPONSE;
  streamUrl: string;
  appId: string;
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
  type: CloudToTpaMessageType.CUSTOM_MESSAGE;
  action: string;  // Identifies the specific action/message type
  payload: any;    // Custom data payload
}

/**
 * Union type for all messages from cloud to TPAs
 */
export type CloudToTpaMessage =
  | TpaConnectionAck
  | TpaConnectionError
  | StandardConnectionError
  | AppStopped
  | SettingsUpdate
  | TranscriptionData
  | TranslationData
  | AudioChunk
  | LocationUpdate
  | CalendarEvent
  | DataStream
  | PhotoResponse
  | VideoStreamResponse
  | DashboardModeChanged
  | DashboardAlwaysOnChanged
  | CustomMessage
  | AugmentosSettingsUpdate
  | CustomMessage;

//===========================================================
// Type guards
//===========================================================

export function isTpaConnectionAck(message: CloudToTpaMessage): message is TpaConnectionAck {
  return message.type === CloudToTpaMessageType.CONNECTION_ACK;
}

export function isTpaConnectionError(message: CloudToTpaMessage): message is TpaConnectionError {
  return message.type === CloudToTpaMessageType.CONNECTION_ERROR || message.type === 'connection_error';
}

export function isAppStopped(message: CloudToTpaMessage): message is AppStopped {
  return message.type === CloudToTpaMessageType.APP_STOPPED;
}

export function isSettingsUpdate(message: CloudToTpaMessage): message is SettingsUpdate {
  return message.type === CloudToTpaMessageType.SETTINGS_UPDATE;
}

export function isDataStream(message: CloudToTpaMessage): message is DataStream {
  return message.type === CloudToTpaMessageType.DATA_STREAM || message.type === StreamType.AUDIO_CHUNK;
}

export function isAudioChunk(message: CloudToTpaMessage): message is AudioChunk {
  return message.type === StreamType.AUDIO_CHUNK;
}

export function isPhotoResponse(message: CloudToTpaMessage): message is PhotoResponse {
  return message.type === CloudToTpaMessageType.PHOTO_RESPONSE;
}

export function isVideoStreamResponse(message: CloudToTpaMessage): message is VideoStreamResponse {
  return message.type === CloudToTpaMessageType.VIDEO_STREAM_RESPONSE;
}

export function isDashboardModeChanged(message: CloudToTpaMessage): message is DashboardModeChanged {
  return message.type === CloudToTpaMessageType.DASHBOARD_MODE_CHANGED;
}

export function isDashboardAlwaysOnChanged(message: CloudToTpaMessage): message is DashboardAlwaysOnChanged {
  return message.type === CloudToTpaMessageType.DASHBOARD_ALWAYS_ON_CHANGED;
}