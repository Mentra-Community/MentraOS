// src/messages/cloud-to-glasses.ts

import { BaseMessage } from './base';
import { CloudToGlassesMessageType, ResponseTypes, UpdateTypes } from '../message-types';
import { UserSession } from '../user-session';
import { Layout } from '../layouts';

//===========================================================
// Responses
//===========================================================

/**
 * Connection acknowledgment to glasses
 */
export interface ConnectionAck extends BaseMessage {
  type: CloudToGlassesMessageType.CONNECTION_ACK;
  userSession: Partial<UserSession>;
  sessionId: string;
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
  userSession: Partial<UserSession>;
  error?: string;
}

/**
 * Microphone state change to glasses
 */
export interface MicrophoneStateChange extends BaseMessage {
  type: CloudToGlassesMessageType.MICROPHONE_STATE_CHANGE;
  userSession: Partial<UserSession>;
  isMicrophoneEnabled: boolean;
}

/**
 * Photo request to glasses
 */
export interface PhotoRequestToGlasses extends BaseMessage {
  type: CloudToGlassesMessageType.PHOTO_REQUEST;
  userSession: Partial<UserSession>;
  requestId: string;
  appId: string;
  saveToGallery?: boolean;
}

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
  video?: any;  // Video configuration
  audio?: any;  // Audio configuration
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
  | SettingsUpdate
  | StartRtmpStream
  | StopRtmpStream
  | KeepRtmpStreamAlive;

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

