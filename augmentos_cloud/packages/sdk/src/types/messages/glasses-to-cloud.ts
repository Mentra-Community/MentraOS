// src/messages/glasses-to-cloud.ts

import { BaseMessage } from './base';
import { GlassesToCloudMessageType, ControlActionTypes, EventTypes } from '../message-types';
import { StreamType } from '../streams';
import { PhotoRequest } from './tpa-to-cloud';

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
  pressType: 'short' | 'long';
}

/**
 * Head position event from glasses
 */
export interface HeadPosition extends BaseMessage {
  type: GlassesToCloudMessageType.HEAD_POSITION;
  position: 'up' | 'down';
}

/**
 * Glasses battery update from glasses
 */
export interface GlassesBatteryUpdate extends BaseMessage {
  type: GlassesToCloudMessageType.GLASSES_BATTERY_UPDATE;
  level: number;  // 0-100
  charging: boolean;
  timeRemaining?: number;  // minutes
}

/**
 * Phone battery update from glasses
 */
export interface PhoneBatteryUpdate extends BaseMessage {
  type: GlassesToCloudMessageType.PHONE_BATTERY_UPDATE;
  level: number;  // 0-100
  charging: boolean;
  timeRemaining?: number;  // minutes
}

/**
 * Glasses connection state from glasses
 */
export interface GlassesConnectionState extends BaseMessage {
  type: GlassesToCloudMessageType.GLASSES_CONNECTION_STATE;
  modelName: string;
  status: string;
}

/**
 * Location update from glasses
 */
export interface LocationUpdate extends BaseMessage {
  type: GlassesToCloudMessageType.LOCATION_UPDATE | StreamType.LOCATION_UPDATE;
  lat: number;
  lng: number;
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
  priority: 'low' | 'normal' | 'high';
}

/**
 * Notification dismissed from glasses
 */
export interface NotificationDismissed extends BaseMessage {
  type: GlassesToCloudMessageType.NOTIFICATION_DISMISSED;
  notificationId: string;
}

/**
 * AugmentOS settings update from glasses
 */
export interface AugmentosSettingsUpdateRequest extends BaseMessage {
  type: GlassesToCloudMessageType.AUGMENTOS_SETTINGS_UPDATE_REQUEST;
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
export interface PhotoResponse extends BaseMessage {
  type: GlassesToCloudMessageType.PHOTO_RESPONSE;
  requestId: string;  // Unique ID for the photo request
  photoUrl: string;  // URL of the uploaded photo
  savedToGallery: boolean;  // Whether the photo was saved to gallery
}

export interface VideoStreamResponse extends BaseMessage {
  type: GlassesToCloudMessageType.VIDEO_STREAM_RESPONSE;
  requestId: string;  // Unique ID for the video stream request
  videoUrl: string;  // URL of the video stream
  savedToGallery: boolean;  // Whether the video was saved to gallery
}

/**
 * Union type for all messages from glasses to cloud
 */
export type GlassesToCloudMessage = 
  | ConnectionInit
  | RequestSettings
  | StartApp
  | StopApp
  | DashboardState
  | OpenDashboard
  | ButtonPress
  | HeadPosition
  | GlassesBatteryUpdate
  | PhoneBatteryUpdate
  | GlassesConnectionState
  | LocationUpdate
  | CalendarEvent
  | Vad
  | PhoneNotification
  | NotificationDismissed
  | AugmentosSettingsUpdateRequest
  | CoreStatusUpdate

  | PhotoResponse
  | VideoStreamResponse

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

export function isNotificationDismissed(message: GlassesToCloudMessage): message is NotificationDismissed {
  return message.type === GlassesToCloudMessageType.NOTIFICATION_DISMISSED;
}