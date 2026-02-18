package com.mentra.asg_client.service.utils;

/**
 * Constants used throughout the service package.
 * Centralizes all service-related constants for easy maintenance.
 */
public final class ServiceConstants {
    
    // Prevent instantiation
    private ServiceConstants() {}
    
    // ---------------------------------------------
    // Service Actions
    // ---------------------------------------------
    public static final String ACTION_START_CORE = "ACTION_START_CORE";
    public static final String ACTION_STOP_CORE = "ACTION_STOP_CORE";
    public static final String ACTION_START_FOREGROUND_SERVICE = "MY_ACTION_START_FOREGROUND_SERVICE";
    public static final String ACTION_STOP_FOREGROUND_SERVICE = "MY_ACTION_STOP_FOREGROUND_SERVICE";
    public static final String ACTION_RESTART_SERVICE = "com.mentra.asg_client.ACTION_RESTART_SERVICE";
    public static final String ACTION_RESTART_COMPLETE = "com.mentra.asg_client.ACTION_RESTART_COMPLETE";
    public static final String ACTION_RESTART_CAMERA = "com.mentra.asg_client.ACTION_RESTART_CAMERA";
    public static final String ACTION_START_OTA_UPDATER = "ACTION_START_OTA_UPDATER";
    
    // ---------------------------------------------
    // OTA Update Actions
    // ---------------------------------------------
    public static final String ACTION_DOWNLOAD_PROGRESS = "com.augmentos.otaupdater.ACTION_DOWNLOAD_PROGRESS";
    public static final String ACTION_INSTALLATION_PROGRESS = "com.augmentos.otaupdater.ACTION_INSTALLATION_PROGRESS";
    
    // ---------------------------------------------
    // Service Health Monitoring
    // ---------------------------------------------
    public static final String ACTION_HEARTBEAT = "com.mentra.asg_client.ACTION_HEARTBEAT";
    public static final String ACTION_HEARTBEAT_ACK = "com.mentra.asg_client.ACTION_HEARTBEAT_ACK";
    
    // ---------------------------------------------
    // Command Types
    // ---------------------------------------------
    public static final String COMMAND_PHONE_READY = "phone_ready";
    public static final String COMMAND_AUTH_TOKEN = "auth_token";
    public static final String COMMAND_TAKE_PHOTO = "take_photo";
    public static final String COMMAND_START_VIDEO_RECORDING = "start_video_recording";
    public static final String COMMAND_STOP_VIDEO_RECORDING = "stop_video_recording";
    public static final String COMMAND_GET_VIDEO_RECORDING_STATUS = "get_video_recording_status";
    public static final String COMMAND_START_RTMP_STREAM = "start_rtmp_stream";
    public static final String COMMAND_STOP_RTMP_STREAM = "stop_rtmp_stream";
    public static final String COMMAND_GET_RTMP_STATUS = "get_rtmp_status";
    public static final String COMMAND_KEEP_RTMP_STREAM_ALIVE = "keep_rtmp_stream_alive";
    public static final String COMMAND_SET_WIFI_CREDENTIALS = "set_wifi_credentials";
    public static final String COMMAND_REQUEST_WIFI_STATUS = "request_wifi_status";
    public static final String COMMAND_REQUEST_WIFI_SCAN = "request_wifi_scan";
    public static final String COMMAND_SET_HOTSPOT_STATE = "set_hotspot_state";
    public static final String COMMAND_PING = "ping";
    public static final String COMMAND_BATTERY_STATUS = "battery_status";
    public static final String COMMAND_REQUEST_VERSION = "request_version";
    public static final String COMMAND_OTA_UPDATE_RESPONSE = "ota_update_response";
    public static final String COMMAND_SET_PHOTO_MODE = "set_photo_mode";
    public static final String COMMAND_BUTTON_MODE_SETTING = "button_mode_setting";
    
    // ---------------------------------------------
    // Response Types
    // ---------------------------------------------
    public static final String RESPONSE_ACK = "ack";
    public static final String RESPONSE_TOKEN_STATUS = "token_status";
    public static final String RESPONSE_VIDEO_RECORDING_STATUS = "video_recording_status";
    public static final String RESPONSE_RTMP_STATUS = "rtmp_status";
    public static final String RESPONSE_WIFI_STATUS = "wifi_status";
    public static final String RESPONSE_WIFI_SCAN_RESULT = "wifi_scan_result";
    public static final String RESPONSE_PING = "pong";
    public static final String RESPONSE_GLASSES_READY = "glasses_ready";
    public static final String RESPONSE_DOWNLOAD_PROGRESS = "download_progress";
    public static final String RESPONSE_INSTALLATION_PROGRESS = "installation_progress";
    public static final String RESPONSE_BUTTON_PRESS = "button_press";
    public static final String RESPONSE_BATTERY_STATUS = "battery_status";
    public static final String RESPONSE_PHOTO_MODE_ACK = "photo_mode_ack";
    public static final String RESPONSE_SWIPE_REPORT = "swipe_report";
    public static final String RESPONSE_KEEP_ALIVE_ACK = "keep_alive_ack";
    
    // ---------------------------------------------
    // Media Types
    // ---------------------------------------------
    public static final int MEDIA_TYPE_PHOTO = 1;
    public static final int MEDIA_TYPE_VIDEO = 2;
    
    // ---------------------------------------------
    // Transfer Methods
    // ---------------------------------------------
    public static final String TRANSFER_METHOD_BLE = "ble";
    public static final String TRANSFER_METHOD_AUTO = "auto";
    public static final String TRANSFER_METHOD_DIRECT = "direct";
    
    // ---------------------------------------------
    // Photo Modes
    // ---------------------------------------------
    public static final String PHOTO_MODE_NORMAL = "normal";
    public static final String PHOTO_MODE_HDR = "hdr";
    public static final String PHOTO_MODE_NIGHT = "night";
    
    // ---------------------------------------------
    // Button Press Types
    // ---------------------------------------------
    public static final String BUTTON_PRESS_SHORT = "short";
    public static final String BUTTON_PRESS_LONG = "long";
    
    // ---------------------------------------------
    // Timeouts and Delays
    // ---------------------------------------------
    public static final long WIFI_STATE_DEBOUNCE_MS = 1000;
    public static final long GLASSES_READY_DELAY_MS = 3000;
    public static final long HEARTBEAT_INTERVAL_MS = 30000;
    
    // ---------------------------------------------
    // Default Values
    // ---------------------------------------------
    public static final String DEFAULT_APP_VERSION = "1.0.0";
    public static final String DEFAULT_BUILD_NUMBER = "1";
    public static final int DEFAULT_BATTERY_LEVEL = -1;
    public static final boolean DEFAULT_CHARGING_STATE = false;
    
    // ---------------------------------------------
    // Error Messages
    // ---------------------------------------------
    public static final String ERROR_SERVICE_UNAVAILABLE = "service_unavailable";
    public static final String ERROR_MISSING_REQUEST_ID = "missing_request_id";
    public static final String ERROR_MISSING_RTMP_URL = "missing_rtmp_url";
    public static final String ERROR_NO_WIFI_CONNECTION = "no_wifi_connection";
    public static final String ERROR_NOT_STREAMING = "not_streaming";
    public static final String ERROR_NOT_RECORDING = "not_recording";
    public static final String ERROR_ALREADY_RECORDING = "already_recording";
    public static final String ERROR_JSON_ERROR = "json_error";
    
    // ---------------------------------------------
    // Success Messages
    // ---------------------------------------------
    public static final String SUCCESS_RECORDING_STARTED = "recording_started";
    public static final String SUCCESS_RECORDING_STOPPED = "recording_stopped";
    public static final String SUCCESS_STREAMING_STARTED = "streaming_started";
    public static final String SUCCESS_STREAMING_STOPPED = "streaming_stopped";
    public static final String SUCCESS_PHOTO_CAPTURED = "photo_captured";
    public static final String SUCCESS_WIFI_CONNECTED = "wifi_connected";
    public static final String SUCCESS_WIFI_DISCONNECTED = "wifi_disconnected";
    
    // ---------------------------------------------
    // Status Messages
    // ---------------------------------------------
    public static final String STATUS_STARTING = "starting";
    public static final String STATUS_STOPPING = "stopping";
    public static final String STATUS_RUNNING = "running";
    public static final String STATUS_STOPPED = "stopped";
    public static final String STATUS_ERROR = "error";
    public static final String STATUS_SUCCESS = "success";
    public static final String STATUS_FAILED = "failed";
    
    // ---------------------------------------------
    // Configuration Keys
    // ---------------------------------------------
    public static final String CONFIG_CORE_TOKEN = "core_token";
    public static final String CONFIG_PHOTO_MODE = "photo_mode";
    public static final String CONFIG_BUTTON_MODE = "button_mode";
    public static final String CONFIG_WIFI_SSID = "wifi_ssid";
    public static final String CONFIG_WIFI_PASSWORD = "wifi_password";
    
    // ---------------------------------------------
    // Notification
    // ---------------------------------------------
    public static final String NOTIFICATION_CHANNEL_ID = "asg_client";
    public static final String NOTIFICATION_APP_NAME = "ASG Client";
    public static final String NOTIFICATION_DESCRIPTION = "Running in foreground";
    public static final int NOTIFICATION_DEFAULT_ID = 1001;
    
    // ---------------------------------------------
    // Web Server
    // ---------------------------------------------
    public static final int CAMERA_WEB_SERVER_PORT = 8089;
    public static final String CAMERA_WEB_SERVER_NAME = "CameraWebServer";
    
    // ---------------------------------------------
    // K900 Protocol
    // ---------------------------------------------
    public static final byte K900_START_MARKER_1 = 0x23; // #
    public static final byte K900_START_MARKER_2 = 0x23; // #
    public static final byte K900_END_MARKER_1 = 0x24;   // $
    public static final byte K900_END_MARKER_2 = 0x24;   // $
    public static final int K900_PAYLOAD_START = 5;
} 