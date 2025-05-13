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
 * Settings update to glasses
 */
export interface SettingsUpdate extends BaseMessage {
  type: CloudToGlassesMessageType.SETTINGS_UPDATE;
  sessionId: string;
  settings: {
    useOnboardMic: boolean;
    contextualDashboard: boolean;
    headUpAngle: number;
    brightness: number;
    autoBrightness: boolean;
    sensingEnabled: boolean;
    alwaysOnStatusBar: boolean;
    bypassVad: boolean;
    bypassAudioEncoding: boolean;
    enablePhoneNotifications: boolean;
  };
}

/**
 * App started notification to glasses
 */
export interface AppStarted extends BaseMessage {
  type: CloudToGlassesMessageType.APP_STARTED;
  packageName: string;
  timestamp: Date;
}

/**
 * App stopped notification to glasses
 */
export interface AppStopped extends BaseMessage {
  type: CloudToGlassesMessageType.APP_STOPPED;
  packageName: string;
  timestamp: Date;
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
  | SettingsUpdate
  | AppStarted
  | AppStopped;

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