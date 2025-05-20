// src/message-types.ts

import { StreamType } from "./streams";

/**
 * Types of messages from glasses to cloud
 */
export enum GlassesToCloudMessageType {
  // Control actions
  CONNECTION_INIT = 'connection_init',
  REQUEST_SETTINGS = 'request_settings',
  // START_APP = 'start_app',
  // STOP_APP = 'stop_app',

  START_APP = StreamType.START_APP,
  STOP_APP = StreamType.STOP_APP,

  DASHBOARD_STATE = 'dashboard_state',
  OPEN_DASHBOARD = StreamType.OPEN_DASHBOARD,

  // Mentra Live
  PHOTO_RESPONSE = 'photo_response',
  VIDEO_STREAM_RESPONSE = 'video_stream_response',
  // photo_response = 'photo_response',
  // video_stream_response = 'video_stream_response',
  
  // OPEN_DASHBOARD = 'open_dashboard',
  // Events and data
  // BUTTON_PRESS = 'button_press',
  // HEAD_POSITION = 'head_position',
  // GLASSES_BATTERY_UPDATE = 'glasses_battery_update',
  // PHONE_BATTERY_UPDATE = 'phone_battery_update',
  // GLASSES_CONNECTION_STATE = 'glasses_connection_state',
  // LOCATION_UPDATE = 'location_update',
  // PHONE_NOTIFICATION = 'phone_notification',
  // NOTIFICATION_DISMISSED = 'notification_dismissed'

  BUTTON_PRESS = StreamType.BUTTON_PRESS,
  HEAD_POSITION = StreamType.HEAD_POSITION,
  GLASSES_BATTERY_UPDATE = StreamType.GLASSES_BATTERY_UPDATE,
  PHONE_BATTERY_UPDATE = StreamType.PHONE_BATTERY_UPDATE,
  GLASSES_CONNECTION_STATE = StreamType.GLASSES_CONNECTION_STATE,
  LOCATION_UPDATE = StreamType.LOCATION_UPDATE,
  VAD = StreamType.VAD,
  PHONE_NOTIFICATION = StreamType.PHONE_NOTIFICATION,
  NOTIFICATION_DISMISSED = StreamType.NOTIFICATION_DISMISSED,
  CALENDAR_EVENT = StreamType.CALENDAR_EVENT,
  AUGMENTOS_SETTINGS_UPDATE_REQUEST = StreamType.AUGMENTOS_SETTINGS_UPDATE_REQUEST,
  CORE_STATUS_UPDATE = StreamType.CORE_STATUS_UPDATE
}

/**
 * Types of messages from cloud to glasses
 */
export enum CloudToGlassesMessageType {
  // Responses
  CONNECTION_ACK = 'connection_ack',
  CONNECTION_ERROR = 'connection_error',
  AUTH_ERROR = 'auth_error',
  
  // Updates
  DISPLAY_EVENT = 'display_event',
  APP_STATE_CHANGE = 'app_state_change',
  MICROPHONE_STATE_CHANGE = 'microphone_state_change',
  PHOTO_REQUEST = 'photo_request',
  VIDEO_STREAM_REQUEST = 'video_stream_request',
  SETTINGS_UPDATE = 'settings_update',
  
  // Dashboard updates
  DASHBOARD_MODE_CHANGE = 'dashboard_mode_change',
  DASHBOARD_ALWAYS_ON_CHANGE = 'dashboard_always_on_change',

  WEBSOCKET_ERROR = 'websocket_error'
}

/**
 * Types of messages from TPAs to cloud
 */
export enum TpaToCloudMessageType {
  // Commands
  CONNECTION_INIT = 'tpa_connection_init',
  SUBSCRIPTION_UPDATE = 'subscription_update',
  
  // Requests
  DISPLAY_REQUEST = 'display_event',
  PHOTO_REQUEST = 'photo_request',
  VIDEO_STREAM_REQUEST = 'video_stream_request',
  
  // Dashboard requests
  DASHBOARD_CONTENT_UPDATE = 'dashboard_content_update',
  DASHBOARD_MODE_CHANGE = 'dashboard_mode_change',
  DASHBOARD_SYSTEM_UPDATE = 'dashboard_system_update'
}

/**
 * Types of messages from cloud to TPAs
 */
export enum CloudToTpaMessageType {
  // Responses
  CONNECTION_ACK = 'tpa_connection_ack',
  CONNECTION_ERROR = 'tpa_connection_error',
  
  // Updates
  APP_STOPPED = 'app_stopped',
  SETTINGS_UPDATE = 'settings_update',
  
  // Dashboard updates
  DASHBOARD_MODE_CHANGED = 'dashboard_mode_changed',
  DASHBOARD_ALWAYS_ON_CHANGED = 'dashboard_always_on_changed',
  
  // Stream data
  DATA_STREAM = 'data_stream',
  
  // Media responses
  PHOTO_RESPONSE = 'photo_response',
  VIDEO_STREAM_RESPONSE = 'video_stream_response',

  WEBSOCKET_ERROR = 'websocket_error',
  
  // General purpose messaging
  CUSTOM_MESSAGE = 'custom_message'
}

/**
 * Control action message types (subset of GlassesToCloudMessageType)
 */
export const ControlActionTypes = [
  GlassesToCloudMessageType.CONNECTION_INIT,
  GlassesToCloudMessageType.START_APP,
  GlassesToCloudMessageType.STOP_APP,
  GlassesToCloudMessageType.DASHBOARD_STATE,
  GlassesToCloudMessageType.OPEN_DASHBOARD
] as const;

/**
 * Event message types (subset of GlassesToCloudMessageType)
 */
export const EventTypes = [
  GlassesToCloudMessageType.BUTTON_PRESS,
  GlassesToCloudMessageType.HEAD_POSITION,
  GlassesToCloudMessageType.GLASSES_BATTERY_UPDATE,
  GlassesToCloudMessageType.PHONE_BATTERY_UPDATE,
  GlassesToCloudMessageType.GLASSES_CONNECTION_STATE,
  GlassesToCloudMessageType.LOCATION_UPDATE,
  GlassesToCloudMessageType.VAD,
  GlassesToCloudMessageType.PHONE_NOTIFICATION,
  GlassesToCloudMessageType.NOTIFICATION_DISMISSED,
  GlassesToCloudMessageType.CALENDAR_EVENT,
  GlassesToCloudMessageType.AUGMENTOS_SETTINGS_UPDATE_REQUEST,
  GlassesToCloudMessageType.CORE_STATUS_UPDATE
] as const;

/**
 * Response message types (subset of CloudToGlassesMessageType)
 */
export const ResponseTypes = [
  CloudToGlassesMessageType.CONNECTION_ACK,
  CloudToGlassesMessageType.CONNECTION_ERROR,
  CloudToGlassesMessageType.AUTH_ERROR
] as const;

/**
 * Update message types (subset of CloudToGlassesMessageType)
 */
export const UpdateTypes = [
  CloudToGlassesMessageType.DISPLAY_EVENT,
  CloudToGlassesMessageType.APP_STATE_CHANGE,
  CloudToGlassesMessageType.MICROPHONE_STATE_CHANGE,
  CloudToGlassesMessageType.PHOTO_REQUEST,
  CloudToGlassesMessageType.VIDEO_STREAM_REQUEST,
  CloudToGlassesMessageType.SETTINGS_UPDATE,
  CloudToGlassesMessageType.DASHBOARD_MODE_CHANGE,
  CloudToGlassesMessageType.DASHBOARD_ALWAYS_ON_CHANGE
] as const;

/**
 * Dashboard message types
 */
export const DashboardMessageTypes = [
  TpaToCloudMessageType.DASHBOARD_CONTENT_UPDATE,
  TpaToCloudMessageType.DASHBOARD_MODE_CHANGE,
  TpaToCloudMessageType.DASHBOARD_SYSTEM_UPDATE,
  CloudToTpaMessageType.DASHBOARD_MODE_CHANGED,
  CloudToTpaMessageType.DASHBOARD_ALWAYS_ON_CHANGED
] as const;