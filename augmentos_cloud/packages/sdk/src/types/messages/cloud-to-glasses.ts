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
 * Video stream request to glasses
 */
export interface VideoStreamRequestToGlasses extends BaseMessage {
  type: CloudToGlassesMessageType.VIDEO_STREAM_REQUEST;
  userSession: Partial<UserSession>;
  appId: string;
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
  | VideoStreamRequestToGlasses
  | SettingsUpdate;

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

export function isVideoStreamRequest(message: CloudToGlassesMessage): message is VideoStreamRequestToGlasses {
  return message.type === CloudToGlassesMessageType.VIDEO_STREAM_REQUEST;
}