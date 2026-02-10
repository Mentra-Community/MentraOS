// src/message-types.ts

import { StreamType } from "./streams";

/**
 * Types of messages from glasses to cloud
 */
export enum GlassesToCloudMessageType {
  // Control actions
  CONNECTION_INIT = "connection_init",
  REQUEST_SETTINGS = "request_settings",

  START_APP = StreamType.START_APP,
  STOP_APP = StreamType.STOP_APP,

  DASHBOARD_STATE = "dashboard_state",
  OPEN_DASHBOARD = StreamType.OPEN_DASHBOARD,

  // Mentra Live
  PHOTO_RESPONSE = StreamType.PHOTO_RESPONSE,

  // Local Transcription
  LOCAL_TRANSCRIPTION = "local_transcription",

  // RTMP streaming
  RTMP_STREAM_STATUS = StreamType.RTMP_STREAM_STATUS,
  KEEP_ALIVE_ACK = "keep_alive_ack",

  BUTTON_PRESS = StreamType.BUTTON_PRESS,
  HEAD_POSITION = StreamType.HEAD_POSITION,
  TOUCH_EVENT = StreamType.TOUCH_EVENT,
  GLASSES_BATTERY_UPDATE = StreamType.GLASSES_BATTERY_UPDATE,
  PHONE_BATTERY_UPDATE = StreamType.PHONE_BATTERY_UPDATE,
  GLASSES_CONNECTION_STATE = StreamType.GLASSES_CONNECTION_STATE,
  LOCATION_UPDATE = StreamType.LOCATION_UPDATE,

  // TODO(isaiah): Remove VPS_COORDINATES once confirmed we don't use this system.
  VPS_COORDINATES = StreamType.VPS_COORDINATES,
  VAD = StreamType.VAD,

  // TODO(isaiah): Remove PHONE_NOTIFICATION, and PHONE_NOTIFICATION_DISMISSED after moving to REST request.
  PHONE_NOTIFICATION = StreamType.PHONE_NOTIFICATION,
  PHONE_NOTIFICATION_DISMISSED = StreamType.PHONE_NOTIFICATION_DISMISSED,

  // TODO(isaiah): Remove CALENDAR_EVENT after moving to REST request.
  CALENDAR_EVENT = StreamType.CALENDAR_EVENT,
  MENTRAOS_SETTINGS_UPDATE_REQUEST = StreamType.MENTRAOS_SETTINGS_UPDATE_REQUEST,

  // TODO(isaiah): Remove CORE_STATUS_UPDATE after moving to REST request.
  CORE_STATUS_UPDATE = StreamType.CORE_STATUS_UPDATE,

  PHOTO_TAKEN = StreamType.PHOTO_TAKEN,
  AUDIO_PLAY_RESPONSE = "audio_play_response",

  // RGB LED control
  RGB_LED_CONTROL_RESPONSE = "rgb_led_control_response",

  // LiveKit handshake
  LIVEKIT_INIT = "livekit_init",

  // UDP audio
  UDP_REGISTER = "udp_register",
  UDP_UNREGISTER = "udp_unregister",
}

/**
 * Types of messages from cloud to glasses
 */
export enum CloudToGlassesMessageType {
  // Responses
  CONNECTION_ACK = "connection_ack",
  CONNECTION_ERROR = "connection_error",
  AUTH_ERROR = "auth_error",

  // Updates
  DISPLAY_EVENT = "display_event",
  APP_STATE_CHANGE = "app_state_change",
  MICROPHONE_STATE_CHANGE = "microphone_state_change",
  SETTINGS_UPDATE = "settings_update",

  // Requests
  PHOTO_REQUEST = "photo_request",
  AUDIO_PLAY_REQUEST = "audio_play_request",
  AUDIO_STOP_REQUEST = "audio_stop_request",
  RGB_LED_CONTROL = "rgb_led_control",
  SHOW_WIFI_SETUP = "show_wifi_setup",

  // RTMP streaming
  START_RTMP_STREAM = "start_rtmp_stream",
  STOP_RTMP_STREAM = "stop_rtmp_stream",
  KEEP_RTMP_STREAM_ALIVE = "keep_rtmp_stream_alive",

  // Dashboard updates
  DASHBOARD_MODE_CHANGE = "dashboard_mode_change",
  DASHBOARD_ALWAYS_ON_CHANGE = "dashboard_always_on_change",

  // Location Service
  SET_LOCATION_TIER = "set_location_tier",
  REQUEST_SINGLE_LOCATION = "request_single_location",

  WEBSOCKET_ERROR = "websocket_error",

  // LiveKit info (URL, room, token)
  LIVEKIT_INFO = "livekit_info",

  // UDP audio
  UDP_PING_ACK = "udp_ping_ack",
}

/**
 * Types of messages from Apps to cloud
 */
export enum AppToCloudMessageType {
  // Commands
  CONNECTION_INIT = "tpa_connection_init",
  SUBSCRIPTION_UPDATE = "subscription_update",
  LOCATION_POLL_REQUEST = "location_poll_request",

  // Requests
  DISPLAY_REQUEST = "display_event",
  PHOTO_REQUEST = "photo_request",
  AUDIO_PLAY_REQUEST = "audio_play_request",
  AUDIO_STOP_REQUEST = "audio_stop_request",
  RGB_LED_CONTROL = "rgb_led_control",
  REQUEST_WIFI_SETUP = "request_wifi_setup",

  // RTMP streaming
  RTMP_STREAM_REQUEST = "rtmp_stream_request",
  RTMP_STREAM_STOP = "rtmp_stream_stop",

  // Managed RTMP streaming
  MANAGED_STREAM_REQUEST = "managed_stream_request",
  MANAGED_STREAM_STOP = "managed_stream_stop",

  // Stream status check (both managed and unmanaged)
  STREAM_STATUS_CHECK = "stream_status_check",

  // Dashboard requests
  DASHBOARD_CONTENT_UPDATE = "dashboard_content_update",
  DASHBOARD_MODE_CHANGE = "dashboard_mode_change",
  DASHBOARD_SYSTEM_UPDATE = "dashboard_system_update",

  // TODO(isaiah): Remove after confirming not in use.
  // App-to-App Communication
  APP_BROADCAST_MESSAGE = "app_broadcast_message",
  APP_DIRECT_MESSAGE = "app_direct_message",
  APP_USER_DISCOVERY = "app_user_discovery",
  APP_ROOM_JOIN = "app_room_join",
  APP_ROOM_LEAVE = "app_room_leave",

  // Session lifecycle
  OWNERSHIP_RELEASE = "ownership_release",
}

/**
 * Types of messages from cloud to Apps
 */
export enum CloudToAppMessageType {
  // Responses
  CONNECTION_ACK = "tpa_connection_ack",
  CONNECTION_ERROR = "tpa_connection_error",

  // Updates
  APP_STOPPED = "app_stopped",
  SETTINGS_UPDATE = "settings_update",
  CAPABILITIES_UPDATE = "capabilities_update",
  DEVICE_STATE_UPDATE = "device_state_update",

  // Dashboard updates
  DASHBOARD_MODE_CHANGED = "dashboard_mode_changed",
  DASHBOARD_ALWAYS_ON_CHANGED = "dashboard_always_on_changed",

  // Stream data
  DATA_STREAM = "data_stream",

  // Media responses
  PHOTO_RESPONSE = "photo_response",
  AUDIO_PLAY_RESPONSE = "audio_play_response",
  RGB_LED_CONTROL_RESPONSE = "rgb_led_control_response",
  RTMP_STREAM_STATUS = "rtmp_stream_status",
  MANAGED_STREAM_STATUS = "managed_stream_status",
  STREAM_STATUS_CHECK_RESPONSE = "stream_status_check_response",

  WEBSOCKET_ERROR = "websocket_error",

  // Permissions
  PERMISSION_ERROR = "permission_error",

  // General purpose messaging
  CUSTOM_MESSAGE = "custom_message",

  // TODO(isaiah): Remove after confirming not in use.
  // App-to-App Communication Responses
  APP_MESSAGE_RECEIVED = "app_message_received",
  APP_USER_JOINED = "app_user_joined",
  APP_USER_LEFT = "app_user_left",
  APP_ROOM_UPDATED = "app_room_updated",
  APP_DIRECT_MESSAGE_RESPONSE = "app_direct_message_response",
}

/**
 * Control action message types (subset of GlassesToCloudMessageType)
 */
export const ControlActionTypes = [
  GlassesToCloudMessageType.CONNECTION_INIT,
  GlassesToCloudMessageType.START_APP,
  GlassesToCloudMessageType.STOP_APP,
  GlassesToCloudMessageType.DASHBOARD_STATE,
  GlassesToCloudMessageType.OPEN_DASHBOARD,
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
  GlassesToCloudMessageType.VPS_COORDINATES,
  GlassesToCloudMessageType.VAD,
  GlassesToCloudMessageType.PHONE_NOTIFICATION,
  GlassesToCloudMessageType.PHONE_NOTIFICATION_DISMISSED,
  GlassesToCloudMessageType.CALENDAR_EVENT,
  GlassesToCloudMessageType.MENTRAOS_SETTINGS_UPDATE_REQUEST,
  GlassesToCloudMessageType.CORE_STATUS_UPDATE,
  GlassesToCloudMessageType.LOCAL_TRANSCRIPTION,
] as const;

/**
 * Response message types (subset of CloudToGlassesMessageType)
 */
export const ResponseTypes = [
  CloudToGlassesMessageType.CONNECTION_ACK,
  CloudToGlassesMessageType.CONNECTION_ERROR,
  CloudToGlassesMessageType.AUTH_ERROR,
] as const;

/**
 * Update message types (subset of CloudToGlassesMessageType)
 */
export const UpdateTypes = [
  CloudToGlassesMessageType.DISPLAY_EVENT,
  CloudToGlassesMessageType.APP_STATE_CHANGE,
  CloudToGlassesMessageType.MICROPHONE_STATE_CHANGE,
  CloudToGlassesMessageType.PHOTO_REQUEST,
  CloudToGlassesMessageType.AUDIO_PLAY_REQUEST,
  CloudToGlassesMessageType.AUDIO_STOP_REQUEST,
  CloudToGlassesMessageType.RGB_LED_CONTROL,
  CloudToGlassesMessageType.SETTINGS_UPDATE,
  CloudToGlassesMessageType.DASHBOARD_MODE_CHANGE,
  CloudToGlassesMessageType.DASHBOARD_ALWAYS_ON_CHANGE,
  CloudToGlassesMessageType.START_RTMP_STREAM,
  CloudToGlassesMessageType.STOP_RTMP_STREAM,
  CloudToGlassesMessageType.KEEP_RTMP_STREAM_ALIVE,
  CloudToGlassesMessageType.LIVEKIT_INFO,
] as const;

/**
 * Dashboard message types
 */
export const DashboardMessageTypes = [
  AppToCloudMessageType.DASHBOARD_CONTENT_UPDATE,
  AppToCloudMessageType.DASHBOARD_MODE_CHANGE,
  AppToCloudMessageType.DASHBOARD_SYSTEM_UPDATE,
  CloudToAppMessageType.DASHBOARD_MODE_CHANGED,
  CloudToAppMessageType.DASHBOARD_ALWAYS_ON_CHANGED,
] as const;
